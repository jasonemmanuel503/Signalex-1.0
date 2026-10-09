from __future__ import annotations
import os
import time
import random
import asyncio
import logging
from typing import Literal, Optional, List
from contextlib import asynccontextmanager

from fastapi import FastAPI, Header, HTTPException, Query, BackgroundTasks, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from dotenv import load_dotenv

# Load env
load_dotenv()

try:
    from .adapter_interface import PocketOptionAdapter
    from .fake_adapter import FakePocketOptionAdapter
    from .po_adapter import PocketOptionSDKAdapter
    from .storage import LocalStorage
except ImportError:
    from adapter_interface import PocketOptionAdapter
    from fake_adapter import FakePocketOptionAdapter
    from po_adapter import PocketOptionSDKAdapter
    from storage import LocalStorage

os.makedirs(os.getenv("DATA_DIR", "../data"), exist_ok=True)
_log_file = os.path.join(os.getenv("DATA_DIR", "../data"), "po-gateway.log")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(name)s | %(levelname)s | %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(_log_file)
    ]
)
logger = logging.getLogger("po_gateway")

# Environment Configurations
SIGNALEX_ENV = os.getenv("SIGNALEX_ENV", "development").lower()
INTERNAL_API_TOKEN = os.getenv("INTERNAL_API_TOKEN", "dev_internal_token_signalex_2026")

if SIGNALEX_ENV == "production":
    if not INTERNAL_API_TOKEN or INTERNAL_API_TOKEN == "dev_internal_token_signalex_2026":
        raise RuntimeError(
            "[SIGNALEX_ENV=production] Startup aborted: INTERNAL_API_TOKEN is missing, empty, or set to the default dev token."
        )
else:
    if not INTERNAL_API_TOKEN or INTERNAL_API_TOKEN == "dev_internal_token_signalex_2026":
        logger.warning(
            "[SECURITY WARNING] Running with default or unconfigured INTERNAL_API_TOKEN in non-production mode."
        )
USE_FAKE_ADAPTER = os.getenv("PO_USE_FAKE_ADAPTER", "false").lower() in ("true", "1", "yes")
PO_SESSION = os.getenv("PO_SESSION", "")
PO_UID = int(os.getenv("PO_UID", "0") or 0)
PO_REAL_SESSION = os.getenv("PO_REAL_SESSION", "")
PO_REAL_UID = int(os.getenv("PO_REAL_UID", "0") or 0)
PO_REGION = os.getenv("PO_REGION", "DEMO")
DATA_DIR = os.getenv("DATA_DIR", "../data")

MAX_STAKE_HARD_CAP = float(os.getenv("MAX_STAKE_HARD_CAP", "50.0"))
MIN_PAYOUT_PCT = int(os.getenv("MIN_PAYOUT_PCT", "80"))
MAX_CONCURRENT_ORDERS = int(os.getenv("MAX_CONCURRENT_ORDERS", "1"))

storage = LocalStorage(data_dir=DATA_DIR)
adapter: Optional[PocketOptionAdapter] = None
kill_switch_engaged = False

def get_adapter() -> PocketOptionAdapter:
    global adapter
    if adapter is None:
        has_real_config = bool(
            PO_REAL_SESSION and PO_REAL_SESSION.strip() and
            PO_REAL_UID and
            (PO_REAL_SESSION != PO_SESSION or PO_REAL_UID != PO_UID)
        )
        if USE_FAKE_ADAPTER:
            logger.info("Initializing FakePocketOptionAdapter for deterministic testing.")
            adapter = FakePocketOptionAdapter(
                real_configured=has_real_config
            )
        else:
            logger.info("Initializing PocketOptionSDKAdapter with real pocket-option SDK.")
            adapter = PocketOptionSDKAdapter(
                session=PO_SESSION,
                uid=PO_UID,
                real_session=PO_REAL_SESSION if has_real_config else None,
                real_uid=PO_REAL_UID if has_real_config else None,
                region_name=PO_REGION,
            )
    return adapter

DEFAULT_PAIRS = [
    "EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD",
    "EURUSD_otc", "GBPUSD_otc", "AUDCAD_otc", "USDJPY_otc", "NZDUSD_otc"
]

async def track_and_update_deal(deal_id: str, expiry_secs: int):
    """Background task to watch deal completion and record real broker outcome."""
    ad = get_adapter()
    try:
        res = await ad.track_order_result(deal_id=deal_id, expiry_secs=expiry_secs, timeout_secs=90)
        await storage.mark_order_result(
            deal_id=deal_id,
            result=res.status,
            exit_price=res.exit_price,
            profit=res.profit,
            result_source=res.result_source,
        )
        logger.info(f"Deal {deal_id} resolved: {res.status} | Profit: {res.profit} | Source: {res.result_source}")
    except Exception as e:
        logger.error(f"Error tracking deal {deal_id}: {e}")
        await storage.mark_order_result(
            deal_id=deal_id,
            result="UNCONFIRMED",
            exit_price=None,
            profit=0.0,
            result_source="unconfirmed",
        )

