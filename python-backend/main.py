"""
SIGNALEX V10 — Python Real-Time Market Data Backend (Deriv-Powered)
==================================================================
PHASE A: Trustworthy data + honest results logging.
- Deriv 1-minute closed candles only.
- Strict market hours (weekend marketOpen=false).
- OTC pairs marked proxy=true / collecting data for Phase D.
- SQLite persistence in data/candles.db.
"""

import logging
import os
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from candle_store import get_candles, count_candles
from deriv_client import (
    client_instance,
    get_all_pairs_data,
    get_pair_data,
    get_deriv_health,
    is_forex_market_open,
    FOREX_PAIR_MAP,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("signalex.main")

ALLOW_YAHOO_FALLBACK = os.getenv("ALLOW_YAHOO_FALLBACK", "false").lower() == "true"

# Standard OTC pairs in Signalex
OTC_PAIRS = [
    {"id": "EUR/USD OTC", "twin": "EUR/USD"},
    {"id": "GBP/USD OTC", "twin": "GBP/USD"},
    {"id": "USD/JPY OTC", "twin": "USD/JPY"},
    {"id": "AUD/USD OTC", "twin": "AUD/USD"},
    {"id": "USD/CAD OTC", "twin": "USD/CAD"},
    {"id": "EUR/GBP OTC", "twin": "EUR/GBP"},
    {"id": "NZD/USD OTC", "twin": "NZD/USD"},
    {"id": "USD/CHF OTC", "twin": "USD/CHF"},
    {"id": "EUR/JPY OTC", "twin": "EUR/JPY"},
    {"id": "GBP/JPY OTC", "twin": "GBP/JPY"},
    {"id": "AUD/JPY OTC", "twin": "AUD/JPY"},
    {"id": "EUR/CHF OTC", "twin": "EUR/CHF"},
]

@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("Starting SIGNALEX V10 Market Data Backend...")
    client_instance.start()
    yield
    log.info("Shutting down SIGNALEX V10 Market Data Backend...")
    client_instance.stop()

app = FastAPI(title="SIGNALEX V10 Data Backend", version="10.0.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET", "POST"], allow_headers=["*"])

# Ensure client starts immediately
client_instance.start()

@app.get("/")
async def root():
    market_open = is_forex_market_open()
    health = get_deriv_health()
    return {
        "service": "SIGNALEX V10 Data Backend",
        "version": "10.0.0",
        "status": "running",
        "primary_source": "deriv",
        "market_open": market_open,
        "market_mode": "forex_open" if market_open else "market_closed",
        "deriv_connected": health["connected"],
        "active_endpoint": health["activeEndpoint"],
        "forex_pairs": len(FOREX_PAIR_MAP),
        "otc_pairs": len(OTC_PAIRS),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }

@app.get("/health")
async def health():
    return {
        "status": "ok",
        "version": "10.0.0",
        "primary_source": "deriv",
        "deriv": get_deriv_health(),
        "allow_yahoo_fallback": ALLOW_YAHOO_FALLBACK,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }

@app.get("/prices")
async def get_all_prices():
    market_open = is_forex_market_open()
    results = get_all_pairs_data()

    # Append OTC pairs marked as proxy / collecting data (Phase D)
    for otc in OTC_PAIRS:
        twin_data = get_pair_data(otc["twin"])
        results.append({
            "pair": otc["id"],
            "symbol": otc["id"],
            "market": "otc",
            "source": "deriv",
            "proxy": True,
            "collectingData": True,
            "status": "OTC - collecting data (Phase D)",
            "lastPrice": twin_data.get("lastPrice", 0.0),
            "candles": twin_data.get("candles", []),
            "candleCount": twin_data.get("candleCount", 0),
            "fetchedAt": twin_data.get("fetchedAt", datetime.now(timezone.utc).isoformat()),
            "stale": twin_data.get("stale", False),
            "ageSeconds": twin_data.get("ageSeconds", 0),
            "marketOpen": market_open,
            "lastCandleEpoch": twin_data.get("lastCandleEpoch", 0),
        })

    return {
        "pairs": results,
        "source": "deriv",
        "count": len(results),
        "marketOpen": market_open,
        "is_weekend": not market_open,
        "forex_count": len(FOREX_PAIR_MAP),
        "otc_count": len(OTC_PAIRS),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }

@app.get("/price/{pair_id:path}")
async def get_single_price(pair_id: str):
    clean_pair = pair_id.replace("%2F", "/").strip()
    is_otc = "OTC" in clean_pair
    twin = clean_pair.replace(" OTC", "").strip() if is_otc else clean_pair

    if twin not in FOREX_PAIR_MAP:
        raise HTTPException(status_code=404, detail=f"Unknown pair: {clean_pair}")

    data = get_pair_data(twin)
    if is_otc:
        data = {
            **data,
            "pair": clean_pair,
            "symbol": clean_pair,
            "market": "otc",
            "proxy": True,
            "collectingData": True,
            "status": "OTC - collecting data (Phase D)",
        }
    return data

@app.get("/candles/{pair_id:path}")
async def get_pair_candles(pair_id: str, n: int = Query(default=500, le=5000)):
    clean_pair = pair_id.replace("%2F", "/").replace(" OTC", "").strip()
    if clean_pair not in FOREX_PAIR_MAP:
        raise HTTPException(status_code=404, detail=f"Unknown pair: {clean_pair}")

    candles = get_candles(clean_pair, limit=n)
    return {
        "pair": clean_pair,
        "count": len(candles),
        "candles": candles,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PYTHON_BACKEND_PORT", "8001"))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=False, log_level="info")
