"""
SIGNALEX V10 — Deriv Data Client
Maintains a resilient connection to Deriv WebSocket API,
backfills historical 1-minute candles, stores them in SQLite (data/candles.db),
and provides ONLY fully closed candles.
"""

import asyncio
import json
import logging
import os
import threading
import time
from datetime import datetime, timezone
from typing import Dict, List, Optional, Any, Tuple

from candle_store import save_candles, get_candles, get_latest_epoch

logger = logging.getLogger("signalex.deriv")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")

# Default Deriv endpoints (fallback list)
DEFAULT_WS_URL = os.getenv("DERIV_WS_URL", "wss://red.derivws.com/websockets/v3")
DEFAULT_APP_ID = os.getenv("DERIV_APP_ID", "1089")

FALLBACK_ENDPOINTS = [
    DEFAULT_WS_URL,
    "wss://red.derivws.com/websockets/v3",
    "wss://blue.derivws.com/websockets/v3",
    "wss://green.derivws.com/websockets/v3",
    "wss://ws.derivws.com/websockets/v3",
]

# Standard 14 Forex pairs mapped to Deriv symbols
FOREX_PAIR_MAP: Dict[str, str] = {
    "EUR/USD": "frxEURUSD",
    "GBP/USD": "frxGBPUSD",
    "USD/JPY": "frxUSDJPY",
    "AUD/USD": "frxAUDUSD",
    "USD/CAD": "frxUSDCAD",
    "USD/CHF": "frxUSDCHF",
    "NZD/USD": "frxNZDUSD",
    "EUR/GBP": "frxEURGBP",
    "EUR/JPY": "frxEURJPY",
    "GBP/JPY": "frxGBPJPY",
    "AUD/JPY": "frxAUDJPY",
    "CAD/JPY": "frxCADJPY",
    "EUR/AUD": "frxEURAUD",
    "GBP/AUD": "frxGBPAUD",
}

# In-memory store for fast access by API routes
# pair -> { "candles": [...], "lastCandleEpoch": int, "lastPrice": float, "fetchedAt": str }
_memory_cache: Dict[str, Dict[str, Any]] = {}
_cache_lock = threading.Lock()
_connected = False
_active_endpoint = ""
_dropped_pairs: List[str] = []

def is_forex_market_open(dt: Optional[datetime] = None) -> bool:
    """
    Forex market hours:
    Opens Sunday 21:00 UTC (or 22:00 UTC depending on DST),
    Closes Friday 21:00 UTC (or 22:00 UTC depending on DST).
    Weekend closed: Friday 21:00 UTC to Sunday 21:00 UTC.
    """
    if dt is None:
        dt = datetime.now(timezone.utc)
    weekday = dt.weekday()  # Monday is 0, Sunday is 6
    hour = dt.hour

    # Friday after 21:00 UTC -> closed
    if weekday == 4 and hour >= 21:
        return False
    # All Saturday -> closed
    if weekday == 5:
        return False
    # Sunday before 21:00 UTC -> closed
    if weekday == 6 and hour < 21:
        return False
    return True

def filter_closed_candles(candles: List[Dict[str, Any]], current_time: Optional[float] = None) -> List[Dict[str, Any]]:
    """
    A2: Guarantees that forming candles are NEVER exposed.
    A 1-minute candle with start epoch T is closed ONLY when current_time >= T + 60.
    """
    if current_time is None:
        current_time = time.time()
    closed = []
    for c in candles:
        epoch = int(c.get("epoch") or c.get("time") or 0)
        # A candle is fully closed once the full 60 seconds have elapsed
        if epoch > 0 and (epoch + 60) <= current_time:
            closed.append({
                "open": float(c.get("open") or 0.0),
                "high": float(c.get("high") or 0.0),
                "low": float(c.get("low") or 0.0),
                "close": float(c.get("close") or 0.0),
                "volume": float(c.get("volume") or 0.0) if c.get("volume") is not None else 0.0,
                "time": epoch,
                "epoch": epoch
            })
    return closed

