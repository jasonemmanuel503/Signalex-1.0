import pytest
import pytest_asyncio
import asyncio
from httpx import AsyncClient, ASGITransport
import os
import sys

# Ensure po-gateway is in sys.path
gateway_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if gateway_dir not in sys.path:
    sys.path.insert(0, gateway_dir)

os.environ["PO_USE_FAKE_ADAPTER"] = "true"
os.environ["INTERNAL_API_TOKEN"] = "test_token_123"
os.environ["MAX_STAKE_HARD_CAP"] = "50.0"
os.environ["DATA_DIR"] = "/tmp/test_po_data"

from main import app, get_adapter, storage

HEADERS = {"X-Internal-Token": "test_token_123"}

@pytest_asyncio.fixture(autouse=True)
async def setup_test_env():
    # Clean test tables between runs and clean session.json
    import aiosqlite, main
    main.kill_switch_engaged = False
    sess_file = os.path.join(os.environ.get("DATA_DIR", "/tmp/test_po_data"), "session.json")
    if os.path.exists(sess_file):
        try:
            os.remove(sess_file)
        except Exception:
            pass
    await storage.init_db()
    async with aiosqlite.connect(storage.orders_db_path) as db:
        await db.execute("DELETE FROM po_orders")
        await db.commit()
    ad = get_adapter()
    if hasattr(ad, "simulate_network_up"):
        ad.simulate_network_up()
    if hasattr(ad, "simulate_auth_reject"):
        ad.simulate_auth_reject(False)
    await ad.connect()

    yield

    if hasattr(ad, "simulate_network_up"):
        ad.simulate_network_up()
    if hasattr(ad, "simulate_auth_reject"):
        ad.simulate_auth_reject(False)
    if os.path.exists(sess_file):
        try:
            os.remove(sess_file)
        except Exception:
            pass

@pytest.mark.asyncio
async def test_auth_protection():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # Request without token must be rejected 401
        res = await client.get("/health")
        assert res.status_code == 401

        # Request with wrong token must be rejected 401
        res = await client.get("/health", headers={"X-Internal-Token": "wrong"})
        assert res.status_code == 401

        # Request with correct token succeeds
        res = await client.get("/health", headers=HEADERS)
        assert res.status_code == 200
        data = res.json()
        assert data["status"] == "ok"
        assert data["connected"] is True
        assert data["session"] == "valid"

@pytest.mark.asyncio
async def test_assets_endpoint():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.get("/assets", headers=HEADERS)
        assert res.status_code == 200
        assets = res.json()
        assert len(assets) >= 5
        pairs = {a["pair"]: a for a in assets}
        assert "EURUSD" in pairs
        assert "AUDCAD_otc" in pairs
        assert pairs["AUDCAD_otc"]["is_otc"] is True
        assert pairs["EURUSD"]["is_otc"] is False
        assert pairs["EURUSD"]["payout_pct"] >= 80