@asynccontextmanager
async def lifespan(app: FastAPI):
    global kill_switch_engaged
    await storage.init_db()
    ad = get_adapter()
    await ad.connect()
    await ad.subscribe(DEFAULT_PAIRS)

    # Reconcile any open orders from previous process
    unresolved = await storage.get_unresolved_open_orders()
    for o in unresolved:
        deal_id = o.get("deal_id")
        expiry = o.get("expiry_secs", 60)
        if deal_id:
            logger.info(f"Reconciling pending open order on startup: deal {deal_id}")
            asyncio.create_task(track_and_update_deal(deal_id, expiry))

    yield

    logger.info("Shutting down po-gateway...")
    if adapter:
        await adapter.disconnect()

app = FastAPI(title="SignaLex Pocket Option Gateway", version="1.0.0", lifespan=lifespan)

# Enforce no wildcard CORS - only allow local origins
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:3000", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

def verify_internal_token(x_internal_token: Optional[str] = Header(None)):
    if not x_internal_token or x_internal_token != INTERNAL_API_TOKEN:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing X-Internal-Token header"
        )

# ── Health Endpoint ──────────────────────────────────────────────────────────
@app.get("/health")
async def get_health(x_internal_token: Optional[str] = Header(None)):
    verify_internal_token(x_internal_token)
    ad = get_adapter()
    now = time.time()
    last_msg = ad.get_last_message_at("demo")
    age = max(0.0, now - last_msg) if last_msg > 0 else 999999.0
    accounts = await ad.get_accounts_status()

    return {
        "status": "ok",
        "connected": ad.is_connected("demo"),
        "session": ad.get_session_status("demo"),
        "last_message_age_secs": round(age, 2),
        "version": "0.4.0",
        "adapter": "fake" if USE_FAKE_ADAPTER else "sdk",
        "kill_active": kill_switch_engaged,
        "accounts": accounts,
    }

# ── Assets Endpoint ──────────────────────────────────────────────────────────
@app.get("/assets")
async def get_assets(x_internal_token: Optional[str] = Header(None)):
    verify_internal_token(x_internal_token)
    ad = get_adapter()
    assets = await ad.get_assets()
    return assets

# ── Candles Endpoint ─────────────────────────────────────────────────────────
@app.get("/candles/{pair}")
async def get_candles(
    pair: str,
    n: int = Query(default=100, ge=1, le=500),
    x_internal_token: Optional[str] = Header(None)
):
    verify_internal_token(x_internal_token)
    ad = get_adapter()
    # Fetch strictly closed 1-minute candles from adapter
    candles = await ad.get_candles(pair, n=n)
    # Update local SQLite cache in background
    if candles:
        asyncio.create_task(storage.save_candles_bulk(pair, candles))
    return candles

# ── Prices Endpoint ──────────────────────────────────────────────────────────
@app.get("/prices")
async def get_prices(x_internal_token: Optional[str] = Header(None)):
    verify_internal_token(x_internal_token)
    ad = get_adapter()
    assets = await ad.get_assets()
    pairs = [a.pair for a in assets if a.open] or DEFAULT_PAIRS

    prices = []
    for p in pairs:
        price_info = await ad.get_latest_price(p)
        if price_info:
            prices.append(price_info)
    return prices

# ── Balance Endpoint ─────────────────────────────────────────────────────────
@app.get("/balance")
async def get_balance(
    account: Literal["demo", "real"] = Query(default="demo"),
    x_internal_token: Optional[str] = Header(None)
):
    verify_internal_token(x_internal_token)
    ad = get_adapter()
    bal = await ad.get_balance(account)
    return {"account": account, "balance": bal}

# ── Orders Endpoint ──────────────────────────────────────────────────────────
VALID_EXPIRIES = {60, 120, 180, 300, 600, 900, 1800}

class PlaceOrderRequest(BaseModel):
    idempotency_key: str
    signal_id: Optional[str] = None
    account: Literal["demo", "real"] = "demo"
    pair: str
    direction: Literal["CALL", "PUT"]
    stake: float = Field(gt=0)
    expiry_secs: int
    signal_price: Optional[float] = None