class DerivClient:
    def __init__(self, app_id: Optional[str] = None, ws_url: Optional[str] = None):
        self.app_id = app_id or DEFAULT_APP_ID
        self.primary_url = ws_url or DEFAULT_WS_URL
        self.running = False
        self.ws = None
        self._thread = None
        self.connected = False
        self.last_reconnect_time = 0
        self.reconnect_delay = 2.0
        self.active_url = ""

    def start(self):
        if self.running:
            return
        self.running = True
        self._thread = threading.Thread(target=self._run_loop, daemon=True, name="DerivClientThread")
        self._thread.start()
        logger.info("[deriv] Background worker thread started")

    def stop(self):
        self.running = False

    def _run_loop(self):
        asyncio.run(self._main_async_loop())

    async def _main_async_loop(self):
        import websockets
        while self.running:
            endpoints = [self.primary_url] + [u for u in FALLBACK_ENDPOINTS if u != self.primary_url]
            connected_successfully = False

            for base_url in endpoints:
                if not self.running:
                    break
                url = f"{base_url}?app_id={self.app_id}"
                logger.info(f"[deriv] Attempting connection to {base_url}...")
                try:
                    async with websockets.connect(
                        url, ssl=True, ping_interval=20, ping_timeout=10, close_timeout=5
                    ) as ws:
                        self.ws = ws
                        self.connected = True
                        self.active_url = base_url
                        global _connected, _active_endpoint
                        _connected = True
                        _active_endpoint = base_url
                        self.reconnect_delay = 2.0
                        logger.info(f"[deriv] Connected successfully to {base_url}")

                        # 1. Backfill history for all pairs on startup/reconnect
                        await self._backfill_all(ws)

                        # 2. Main data polling and keepalive loop
                        connected_successfully = True
                        await self._data_stream_loop(ws)

                except Exception as e:
                    self.connected = False
                    _connected = False
                    logger.warning(f"[deriv] Connection to {base_url} dropped/failed: {e}")

            if not connected_successfully and self.running:
                logger.warning(f"[deriv] All endpoints failed. Backing off for {self.reconnect_delay:.1f}s...")
                await asyncio.sleep(self.reconnect_delay)
                self.reconnect_delay = min(self.reconnect_delay * 1.5, 30.0)

    async def _backfill_all(self, ws):
        """Backfill up to 5,000 1-minute closed candles for each forex pair."""
        logger.info(f"[deriv] Starting historical backfill for {len(FOREX_PAIR_MAP)} pairs...")
        for pair, deriv_sym in FOREX_PAIR_MAP.items():
            if not self.running:
                break
            try:
                await ws.send(json.dumps({
                    "ticks_history": deriv_sym,
                    "adjust_start_time": 1,
                    "count": 5000,
                    "end": "latest",
                    "granularity": 60,
                    "style": "candles"
                }))
                raw = await asyncio.wait_for(ws.recv(), timeout=10)
                data = json.loads(raw)
                if "error" in data:
                    logger.warning(f"[deriv] Failed to backfill {pair} ({deriv_sym}): {data['error'].get('message')}")
                    continue

                raw_candles = data.get("candles", [])
                closed_candles = filter_closed_candles(raw_candles)
                if closed_candles:
                    save_candles(pair, closed_candles)
                    last_c = closed_candles[-1]
                    with _cache_lock:
                        _memory_cache[pair] = {
                            "candles": closed_candles[-500:],  # keep latest 500 in memory
                            "lastCandleEpoch": last_c["epoch"],
                            "lastPrice": last_c["close"],
                            "fetchedAt": datetime.now(timezone.utc).isoformat(),
                        }
                    logger.info(f"[deriv] Backfilled {pair}: {len(closed_candles)} closed candles stored")
            except Exception as e:
                logger.error(f"[deriv] Error backfilling {pair}: {e}")
            await asyncio.sleep(0.1)

    async def _data_stream_loop(self, ws):
        """
        Polls new candles every 5 seconds (or at minute boundaries) to emit
        the latest closed candle without exposing the forming candle.
        """
        last_ping = time.time()
        while self.running and self.connected:
            now = time.time()

            # Ping keepalive
            if now - last_ping > 25:
                await ws.send(json.dumps({"ping": 1}))
                last_ping = now

            # Poll latest closed candles for all pairs
            for pair, deriv_sym in FOREX_PAIR_MAP.items():
                if not self.running:
                    break
                try:
                    await ws.send(json.dumps({
                        "ticks_history": deriv_sym,
                        "adjust_start_time": 1,
                        "count": 5,
                        "end": "latest",
                        "granularity": 60,
                        "style": "candles"
                    }))
                    raw = await asyncio.wait_for(ws.recv(), timeout=8)
                    data = json.loads(raw)

                    # Handle ping responses or errors
                    if data.get("msg_type") == "ping":
                        raw = await asyncio.wait_for(ws.recv(), timeout=8)
                        data = json.loads(raw)

                    if "error" in data:
                        continue

                    raw_candles = data.get("candles", [])
                    closed = filter_closed_candles(raw_candles, current_time=now)
                    if closed:
                        # Save new closed candles
                        save_candles(pair, closed)
                        last_c = closed[-1]

                        # Check for gap with previous cached candle
                        with _cache_lock:
                            existing = _memory_cache.get(pair)
                            if existing:
                                prev_epoch = existing["lastCandleEpoch"]
                                # If there's a gap (> 60s), load full tail from DB
                                if last_c["epoch"] - prev_epoch > 60:
                                    logger.info(f"[deriv] Gap detected for {pair} ({prev_epoch} -> {last_c['epoch']}), refreshing cache from store")
                                    all_tail = get_candles(pair, limit=500)
                                    _memory_cache[pair] = {
                                        "candles": all_tail,
                                        "lastCandleEpoch": last_c["epoch"],
                                        "lastPrice": last_c["close"],
                                        "fetchedAt": datetime.now(timezone.utc).isoformat(),
                                    }
                                    continue

                            # Normal update: append or update in memory cache
                            all_tail = get_candles(pair, limit=500)
                            _memory_cache[pair] = {
                                "candles": all_tail,
                                "lastCandleEpoch": last_c["epoch"],
                                "lastPrice": last_c["close"],
                                "fetchedAt": datetime.now(timezone.utc).isoformat(),
                            }

                except Exception as e:
                    logger.warning(f"[deriv] Error fetching live candle for {pair}: {e}")
                    raise e  # bubble up to trigger reconnect

                await asyncio.sleep(0.1)

            # Wait 4-5 seconds before next polling cycle
            await asyncio.sleep(4.0)

