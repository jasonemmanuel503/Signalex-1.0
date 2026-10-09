from __future__ import annotations
import asyncio
import os
import time
import math
import logging
from typing import Literal, Optional, List, Dict

try:
    from .adapter_interface import (
        PocketOptionAdapter,
        AssetMetadata,
        CandleData,
        PriceUpdate,
        OrderResult,
    )
except ImportError:
    from adapter_interface import (
        PocketOptionAdapter,
        AssetMetadata,
        CandleData,
        PriceUpdate,
        OrderResult,
    )

logger = logging.getLogger("po_gateway.adapter")

KNOWN_EVENTS = {
    "successauth",
    "updateStream",
    "updateAssets",
    "successupdateBalance",
    "updateHistoryNewFast",
    "loadHistoryPeriodFast",
    "failopenOrder",
    "successopenOrder",
    "successcloseOrder",
    "updateClosedDeals",
    "updateOpenedDeals",
    "chafor",
    "successprice-alert/add",
}
_seen_unknown_events: set[str] = set()


def _get_auth_reject_events() -> set[str]:
    raw = os.getenv("PO_AUTH_REJECT_EVENTS", "NotAuthorized")
    return {e.strip() for e in raw.split(",") if e.strip()}


class _AccountConnection:
    def __init__(self, name: Literal["demo", "real"], session: str, uid: int, is_demo: int):
        self.name = name
        self.session = session
        self.uid = uid
        self.is_demo = is_demo
        self.connected = False
        self.session_status: Literal["missing", "connecting", "valid", "disconnected", "expired", "unknown"] = "unknown"
        self.last_message_at = 0.0
        self.balance: Optional[float] = None
        self.client = None
        self.deals_storage = None
        self.candle_storage = None
        self.assets_storage = None
        self.auth_fail_count: int = 0
        self.net_fail_count: int = 0
        self.next_attempt_at: float = 0.0
        self.generation: int = 0
        self.connecting_since: float = 0.0
        self.attempt_failed: bool = False
        self.reconnect_lock = asyncio.Lock()
        self._last_net_warn_at = 0.0