@pytest.mark.asyncio
async def test_closed_candles_rule():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.get("/candles/EURUSD?n=10", headers=HEADERS)
        assert res.status_code == 200
        candles = res.json()
        assert len(candles) > 0
        import time
        now_bucket = (int(time.time()) // 60) * 60
        # EVERY returned candle MUST be strictly closed (prior to current running bucket)
        for c in candles:
            assert c["timestamp"] < now_bucket
            assert "open" in c and "close" in c and "high" in c and "low" in c

@pytest.mark.asyncio
async def test_order_guardrails_and_idempotency():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # 1. Invalid expiry rejected
        res = await client.post("/orders", json={
            "idempotency_key": "test_invalid_expiry",
            "pair": "EURUSD",
            "direction": "CALL",
            "stake": 10.0,
            "expiry_secs": 45,  # Invalid
        }, headers=HEADERS)
        assert res.status_code == 400

        # 2. Stake exceeding hard cap rejected
        res = await client.post("/orders", json={
            "idempotency_key": "test_too_high_stake",
            "pair": "EURUSD",
            "direction": "CALL",
            "stake": 100.0,  # Exceeds 50.0 cap
            "expiry_secs": 60,
        }, headers=HEADERS)
        assert res.status_code == 400
        assert "hard cap" in res.json()["detail"].lower()

        # 3. Valid order accepted
        res = await client.post("/orders", json={
            "idempotency_key": "unique_sig_001",
            "pair": "EURUSD",
            "direction": "CALL",
            "stake": 10.0,
            "expiry_secs": 60,
            "signal_price": 1.08500
        }, headers=HEADERS)
        assert res.status_code == 200
        data = res.json()
        assert data["status"] == "accepted"
        assert "deal_id" in data
        assert data["entry_price"] > 0
        assert data["payout_pct"] >= 80

        # 4. Duplicate idempotency key blocked
        res_dup = await client.post("/orders", json={
            "idempotency_key": "unique_sig_001",
            "pair": "EURUSD",
            "direction": "CALL",
            "stake": 10.0,
            "expiry_secs": 60,
        }, headers=HEADERS)
        assert res_dup.status_code == 200
        dup_data = res_dup.json()
        assert dup_data["status"] == "already_processed"

@pytest.mark.asyncio
async def test_kill_switch():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # Trigger kill
        kill_res = await client.post("/kill", headers=HEADERS)
        assert kill_res.status_code == 200
        assert kill_res.json()["kill_active"] is True

        # Subsequent orders must be rejected
        res = await client.post("/orders", json={
            "idempotency_key": "post_kill_order",
            "pair": "EURUSD",
            "direction": "CALL",
            "stake": 5.0,
            "expiry_secs": 60,
        }, headers=HEADERS)
        assert res.status_code == 400
        assert "kill switch is active" in res.json()["detail"].lower()

@pytest.mark.asyncio
async def test_health_rich_accounts():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.get("/health", headers=HEADERS)
        assert res.status_code == 200
        data = res.json()
        assert "accounts" in data
        assert "demo" in data["accounts"]
        assert data["accounts"]["demo"]["connected"] is True
        assert data["accounts"]["demo"]["session"] == "valid"
        assert "balance" in data["accounts"]["demo"]
        assert "real" in data["accounts"]
        assert data["accounts"]["real"]["status"] == "not_configured"

@pytest.mark.asyncio
async def test_demo_test_trade_lifecycle():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # 1. Test trade with account=real must be rejected 400
        res_real = await client.post("/test-trade", json={"account": "real"}, headers=HEADERS)
        assert res_real.status_code == 400
        assert "strictly demo-only" in res_real.json()["detail"]

        # 2. Test trade with default demo succeeds with 1.0 stake and 60s expiry
        res_demo = await client.post("/test-trade", json={}, headers=HEADERS)
        assert res_demo.status_code == 200
        data = res_demo.json()
        assert data["status"] == "accepted"
        assert data["account"] == "demo"
        assert data["stake"] == 1.0
        assert data["expiry_secs"] == 60
        assert "order_id" in data
        assert "lifecycle" in data
        assert data["lifecycle"]["sent"] is True
        assert data["lifecycle"]["confirmed"] is True
        assert data["lifecycle"]["open"] is True

@pytest.mark.asyncio
async def test_real_order_rejected_when_not_configured():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post("/orders", json={
            "idempotency_key": "real_unconfigured_001",
            "account": "real",
            "pair": "EURUSD",
            "direction": "CALL",
            "stake": 10.0,
            "expiry_secs": 60,
        }, headers=HEADERS)
        # Should be rejected because real account is not connected
        assert res.status_code in (502, 503, 400)


@pytest.mark.asyncio
async def test_disconnect_marks_session_disconnected():
    ad = get_adapter()
    ad.simulate_disconnect()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.get("/health", headers=HEADERS)
        assert res.status_code == 200
        data = res.json()
        assert data["connected"] is False
        assert data["session"] == "disconnected"
        assert data["balance"] is None


@pytest.mark.asyncio
async def test_stale_client_disconnect_ignored():
    from po_adapter import PocketOptionSDKAdapter, _AccountConnection

    adapter = PocketOptionSDKAdapter("sess_123", 1001)
    conn = _AccountConnection(name="demo", session="sess_123", uid=1001, is_demo=1)

    class FakeClient:
        def __init__(self):
            self.handlers = {}

            class OnNamespace:
                def __init__(self, parent):
                    self.parent = parent

                def connect(self, fn):
                    self.parent.handlers["connect"] = fn
                    return fn

                def success_auth(self, fn):
                    self.parent.handlers["success_auth"] = fn
                    return fn

                def disconnect(self, fn):
                    self.parent.handlers["disconnect"] = fn
                    return fn

                def balance_success_update(self, fn):
                    self.parent.handlers["balance_success_update"] = fn
                    return fn

            self.on = OnNamespace(self)

    client_a = FakeClient()
    client_b = FakeClient()

    # Build conn with client_a and setup connection events
    conn.client = client_a
    adapter._setup_connection_events(conn, is_primary_market_feed=False)

    disconnect_handler_a = client_a.handlers.get("disconnect")
    assert disconnect_handler_a is not None, "Real _setup_connection_events must register disconnect handler"

    # Replace conn.client with client_b
    conn.client = client_b
    conn.connected = True
    conn.session_status = "valid"
    conn.balance = 500.0

    # 1. Invoke captured client_A disconnect handler -> conn must be unchanged
    await disconnect_handler_a()
    assert conn.connected is True
    assert conn.session_status == "valid"
    assert conn.balance == 500.0

    # 2. Invoke handler when conn.client is client_A -> conn state DOES change
    conn.client = client_a
    await disconnect_handler_a()
    assert conn.connected is False
    assert conn.session_status == "disconnected"
    assert conn.balance is None


@pytest.mark.asyncio
async def test_three_auth_failures_expire_and_disconnect(monkeypatch):
    monkeypatch.setenv("PO_AUTH_FAIL_LIMIT", "3")
    monkeypatch.setenv("PO_BACKOFF_BASE", "0.01")
    monkeypatch.setenv("PO_BACKOFF_MAX", "0.05")

    ad = get_adapter()
    await ad.connect()
    ad.simulate_auth_reject(True)
    initial_disconnects = ad.disconnect_call_count

    for _ in range(3):
        await ad.check_watchdog()
        await asyncio.sleep(0.02)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.get("/health", headers=HEADERS)
        data = res.json()
        assert data["session"] == "expired"
        assert data["connected"] is False
        assert ad.disconnect_call_count >= initial_disconnects + 1

    await ad.check_watchdog()
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.get("/health", headers=HEADERS)
        assert res.json()["session"] == "expired"


@pytest.mark.asyncio
async def test_network_outage_never_expires(monkeypatch):
    monkeypatch.setenv("PO_BACKOFF_BASE", "0.01")
    monkeypatch.setenv("PO_BACKOFF_MAX", "0.02")

    ad = get_adapter()
    await ad.connect()
    ad.simulate_network_down()

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        for _ in range(20):
            await ad.check_watchdog()
            await asyncio.sleep(0.02)
            res = await client.get("/health", headers=HEADERS)
            assert res.json()["session"] == "disconnected"
            assert res.json()["session"] != "expired"

        ad.simulate_network_up()
        recovered = False
        for _ in range(20):
            await asyncio.sleep(0.025)
            await ad.check_watchdog()
            res = await client.get("/health", headers=HEADERS)
            if res.json()["session"] == "valid":
                recovered = True
                break

        assert recovered is True, "Watchdog must automatically recover connection to valid without manual action"
        res = await client.get("/health", headers=HEADERS)
        assert res.json()["session"] == "valid"
        assert res.json()["connected"] is True


@pytest.mark.asyncio
async def test_post_session_bad_credentials_not_persisted():
    ad = get_adapter()
    ad.simulate_auth_reject(True)
    sess_file = os.path.join(os.environ.get("DATA_DIR", "/tmp/test_po_data"), "session.json")
    if os.path.exists(sess_file):
        os.remove(sess_file)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post("/session", json={
            "session": "bad_session_token_12345",
            "uid": 999999
        }, headers=HEADERS)
        assert res.status_code == 200
        data = res.json()
        assert data["ok"] is False
        assert data["status"] != "valid"
        assert not os.path.exists(sess_file)


@pytest.mark.asyncio
async def test_post_session_good_credentials_persist():
    import json
    ad = get_adapter()
    ad.simulate_auth_reject(False)
    sess_file = os.path.join(os.environ.get("DATA_DIR", "/tmp/test_po_data"), "session.json")
    if os.path.exists(sess_file):
        os.remove(sess_file)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post("/session", json={
            "session": "good_session_token_12345",
            "uid": 888888
        }, headers=HEADERS)
        assert res.status_code == 200
        data = res.json()
        assert data["ok"] is True
        assert data["status"] == "valid"
        assert os.path.exists(sess_file)
        with open(sess_file, "r") as f:
            saved = json.load(f)
            assert saved["uid"] == 888888
            assert saved["session"] == "good_session_token_12345"


@pytest.mark.asyncio
async def test_env_fingerprint_precedence(monkeypatch, tmp_path):
    import main
    temp_data = str(tmp_path)
    monkeypatch.setattr(main, "DATA_DIR", temp_data)

    monkeypatch.setattr(main, "PO_SESSION", "env_session_A")
    monkeypatch.setattr(main, "PO_UID", 1001)

    main.persist_session_credentials("runtime_session_X", 9999)

    s_eff, u_eff = main.load_effective_credentials()
    assert s_eff == "runtime_session_X"
    assert u_eff == 9999

    monkeypatch.setattr(main, "PO_SESSION", "env_session_B")
    monkeypatch.setattr(main, "PO_UID", 2002)

    s_eff2, u_eff2 = main.load_effective_credentials()
    assert s_eff2 == "env_session_B"
    assert u_eff2 == 2002


@pytest.mark.asyncio
async def test_health_contract_after_disconnect():
    ad = get_adapter()
    ad.simulate_disconnect()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.get("/health", headers=HEADERS)
        assert res.status_code == 200
        data = res.json()
        assert data["status"] == "ok"
        assert data["session"] == "disconnected"
        assert data["connected"] is False
        assert data["balance"] is None
        assert "accounts" in data
        assert "demo" in data["accounts"]
        assert "real" in data["accounts"]


@pytest.mark.asyncio
async def test_event_tap_logs_unknown_once_and_chains_original(caplog):
    from po_adapter import PocketOptionSDKAdapter, _AccountConnection
    import logging

    conn = _AccountConnection(name="demo", session="s", uid=1, is_demo=1)
    calls = []

    class MockAsyncClient:
        def __init__(self):
            self.handlers = {"/": {"*": self._orig_handler}}

        async def _orig_handler(self, event, *args, **kwargs):
            calls.append(event)

        def on(self, event, handler):
            self.handlers["/"][event] = handler

    class MockClient:
        def __init__(self):
            self.sio = MockAsyncClient()

    mock_client = MockClient()
    conn.client = mock_client
    adapter = PocketOptionSDKAdapter(session="s", uid=1)
    adapter._install_event_tap(conn, mock_client)

    tap = mock_client.sio.handlers["/"]["*"]

    with caplog.at_level(logging.WARNING):
        for _ in range(1000):
            await tap("updateStream")

    assert len(calls) == 1000
    unknown_warnings = [r for r in caplog.records if "Discovered unknown broker event" in r.message]
    assert len(unknown_warnings) == 0

    caplog.clear()
    with caplog.at_level(logging.WARNING):
        for _ in range(3):
            await tap("FooBar")

    assert len(calls) == 1003
    foobar_warnings = [r for r in caplog.records if "Discovered unknown broker event: FooBar" in r.message]
    assert len(foobar_warnings) == 1


@pytest.mark.asyncio
async def test_concurrent_set_session_serialized():
    """G6: Two concurrent set_session calls run serially under the lock without interleaving."""
    from po_adapter import PocketOptionSDKAdapter
    adapter = PocketOptionSDKAdapter(session="init_sess", uid=100)

    order_log = []

    async def fake_reconnect_locked(conn):
        current_sess = conn.session
        order_log.append(f"start_{current_sess}")
        await asyncio.sleep(0.05)
        order_log.append(f"end_{current_sess}")
        conn.session_status = "valid"
        return True

    adapter._reconnect_locked = fake_reconnect_locked

    task1 = asyncio.create_task(adapter.set_session("sess_A", 101))
    task2 = asyncio.create_task(adapter.set_session("sess_B", 102))

    res1, res2 = await asyncio.gather(task1, task2)
    assert res1 is True and res2 is True
    # The two calls must run serially: start_X -> end_X -> start_Y -> end_Y
    assert len(order_log) == 4
    first_sess = order_log[0].replace("start_", "")
    assert order_log[1] == f"end_{first_sess}"
    second_sess = order_log[2].replace("start_", "")
    assert order_log[3] == f"end_{second_sess}"
    assert {first_sess, second_sess} == {"sess_A", "sess_B"}


@pytest.mark.asyncio
async def test_auth_reject_single_count_on_watchdog(monkeypatch):
    """G7: One reject event followed by check_watchdog with connected socket counts exactly 1 failure."""
    from po_adapter import PocketOptionSDKAdapter, _AccountConnection
    import time

    adapter = PocketOptionSDKAdapter(session="sess_test", uid=100)
    conn = _AccountConnection(name="demo", session="sess_test", uid=100, is_demo=1)
    adapter._demo_conn = conn

    class MockSio:
        def __init__(self):
            self.connected = True
            self.handlers = {"/": {}}

        def on(self, event, handler):
            self.handlers["/"][event] = handler

    class MockClient:
        def __init__(self):
            self.sio = MockSio()
            self.is_authorized = False

    client = MockClient()
    conn.client = client
    conn.session_status = "connecting"
    conn.connecting_since = time.time() - 30.0  # past auth timeout (15s)

    # Tap receives NotAuthorized reject
    adapter._install_event_tap(conn, client)
    tap = client.sio.handlers["/"]["*"]

    # Trigger tap with NotAuthorized
    await tap("NotAuthorized")
    assert conn.auth_fail_count == 1

    # Run check_watchdog while socket is still "connected"
    monkeypatch.setenv("PO_AUTH_TIMEOUT", "5")
    await adapter.check_watchdog()

    # Must still be exactly 1, not 2
    assert conn.auth_fail_count == 1, f"Expected 1 auth failure, got {conn.auth_fail_count}"