# Global singleton client
client_instance = DerivClient()

def get_pair_data(pair: str) -> Dict[str, Any]:
    """Returns the pair's data formatted for the API response."""
    now = time.time()
    market_open = is_forex_market_open()

    with _cache_lock:
        cached = _memory_cache.get(pair)

    if not cached:
        # Fallback to DB
        db_candles = get_candles(pair, limit=500)
        if db_candles:
            last_c = db_candles[-1]
            last_epoch = last_c["epoch"]
            age_seconds = max(0, int(now - (last_epoch + 60)))
            stale = (age_seconds > 150) if market_open else False
            return {
                "pair": pair,
                "symbol": FOREX_PAIR_MAP.get(pair, pair),
                "market": "forex",
                "source": "deriv",
                "lastPrice": last_c["close"],
                "candles": db_candles,
                "candleCount": len(db_candles),
                "fetchedAt": datetime.now(timezone.utc).isoformat(),
                "stale": stale,
                "ageSeconds": age_seconds,
                "marketOpen": market_open,
                "lastCandleEpoch": last_epoch,
            }
        return {
            "pair": pair,
            "symbol": FOREX_PAIR_MAP.get(pair, pair),
            "market": "forex",
            "source": "deriv",
            "lastPrice": 0.0,
            "candles": [],
            "candleCount": 0,
            "fetchedAt": datetime.now(timezone.utc).isoformat(),
            "stale": True,
            "ageSeconds": 9999,
            "marketOpen": market_open,
            "lastCandleEpoch": 0,
        }

    last_epoch = cached["lastCandleEpoch"]
    age_seconds = max(0, int(now - (last_epoch + 60)))
    stale = (age_seconds > 150) if market_open else False

    return {
        "pair": pair,
        "symbol": FOREX_PAIR_MAP.get(pair, pair),
        "market": "forex",
        "source": "deriv",
        "lastPrice": cached["lastPrice"],
        "candles": cached["candles"],
        "candleCount": len(cached["candles"]),
        "fetchedAt": cached["fetchedAt"],
        "stale": stale,
        "ageSeconds": age_seconds,
        "marketOpen": market_open,
        "lastCandleEpoch": last_epoch,
    }

def get_all_pairs_data() -> List[Dict[str, Any]]:
    return [get_pair_data(pair) for pair in FOREX_PAIR_MAP.keys()]

def get_deriv_health() -> Dict[str, Any]:
    return {
        "connected": _connected,
        "activeEndpoint": _active_endpoint,
        "trackedForexPairs": len(FOREX_PAIR_MAP),
        "memoryCachePairs": len(_memory_cache),
        "marketOpen": is_forex_market_open(),
    }