class PocketOptionSDKAdapter(PocketOptionAdapter):
    """
    Real adapter wrapping the pocket-option (0.4.0) SDK.
    Maintains separate demo and real broker connections,
    streams candles/assets on demo, and executes orders according to account.
    """
    def __init__(
        self,
        session: str,
        uid: int,
        real_session: Optional[str] = None,
        real_uid: Optional[int] = None,
        region_name: str = "DEMO",
    ):
        self.session = session or ""
        self.uid = int(uid or 0)
        self.real_session = (real_session or "").strip()
        self.real_uid = int(real_uid or 0)
        self.region_name = region_name

        self._demo_conn = _AccountConnection(
            name="demo",
            session=self.session,
            uid=self.uid,
            is_demo=1,
        )
        if not self.session or not self.uid:
            self._demo_conn.session_status = "missing"

        # Real connection created ONLY if both real variables are non-empty and distinct
        has_real = bool(
            self.real_session and
            self.real_uid and
            (self.real_session != self.session or self.real_uid != self.uid)
        )
        if has_real:
            self._real_conn = _AccountConnection(
                name="real",
                session=self.real_session,
                uid=self.real_uid,
                is_demo=0,
            )
        else:
            self._real_conn = None

        self._subscribed_pairs: set[str] = set()
        self._running = False

    def _get_region(self):
        from pocket_option.constants import Regions
        region_map = {
            "DEMO": Regions.DEMO,
            "DEMO_2": Regions.DEMO_2,
            "EUROPA": Regions.EUROPA,
            "ASIA": Regions.ASIA,
            "UNITED_STATES_NORTH": Regions.UNITED_STATES_NORTH,
            "UNITED_STATES_SOUTH": Regions.UNITED_STATES_SOUTH,
        }
        return region_map.get(self.region_name.upper(), Regions.DEMO)

    def _get_asset_enum(self, pair: str):
        from pocket_option.models import Asset
        clean = pair.strip()
        try:
            return Asset(clean)
        except ValueError:
            if hasattr(Asset, clean):
                return getattr(Asset, clean)
            return None

    def _install_event_tap(self, conn: _AccountConnection, client):
        if not client or not hasattr(client, "sio") or client.sio is None:
            return

        sio = client.sio
        handlers = getattr(sio, "handlers", {})
        ns_handlers = handlers.get("/", {})
        orig_handler = ns_handlers.get("*")
        if getattr(orig_handler, "_is_signalex_tap", False):
            return

        auth_reject_events = _get_auth_reject_events()

        async def tap_wrapper(event, *args, **kwargs):
            if conn.client is not client:
                return

            conn.last_message_at = time.time()
            event_str = str(event)

            if event_str in auth_reject_events:
                logger.warning(f"PocketOption {conn.name} received auth reject event: {event_str}")
                if not conn.attempt_failed:
                    conn.attempt_failed = True
                    conn.auth_fail_count += 1
                conn.connecting_since = 0.0
                conn.connected = False
                conn.session_status = "disconnected"
                conn.balance = None

            if event_str not in KNOWN_EVENTS:
                global _seen_unknown_events
                if event_str not in _seen_unknown_events:
                    if len(_seen_unknown_events) < 200:
                        _seen_unknown_events.add(event_str)
                    truncated = event_str[:64]
                    logger.warning(f"Discovered unknown broker event: {truncated}")

            if orig_handler:
                if asyncio.iscoroutinefunction(orig_handler):
                    return await orig_handler(event, *args, **kwargs)
                else:
                    return orig_handler(event, *args, **kwargs)

        tap_wrapper._is_signalex_tap = True
        sio.on("*", tap_wrapper)

    def _setup_connection_events(self, conn: _AccountConnection, is_primary_market_feed: bool = False):
        from pocket_option.models import AuthorizationData, SuccessUpdateBalanceEvent

        client = conn.client

        @client.on.connect
        async def on_connect():
            if conn.client is not client:
                return
            logger.info(f"PocketOption {conn.name} WebSocket connected. Sending auth...")
            conn.connected = True
            conn.session_status = "connecting"
            conn.last_message_at = time.time()
            auth_data = AuthorizationData.model_validate({
                "session": conn.session,
                "isDemo": conn.is_demo,
                "uid": int(conn.uid),
                "platform": 2,
                "isFastHistory": True,
                "isOptimized": True,
            })
            try:
                await client.send("auth", auth_data)
            except Exception as e:
                logger.error(f"Failed to send auth for {conn.name}: {e}")

        @client.on.success_auth
        async def on_success_auth(event):
            if conn.client is not client:
                return
            logger.info(f"PocketOption {conn.name} auth successful.")
            conn.session_status = "valid"
            conn.auth_fail_count = 0
            conn.net_fail_count = 0
            conn.connecting_since = 0.0
            conn.last_message_at = time.time()
            try:
                await client.emit.update_balance()
            except Exception as e:
                logger.debug(f"Balance update request for {conn.name}: {e}")

            if is_primary_market_feed and self._subscribed_pairs:
                await self.subscribe(list(self._subscribed_pairs))

        @client.on.disconnect
        async def on_disconnect():
            if conn.client is not client:
                return
            logger.warning(f"PocketOption {conn.name} WebSocket disconnected.")
            conn.connected = False
            if conn.session_status not in ("expired", "missing"):
                conn.session_status = "disconnected"
            conn.balance = None
            conn.last_message_at = time.time()

        @client.on.balance_success_update
        async def on_balance_update(event: SuccessUpdateBalanceEvent):
            if conn.client is not client:
                return
            conn.last_message_at = time.time()
            conn.balance = float(event.balance)

        if is_primary_market_feed:
            @client.on.update_close_value
            async def on_update_close(items):
                if conn.client is not client:
                    return
                conn.last_message_at = time.time()

    async def _reconnect_locked(self, conn: _AccountConnection) -> bool:
        login_wait = float(os.getenv("PO_LOGIN_WAIT", "15"))
        from pocket_option import PocketOptionClient
        from pocket_option.contrib.candles import MemoryCandleStorage
        from pocket_option.contrib.assets import MemoryAssetsStorage
        from pocket_option.contrib.deals import MemoryDealsStorage

        conn.generation += 1
        conn.attempt_failed = False
        conn.connecting_since = time.time()
        conn.session_status = "connecting"
        conn.balance = None

        if conn.client:
            try:
                await conn.client.disconnect()
            except Exception as e:
                logger.debug(f"Error disconnecting old client for {conn.name}: {e}")

        conn.client = PocketOptionClient(logger=False, reconnection=False)
        is_primary = (conn.name == "demo")
        if is_primary:
            conn.candle_storage = MemoryCandleStorage(conn.client)
            conn.assets_storage = MemoryAssetsStorage(conn.client)
        conn.deals_storage = MemoryDealsStorage(conn.client)

        self._setup_connection_events(conn, is_primary_market_feed=is_primary)
        self._install_event_tap(conn, conn.client)

        region = self._get_region()
        try:
            await conn.client.connect(region)
            self._install_event_tap(conn, conn.client)
        except Exception as e:
            logger.warning(f"Connect failed for {conn.name}: {e}")
            conn.connected = False
            conn.session_status = "disconnected"
            conn.net_fail_count += 1
            return False

        wait_steps = int(login_wait * 10)
        for _ in range(wait_steps):
            if conn.session_status == "valid":
                return True
            if conn.session_status == "expired":
                return False
            await asyncio.sleep(0.1)

        return conn.session_status == "valid"

    async def reconnect_session(self, conn: _AccountConnection) -> bool:
        async with conn.reconnect_lock:
            return await self._reconnect_locked(conn)

    async def connect(self) -> None:
        self._running = True

        if not self._demo_conn.session or not self._demo_conn.uid:
            self._demo_conn.session_status = "missing"
            logger.warning("PO_SESSION or PO_UID not provided. Demo session marked as missing.")
        else:
            await self.reconnect_session(self._demo_conn)

        if self._real_conn is not None:
            if not self._real_conn.session or not self._real_conn.uid:
                self._real_conn.session_status = "missing"
            else:
                await self.reconnect_session(self._real_conn)

    async def disconnect(self) -> None:
        self._running = False
        if self._demo_conn and self._demo_conn.client:
            try:
                await self._demo_conn.client.disconnect()
            except Exception as e:
                logger.debug(f"Error during demo disconnect: {e}")
            self._demo_conn.connected = False
            self._demo_conn.session_status = "disconnected" if self._demo_conn.session_status != "expired" else "expired"
            self._demo_conn.balance = None

        if self._real_conn and self._real_conn.client:
            try:
                await self._real_conn.client.disconnect()
            except Exception as e:
                logger.debug(f"Error during real disconnect: {e}")
            self._real_conn.connected = False
            self._real_conn.session_status = "disconnected" if self._real_conn.session_status != "expired" else "expired"
            self._real_conn.balance = None

    async def check_watchdog(self) -> None:
        backoff_base = float(os.getenv("PO_BACKOFF_BASE", "10"))
        backoff_max = float(os.getenv("PO_BACKOFF_MAX", "60"))
        login_wait = float(os.getenv("PO_LOGIN_WAIT", "15"))
        auth_timeout = float(os.getenv("PO_AUTH_TIMEOUT", "15"))
        auth_fail_limit = int(os.getenv("PO_AUTH_FAIL_LIMIT", "3"))

        conns = [self._demo_conn]
        if self._real_conn:
            conns.append(self._real_conn)

        now = time.time()
        for conn in conns:
            if conn.session_status in ("expired", "missing"):
                continue

            client = conn.client
            sio = getattr(client, "sio", None) if client else None
            sio_connected = getattr(sio, "connected", False) if sio else False
            is_authorized = getattr(client, "is_authorized", False) if client else False

            if conn.session_status == "valid" and is_authorized and sio_connected:
                continue

            if conn.session_status == "connecting":
                if conn.connecting_since > 0 and (now - conn.connecting_since) > (login_wait + 5):
                    if not conn.attempt_failed:
                        conn.attempt_failed = True
                        if sio_connected:
                            conn.auth_fail_count += 1
                        else:
                            conn.net_fail_count += 1
                    conn.connecting_since = 0.0
                    conn.connected = False
                    conn.session_status = "disconnected"
                    conn.balance = None
                else:
                    continue

            if sio_connected and not is_authorized:
                if conn.connecting_since > 0 and (now - conn.connecting_since) > auth_timeout:
                    if not conn.attempt_failed:
                        conn.attempt_failed = True
                        conn.auth_fail_count += 1
                    conn.connecting_since = 0.0
                    conn.connected = False
                    conn.session_status = "disconnected"
                    conn.balance = None

            if conn.auth_fail_count >= auth_fail_limit:
                conn.session_status = "expired"
                conn.connected = False
                conn.balance = None
                if client:
                    try:
                        await client.disconnect()
                    except Exception:
                        pass
                logger.warning(f"PocketOption {conn.name} session expired after {conn.auth_fail_count} auth failures.")
                continue

            if now < conn.next_attempt_at:
                continue

            n = conn.net_fail_count + conn.auth_fail_count
            backoff = min(backoff_base * (2 ** max(0, n - 1)), backoff_max)
            conn.next_attempt_at = now + backoff

            if conn.net_fail_count > 0:
                if now - getattr(conn, "_last_net_warn_at", 0.0) >= 300:
                    logger.warning(f"PocketOption {conn.name} network outage ongoing ({conn.net_fail_count} failures). Next retry in {backoff:.1f}s.")
                    conn._last_net_warn_at = now

            await self.reconnect_session(conn)

    async def set_session(self, session: str, uid: int) -> bool:
        async with self._demo_conn.reconnect_lock:
            self._demo_conn.session = session
            self._demo_conn.uid = uid
            self._demo_conn.auth_fail_count = 0
            self._demo_conn.net_fail_count = 0
            self._demo_conn.next_attempt_at = 0.0
            self._demo_conn.session_status = "connecting"
            self._demo_conn.balance = None
            return await self._reconnect_locked(self._demo_conn)

    def is_connected(self, account: Literal["demo", "real"] = "demo") -> bool:
        if account == "real":
            return bool(self._real_conn and self._real_conn.connected)
        return self._demo_conn.connected

    def get_session_status(self, account: Literal["demo", "real"] = "demo") -> Literal["missing", "connecting", "valid", "disconnected", "expired", "unknown"]:
        if account == "real":
            return self._real_conn.session_status if self._real_conn else "missing"
        return self._demo_conn.session_status

    def get_last_message_at(self, account: Literal["demo", "real"] = "demo") -> float:
        if account == "real":
            return self._real_conn.last_message_at if self._real_conn else 0.0
        return self._demo_conn.last_message_at

    async def get_balance(self, account: Literal["demo", "real"]) -> Optional[float]:
        if account == "real":
            if self._real_conn is None:
                raise RuntimeError("Real account is not configured")
            if not self._real_conn.connected or self._real_conn.session_status != "valid" or self._real_conn.balance is None:
                return None
            if self._real_conn.client and self._real_conn.connected:
                try:
                    await self._real_conn.client.emit.update_balance()
                except Exception:
                    pass
            return self._real_conn.balance
        else:
            if not self._demo_conn.connected or self._demo_conn.session_status != "valid" or self._demo_conn.balance is None:
                return None
            if self._demo_conn.client and self._demo_conn.connected:
                try:
                    await self._demo_conn.client.emit.update_balance()
                except Exception:
                    pass
            return self._demo_conn.balance

    async def get_accounts_status(self) -> dict:
        demo_status = {
            "connected": self.is_connected("demo"),
            "session": self.get_session_status("demo"),
            "balance": await self.get_balance("demo"),
        }
        if self._real_conn is None:
            real_status = {"status": "not_configured"}
        else:
            real_status = {
                "connected": self.is_connected("real"),
                "session": self.get_session_status("real"),
                "balance": await self.get_balance("real"),
            }
        return {
            "demo": demo_status,
            "real": real_status,
        }

    async def subscribe(self, pairs: list[str]) -> None:
        if not self._demo_conn or not self._demo_conn.client or not self._demo_conn.connected:
            self._subscribed_pairs.update(pairs)
            return

        for p in pairs:
            self._subscribed_pairs.add(p)
            asset_enum = self._get_asset_enum(p)
            if asset_enum:
                try:
                    await self._demo_conn.client.emit.subscribe_to_asset(asset_enum)
                except Exception as e:
                    logger.debug(f"Subscribe error for {p}: {e}")

    async def get_candles(self, pair: str, n: int = 100) -> list[CandleData]:
        if not self._demo_conn or not self._demo_conn.candle_storage:
            return []

        asset_enum = self._get_asset_enum(pair)
        if not asset_enum:
            return []

        try:
            candles = await self._demo_conn.candle_storage.get_candles(asset_enum, timeframe=60, count=n + 5)
        except Exception as e:
            logger.error(f"Error getting candles for {pair}: {e}")
            return []

        now_bucket = (int(time.time()) // 60) * 60
        closed_candles: list[CandleData] = []

        for c in candles:
            ts = int(c.timestamp.timestamp())
            if ts < now_bucket:
                closed_candles.append(CandleData(
                    timestamp=ts,
                    open=c.open,
                    high=c.high,
                    low=c.low,
                    close=c.close,
                    is_closed=True,
                ))

        closed_candles.sort(key=lambda x: x.timestamp)
        return closed_candles[-n:]

    async def get_latest_price(self, pair: str) -> Optional[PriceUpdate]:
        candles = await self.get_candles(pair, n=1)
        if not candles:
            return None
        latest = candles[-1]
        age = time.time() - (latest.timestamp + 60)
        return PriceUpdate(
            pair=pair,
            price=latest.close,
            timestamp=latest.timestamp + 60,
            age_seconds=max(0.0, age),
        )

    async def get_assets(self) -> list[AssetMetadata]:
        if not self._demo_conn or not self._demo_conn.assets_storage:
            return []

        try:
            items = await self._demo_conn.assets_storage.get_assets()
        except Exception as e:
            logger.error(f"Error retrieving assets from storage: {e}")
            return []

        result = []
        for it in items:
            pair_name = it.asset.value if hasattr(it.asset, "value") else str(it.asset)
            result.append(AssetMetadata(
                pair=pair_name,
                asset_id=it.id,
                label=it.label,
                is_otc=bool(it.is_otc),
                open=bool(it.active),
                payout_pct=int(it.payout),
                min_expiration=int(it.min_expiration or 60),
                default_expiration=int(it.default_expiration or 60),
                digits=int(it.digits or 5),
            ))
        return result

    async def place_order(
        self,
        pair: str,
        direction: Literal["CALL", "PUT"],
        stake: float,
        expiry_secs: int,
        account: Literal["demo", "real"] = "demo",
    ) -> OrderResult:
        if account.lower() == "real":
            if self._real_conn is None:
                raise RuntimeError("Real account is not configured")
            if not self._real_conn.connected or not self._real_conn.client:
                raise RuntimeError("PocketOption real account client is not connected")
            if self._real_conn.session_status != "valid":
                raise RuntimeError(f"PocketOption real session is not valid ({self._real_conn.session_status})")
            active_conn = self._real_conn
        else:
            if not self._demo_conn.connected or not self._demo_conn.client:
                raise RuntimeError("PocketOption demo account client is not connected")
            if self._demo_conn.session_status != "valid":
                raise RuntimeError(f"PocketOption demo session is not valid ({self._demo_conn.session_status})")
            active_conn = self._demo_conn

        from pocket_option.models import DealAction
        asset_enum = self._get_asset_enum(pair)
        if not asset_enum:
            raise ValueError(f"Unknown asset identifier: {pair}")

        deal_action = DealAction.CALL if direction.upper() == "CALL" else DealAction.PUT

        sent_time = int(time.time())
        try:
            deal = await active_conn.deals_storage.open_deal(
                asset=asset_enum,
                amount=stake,
                action=deal_action,
                time=expiry_secs,
                is_demo=active_conn.is_demo,
                option_type=100,
                check_limits=True,
            )
        except Exception as e:
            logger.error(f"Broker rejected deal on {active_conn.name}: {e}")
            raise RuntimeError(f"Broker order rejection on {active_conn.name}: {e}")

        assets = await self.get_assets()
        asset_meta = next((a for a in assets if a.pair == pair), None)
        payout_pct = asset_meta.payout_pct if asset_meta else 85

        return OrderResult(
            deal_id=str(deal.id),
            pair=pair,
            account=account,
            direction=direction,
            stake=stake,
            payout_pct=payout_pct,
            entry_price=float(deal.open_price or 0.0),
            open_time=sent_time,
            status="OPEN",
            result_source="broker",
            raw_response=deal.model_dump() if hasattr(deal, "model_dump") else None,
        )

    async def track_order_result(
        self,
        deal_id: str,
        expiry_secs: int,
        timeout_secs: int = 90,
    ) -> OrderResult:
        deals_storage = None
        if self._demo_conn and self._demo_conn.deals_storage:
            deals_storage = self._demo_conn.deals_storage
        elif self._real_conn and self._real_conn.deals_storage:
            deals_storage = self._real_conn.deals_storage

        if not deals_storage:
            raise RuntimeError("Deals storage not initialized")

        total_wait = expiry_secs + timeout_secs
        try:
            closed_deal = await deals_storage.check_deal_result(
                deal_id=deal_id,
                wait_time=total_wait,
            )
        except Exception as e:
            logger.warning(f"Could not read broker result for deal {deal_id} within timeout: {e}")
            return OrderResult(
                deal_id=deal_id,
                pair="",
                account="demo",
                direction="CALL",
                stake=0.0,
                payout_pct=0,
                entry_price=0.0,
                open_time=0,
                status="UNCONFIRMED",
                result_source="unconfirmed",
            )

        profit = float(closed_deal.profit or 0.0)
        open_price = float(closed_deal.open_price or 0.0)
        close_price = float(closed_deal.close_price or 0.0)

        if closed_deal.refund_time or profit == 0.0:
            status = "TIE"
        elif profit > 0.0:
            status = "WIN"
        else:
            status = "LOSS"

        direction_str = "CALL" if closed_deal.command == 0 else "PUT"
        account_str = "demo" if closed_deal.is_demo == 1 else "real"
        pair_val = closed_deal.asset.value if hasattr(closed_deal.asset, "value") else str(closed_deal.asset)

        return OrderResult(
            deal_id=str(closed_deal.id),
            pair=pair_val,
            account=account_str,
            direction=direction_str,
            stake=float(closed_deal.amount),
            payout_pct=int(closed_deal.percent_profit or 0),
            entry_price=open_price,
            exit_price=close_price,
            open_time=int(closed_deal.open_timestamp or 0),
            close_time=int(closed_deal.close_timestamp or 0),
            status=status,
            profit=profit,
            result_source="broker",
        )