@app.post("/orders")
async def place_order(
    req: PlaceOrderRequest,
    background_tasks: BackgroundTasks,
    x_internal_token: Optional[str] = Header(None)
):
    verify_internal_token(x_internal_token)
    global kill_switch_engaged
    ad = get_adapter()

    # 1. Kill switch check
    if kill_switch_engaged:
        raise HTTPException(status_code=400, detail="Kill switch is active. All order placement is blocked.")

    # 2. Expiry validation
    if req.expiry_secs not in VALID_EXPIRIES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid expiry_secs: {req.expiry_secs}. Must be one of {sorted(VALID_EXPIRIES)}"
        )

    # 3. Hard cap stake validation
    if req.stake > MAX_STAKE_HARD_CAP:
        raise HTTPException(
            status_code=400,
            detail=f"Stake {req.stake} exceeds gateway hard cap ({MAX_STAKE_HARD_CAP})"
        )

    # 4. Connection & Session validation
    if not ad.is_connected(req.account):
        raise HTTPException(status_code=503, detail=f"Pocket Option gateway is not connected on {req.account} account")
    if ad.get_session_status(req.account) != "valid":
        raise HTTPException(status_code=503, detail=f"Broker {req.account} session is {ad.get_session_status(req.account)}")

    # 5. Asset availability & Payout floor validation
    assets = await ad.get_assets()
    asset_meta = next((a for a in assets if a.pair == req.pair), None)
    if not asset_meta or not asset_meta.open:
        raise HTTPException(status_code=400, detail=f"Asset {req.pair} is closed or unavailable for trading")
    if asset_meta.payout_pct < MIN_PAYOUT_PCT:
        raise HTTPException(
            status_code=400,
            detail=f"Asset payout {asset_meta.payout_pct}% is below minimum required {MIN_PAYOUT_PCT}%"
        )

    # 6. Max concurrent orders validation
    active_count = await storage.get_active_orders_count()
    if active_count >= MAX_CONCURRENT_ORDERS:
        raise HTTPException(
            status_code=429,
            detail=f"Max concurrent orders reached ({active_count}/{MAX_CONCURRENT_ORDERS})"
        )

    # 7. Idempotency reservation in SQLite
    inserted = await storage.record_pending_order(
        idempotency_key=req.idempotency_key,
        account=req.account,
        pair=req.pair,
        direction=req.direction,
        stake=req.stake,
        expiry_secs=req.expiry_secs,
        payout_pct=asset_meta.payout_pct,
        signal_id=req.signal_id,
        signal_price=req.signal_price,
    )
    if not inserted:
        existing = await storage.get_order_by_idempotency_key(req.idempotency_key)
        return {
            "status": "already_processed",
            "message": "Order with this idempotency key already exists",
            "order": existing
        }

    # 8. Send to broker
    t0 = time.time()
    try:
        broker_res = await ad.place_order(
            pair=req.pair,
            direction=req.direction,
            stake=req.stake,
            expiry_secs=req.expiry_secs,
            account=req.account,
        )
    except Exception as e:
        err_msg = str(e)
        logger.error(f"Failed to place order {req.idempotency_key}: {err_msg}")
        await storage.mark_order_failed(req.idempotency_key, err_msg)
        raise HTTPException(status_code=502, detail=f"Broker rejected order: {err_msg}")

    latency_ms = int((time.time() - t0) * 1000)
    slippage = None
    if req.signal_price and broker_res.entry_price:
        slippage = round(broker_res.entry_price - req.signal_price, 6)

    # 9. Mark confirmed in ledger
    await storage.mark_order_confirmed(
        idempotency_key=req.idempotency_key,
        deal_id=broker_res.deal_id,
        entry_price=broker_res.entry_price,
        payout_pct=broker_res.payout_pct,
        latency_ms=latency_ms,
        slippage=slippage,
    )

    # 10. Background task to track deal closing
    background_tasks.add_task(track_and_update_deal, broker_res.deal_id, req.expiry_secs)

    return {
        "status": "accepted",
        "deal_id": broker_res.deal_id,
        "entry_price": broker_res.entry_price,
        "payout_pct": broker_res.payout_pct,
        "latency_ms": latency_ms,
        "slippage": slippage,
    }

# ── Demo Test Trade Endpoint ────────────────────────────────────────────────
class TestTradeRequest(BaseModel):
    pair: Optional[str] = "EURUSD"
    direction: Optional[Literal["CALL", "PUT"]] = "CALL"
    account: Optional[str] = "demo"
    idempotency_key: Optional[str] = None

@app.post("/test-trade")
async def execute_test_trade(
    background_tasks: BackgroundTasks,
    req: Optional[TestTradeRequest] = None,
    x_internal_token: Optional[str] = Header(None)
):
    verify_internal_token(x_internal_token)
    global kill_switch_engaged
    ad = get_adapter()

    # 1. Strictly reject any account other than "demo"
    req_account = (req.account if req and req.account else "demo").lower()
    if req_account != "demo":
        raise HTTPException(
            status_code=400,
            detail=f"Test trade is strictly demo-only. Rejected account: {req_account}"
        )

    # 2. Kill switch check
    if kill_switch_engaged:
        raise HTTPException(status_code=400, detail="Kill switch is active. All order placement is blocked.")

    # 3. Connection & Session validation on demo
    if not ad.is_connected("demo"):
        raise HTTPException(status_code=503, detail="Pocket Option gateway is not connected on demo account")
    if ad.get_session_status("demo") != "valid":
        raise HTTPException(status_code=503, detail=f"Broker demo session is {ad.get_session_status('demo')}")

    # 4. Parameters fixed for demo test trade
    stake = 1.0
    expiry_secs = 60
    if stake > MAX_STAKE_HARD_CAP:
        raise HTTPException(status_code=400, detail=f"Stake {stake} exceeds gateway hard cap ({MAX_STAKE_HARD_CAP})")

    # 5. Asset resolution: requested pair defaulting to EURUSD, falling back to first open asset with payout >= MIN_PAYOUT_PCT
    assets = await ad.get_assets()
    requested_pair = (req.pair if req and req.pair else "EURUSD").strip()
    target_asset = next((a for a in assets if a.pair == requested_pair and a.open and a.payout_pct >= MIN_PAYOUT_PCT), None)
    if not target_asset:
        target_asset = next((a for a in assets if a.open and a.payout_pct >= MIN_PAYOUT_PCT), None)

    if not target_asset:
        raise HTTPException(
            status_code=400,
            detail=f"No open asset with payout >= {MIN_PAYOUT_PCT}% available for test trade"
        )

    pair = target_asset.pair
    direction = (req.direction if req and req.direction else "CALL")

    # 6. Max concurrent orders validation
    active_count = await storage.get_active_orders_count()
    if active_count >= MAX_CONCURRENT_ORDERS:
        raise HTTPException(
            status_code=429,
            detail=f"Max concurrent orders reached ({active_count}/{MAX_CONCURRENT_ORDERS})"
        )

    # 7. Idempotency reservation
    idemp_key = (req.idempotency_key if req and req.idempotency_key else None) or f"test_trade_{int(time.time()*1000)}_{random.randint(100, 999)}"
    inserted = await storage.record_pending_order(
        idempotency_key=idemp_key,
        account="demo",
        pair=pair,
        direction=direction,
        stake=stake,
        expiry_secs=expiry_secs,
        payout_pct=target_asset.payout_pct,
        signal_id="TEST_TRADE",
    )
    if not inserted:
        existing = await storage.get_order_by_idempotency_key(idemp_key)
        return {
            "status": "already_processed",
            "order": existing
        }

    # 8. Send to broker
    t0 = time.time()
    try:
        broker_res = await ad.place_order(
            pair=pair,
            direction=direction,
            stake=stake,
            expiry_secs=expiry_secs,
            account="demo",
        )
    except Exception as e:
        err_msg = str(e)
        logger.error(f"Failed to place test trade {idemp_key}: {err_msg}")
        await storage.mark_order_failed(idemp_key, err_msg)
        raise HTTPException(status_code=502, detail=f"Broker rejected test trade: {err_msg}")

    latency_ms = int((time.time() - t0) * 1000)

    # 9. Mark confirmed in ledger
    await storage.mark_order_confirmed(
        idempotency_key=idemp_key,
        deal_id=broker_res.deal_id,
        entry_price=broker_res.entry_price,
        payout_pct=broker_res.payout_pct,
        latency_ms=latency_ms,
        slippage=0.0,
    )

    # 10. Background task to track deal closing
    background_tasks.add_task(track_and_update_deal, broker_res.deal_id, expiry_secs)

    return {
        "status": "accepted",
        "order_id": broker_res.deal_id,
        "deal_id": broker_res.deal_id,
        "pair": pair,
        "account": "demo",
        "direction": direction,
        "stake": stake,
        "expiry_secs": expiry_secs,
        "entry_price": broker_res.entry_price,
        "payout_pct": broker_res.payout_pct,
        "latency_ms": latency_ms,
        "slippage": 0.0,
        "lifecycle": {
            "sent": True,
            "confirmed": True,
            "open": True,
            "closed": False,
        }
    }

# ── Order Status Endpoint ────────────────────────────────────────────────────
@app.get("/orders/{order_id}")
async def get_order(order_id: str, x_internal_token: Optional[str] = Header(None)):
    verify_internal_token(x_internal_token)
    # Check by idempotency_key first, then deal_id
    order = await storage.get_order_by_idempotency_key(order_id)
    if not order:
        order = await storage.get_order_by_deal_id(order_id)
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    return order

# ── Kill Switch Endpoint ─────────────────────────────────────────────────────
@app.post("/kill")
async def trigger_kill(x_internal_token: Optional[str] = Header(None)):
    verify_internal_token(x_internal_token)
    global kill_switch_engaged
    kill_switch_engaged = True
    logger.warning("KILL SWITCH ACTIVATED: gateway will reject all subsequent order requests.")
    return {"status": "killed", "kill_active": True}
