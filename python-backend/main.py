"""
SIGNALEX V9.0 — Python Real-Time Market Data Backend
=====================================================

V9.0 CHANGES:
  [QUOTEX REMOVED]  All Quotex code eliminated. Cloudflare blocks all
    programmatic access — no functional benefit over Twelve Data.

  [DATA SOURCE WATERFALL]
    1. Twelve Data    — PRIMARY (paid key, real-time 1-min candles)
    2. Yahoo Finance  — free, always available, ~1min delay
    3. Polygon.io     — optional (forex plan required)
    4. Alpha Vantage  — optional free key
    5. Stooq          — last resort, hourly/daily only

  [SESSION COVERAGE — matches V9.0 frontend]
    ASIAN:   02:00-05:00 UTC  (JPY, AUD, NZD OTC pairs)
    LONDON:  08:00-12:00 UTC
    NEWYORK: 13:00-17:00 UTC
    EVENING: 19:00-23:00 UTC

Start:  python -m uvicorn main:app --reload
Health: http://localhost:8000/health
Prices: http://localhost:8000/prices
Source: http://localhost:8000/source
Test:   http://localhost:8000/test
"""

import asyncio
import logging
import os
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone, timedelta
from typing import Optional

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

load_dotenv()

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("signalex")

# ── API Keys ──────────────────────────────────────────────────────────────────
TWELVE_DATA_KEY   = os.getenv("TWELVE_DATA_API_KEY", "")
POLYGON_KEY       = os.getenv("POLYGON_API_KEY", "")
ALPHA_VANTAGE_KEY = os.getenv("ALPHA_VANTAGE_KEY", "")
CANDLES_COUNT     = 200

HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; SIGNALEX/8.0; market data client)"}

# ── Pair Registry ─────────────────────────────────────────────────────────────
OTC_PAIRS = [
    {"id": "EUR/USD OTC", "market": "otc", "polygon": "C:EURUSD", "yf": "EURUSD=X", "td": "EUR/USD", "av": "EUR", "av_to": "USD", "stooq": "eurusd"},
    {"id": "GBP/USD OTC", "market": "otc", "polygon": "C:GBPUSD", "yf": "GBPUSD=X", "td": "GBP/USD", "av": "GBP", "av_to": "USD", "stooq": "gbpusd"},
    {"id": "USD/JPY OTC", "market": "otc", "polygon": "C:USDJPY", "yf": "USDJPY=X", "td": "USD/JPY", "av": "USD", "av_to": "JPY", "stooq": "usdjpy"},
    {"id": "AUD/USD OTC", "market": "otc", "polygon": "C:AUDUSD", "yf": "AUDUSD=X", "td": "AUD/USD", "av": "AUD", "av_to": "USD", "stooq": "audusd"},
    {"id": "USD/CAD OTC", "market": "otc", "polygon": "C:USDCAD", "yf": "USDCAD=X", "td": "USD/CAD", "av": "USD", "av_to": "CAD", "stooq": "usdcad"},
    {"id": "EUR/GBP OTC", "market": "otc", "polygon": "C:EURGBP", "yf": "EURGBP=X", "td": "EUR/GBP", "av": "EUR", "av_to": "GBP", "stooq": "eurgbp"},
    {"id": "NZD/USD OTC", "market": "otc", "polygon": "C:NZDUSD", "yf": "NZDUSD=X", "td": "NZD/USD", "av": "NZD", "av_to": "USD", "stooq": "nzdusd"},
    {"id": "USD/CHF OTC", "market": "otc", "polygon": "C:USDCHF", "yf": "USDCHF=X", "td": "USD/CHF", "av": "USD", "av_to": "CHF", "stooq": "usdchf"},
    {"id": "EUR/JPY OTC", "market": "otc", "polygon": "C:EURJPY", "yf": "EURJPY=X", "td": "EUR/JPY", "av": "EUR", "av_to": "JPY", "stooq": "eurjpy"},
    {"id": "GBP/JPY OTC", "market": "otc", "polygon": "C:GBPJPY", "yf": "GBPJPY=X", "td": "GBP/JPY", "av": "GBP", "av_to": "JPY", "stooq": "gbpjpy"},
    {"id": "AUD/JPY OTC", "market": "otc", "polygon": "C:AUDJPY", "yf": "AUDJPY=X", "td": "AUD/JPY", "av": "AUD", "av_to": "JPY", "stooq": "audjpy"},
    {"id": "EUR/CHF OTC", "market": "otc", "polygon": "C:EURCHF", "yf": "EURCHF=X", "td": "EUR/CHF", "av": "EUR", "av_to": "CHF", "stooq": "eurchf"},
]

FOREX_PAIRS = [
    {"id": "EUR/USD", "market": "forex", "polygon": "C:EURUSD", "yf": "EURUSD=X", "td": "EUR/USD", "av": "EUR", "av_to": "USD", "stooq": "eurusd"},
    {"id": "GBP/USD", "market": "forex", "polygon": "C:GBPUSD", "yf": "GBPUSD=X", "td": "GBP/USD", "av": "GBP", "av_to": "USD", "stooq": "gbpusd"},
    {"id": "USD/JPY", "market": "forex", "polygon": "C:USDJPY", "yf": "USDJPY=X", "td": "USD/JPY", "av": "USD", "av_to": "JPY", "stooq": "usdjpy"},
    {"id": "USD/CHF", "market": "forex", "polygon": "C:USDCHF", "yf": "USDCHF=X", "td": "USD/CHF", "av": "USD", "av_to": "CHF", "stooq": "usdchf"},
    {"id": "AUD/USD", "market": "forex", "polygon": "C:AUDUSD", "yf": "AUDUSD=X", "td": "AUD/USD", "av": "AUD", "av_to": "USD", "stooq": "audusd"},
    {"id": "USD/CAD", "market": "forex", "polygon": "C:USDCAD", "yf": "USDCAD=X", "td": "USD/CAD", "av": "USD", "av_to": "CAD", "stooq": "usdcad"},
    {"id": "EUR/JPY", "market": "forex", "polygon": "C:EURJPY", "yf": "EURJPY=X", "td": "EUR/JPY", "av": "EUR", "av_to": "JPY", "stooq": "eurjpy"},
    {"id": "GBP/JPY", "market": "forex", "polygon": "C:GBPJPY", "yf": "GBPJPY=X", "td": "GBP/JPY", "av": "GBP", "av_to": "JPY", "stooq": "gbpjpy"},
    {"id": "EUR/GBP", "market": "forex", "polygon": "C:EURGBP", "yf": "EURGBP=X", "td": "EUR/GBP", "av": "EUR", "av_to": "GBP", "stooq": "eurgbp"},
    {"id": "AUD/JPY", "market": "forex", "polygon": "C:AUDJPY", "yf": "AUDJPY=X", "td": "AUD/JPY", "av": "AUD", "av_to": "JPY", "stooq": "audjpy"},
    {"id": "NZD/USD", "market": "forex", "polygon": "C:NZDUSD", "yf": "NZDUSD=X", "td": "NZD/USD", "av": "NZD", "av_to": "USD", "stooq": "nzdusd"},
    {"id": "EUR/CHF", "market": "forex", "polygon": "C:EURCHF", "yf": "EURCHF=X", "td": "EUR/CHF", "av": "EUR", "av_to": "CHF", "stooq": "eurchf"},
    {"id": "GBP/CHF", "market": "forex", "polygon": "C:GBPCHF", "yf": "GBPCHF=X", "td": "GBP/CHF", "av": "GBP", "av_to": "CHF", "stooq": "gbpchf"},
    {"id": "USD/SGD", "market": "forex", "polygon": "C:USDSGD", "yf": "USDSGD=X", "td": "USD/SGD", "av": "USD", "av_to": "SGD", "stooq": "usdsgd"},
]

ALL_PAIRS = FOREX_PAIRS + OTC_PAIRS
PAIR_MAP  = {p["id"]: p for p in ALL_PAIRS}

# ── Cache ─────────────────────────────────────────────────────────────────────
candle_cache: dict = {}
cache_time:   dict = {}
source_used:  dict = {}

CACHE_TTL = {"twelve_data": 55, "yahoo_finance": 60, "polygon": 30, "alpha_vantage": 120, "stooq": 300}

def get_cache_ttl(pair_id: str) -> int:
    return CACHE_TTL.get(source_used.get(pair_id, ""), 60)

def is_weekend_utc() -> bool:
    return datetime.now(timezone.utc).weekday() >= 5

def get_active_pairs_for_session() -> list:
    if is_weekend_utc():
        return OTC_PAIRS
    return ALL_PAIRS


# =============================================================================
# DATA SOURCE 1 — TWELVE DATA  (PRIMARY)
# =============================================================================
async def fetch_twelve_data(pair: dict) -> list:
    params = {
        "symbol":     pair["td"],
        "interval":   "1min",
        "outputsize": CANDLES_COUNT,
        "format":     "JSON",
    }
    if TWELVE_DATA_KEY:
        params["apikey"] = TWELVE_DATA_KEY
    try:
        async with httpx.AsyncClient(timeout=15, headers=HEADERS) as client:
            r = await client.get("https://api.twelvedata.com/time_series", params=params)
        data = r.json()
        if data.get("status") == "error":
            log.warning("Twelve Data error for %s: %s", pair["id"], data.get("message", ""))
            return []
        if "values" not in data:
            return []
        candles = []
        for row in reversed(data["values"]):
            try:
                candles.append({
                    "open":   float(row["open"]),
                    "high":   float(row["high"]),
                    "low":    float(row["low"]),
                    "close":  float(row["close"]),
                    "volume": float(row.get("volume", 100)),
                    "time":   int(datetime.fromisoformat(row["datetime"]).timestamp()),
                })
            except (KeyError, ValueError):
                continue
        if candles:
            log.info("Twelve Data %s: %d candles", pair["id"], len(candles))
        return candles
    except Exception as e:
        log.warning("Twelve Data error for %s: %s", pair["id"], e)
        return []


# =============================================================================
# DATA SOURCE 2 — YAHOO FINANCE  (1st fallback)
# =============================================================================
async def fetch_yahoo_finance(pair: dict) -> list:
    url    = f"https://query1.finance.yahoo.com/v8/finance/chart/{pair['yf']}"
    params = {"interval": "1m", "range": "2d", "includePrePost": "false"}
    try:
        async with httpx.AsyncClient(timeout=15, headers=HEADERS) as client:
            r = await client.get(url, params=params)
        if r.status_code != 200:
            return []
        data   = r.json()
        block  = (data.get("chart", {}).get("result") or [{}])[0]
        ts     = block.get("timestamp", [])
        quotes = block.get("indicators", {}).get("quote", [{}])[0]
        opens, highs, lows, closes, volumes = (
            quotes.get("open", []), quotes.get("high", []),
            quotes.get("low",  []), quotes.get("close", []),
            quotes.get("volume", []),
        )
        candles = []
        for i, t in enumerate(ts):
            try:
                o, h, l, c = opens[i], highs[i], lows[i], closes[i]
                if None in (o, h, l, c) or c == 0:
                    continue
                candles.append({
                    "open": float(o), "high": float(h), "low": float(l),
                    "close": float(c), "volume": float(volumes[i] or 100), "time": int(t),
                })
            except (TypeError, ValueError, IndexError):
                continue
        if candles:
            log.info("Yahoo Finance %s: %d candles", pair["id"], len(candles))
        return candles
    except Exception as e:
        log.warning("Yahoo Finance error for %s: %s", pair["id"], e)
        return []


# =============================================================================
# DATA SOURCE 3 — POLYGON.IO  (2nd fallback)
# =============================================================================
async def fetch_polygon(pair: dict) -> list:
    if not POLYGON_KEY:
        return []
    now_utc = datetime.now(timezone.utc)
    from_str = (now_utc - timedelta(days=2)).strftime("%Y-%m-%d")
    to_str   = now_utc.strftime("%Y-%m-%d")
    url = f"https://api.polygon.io/v2/aggs/ticker/{pair['polygon']}/range/1/minute/{from_str}/{to_str}"
    params = {"adjusted": "true", "sort": "asc", "limit": CANDLES_COUNT, "apiKey": POLYGON_KEY}
    try:
        async with httpx.AsyncClient(timeout=15, headers=HEADERS) as client:
            r = await client.get(url, params=params)
        if r.status_code not in (200,):
            return []
        data = r.json()
        if data.get("status") == "ERROR" or not data.get("results"):
            return []
        candles = []
        for bar in data["results"]:
            try:
                candles.append({
                    "open": float(bar["o"]), "high": float(bar["h"]),
                    "low":  float(bar["l"]), "close": float(bar["c"]),
                    "volume": float(bar.get("v", 100)), "time": int(bar["t"]) // 1000,
                })
            except (KeyError, ValueError):
                continue
        if candles:
            log.info("Polygon %s: %d candles", pair["id"], len(candles))
        return candles
    except Exception as e:
        log.warning("Polygon error for %s: %s", pair["id"], e)
        return []


# =============================================================================
# DATA SOURCE 4 — ALPHA VANTAGE  (3rd fallback)
# =============================================================================
async def fetch_alpha_vantage(pair: dict) -> list:
    if not ALPHA_VANTAGE_KEY:
        return []
    params = {
        "function": "FX_INTRADAY", "from_symbol": pair["av"],
        "to_symbol": pair["av_to"], "interval": "1min",
        "outputsize": "compact", "apikey": ALPHA_VANTAGE_KEY,
    }
    try:
        async with httpx.AsyncClient(timeout=15, headers=HEADERS) as client:
            r = await client.get("https://www.alphavantage.co/query", params=params)
        data = r.json()
        ts   = data.get("Time Series FX (1min)", {})
        if not ts:
            return []
        candles = []
        for dt_str, v in sorted(ts.items()):
            try:
                candles.append({
                    "open":   float(v["1. open"]),  "high": float(v["2. high"]),
                    "low":    float(v["3. low"]),   "close": float(v["4. close"]),
                    "volume": 100.0, "time": int(datetime.fromisoformat(dt_str).timestamp()),
                })
            except (KeyError, ValueError):
                continue
        if candles:
            log.info("Alpha Vantage %s: %d candles", pair["id"], len(candles))
        return candles
    except Exception as e:
        log.warning("Alpha Vantage error for %s: %s", pair["id"], e)
        return []


# =============================================================================
# DATA SOURCE 5 — STOOQ  (last resort)
# =============================================================================
async def _fetch_stooq_interval(pair: dict, interval: str) -> list:
    url = f"https://stooq.com/q/d/l/?s={pair['stooq']}&i={interval}"
    try:
        async with httpx.AsyncClient(timeout=15, headers=HEADERS) as client:
            r = await client.get(url)
        if r.status_code != 200 or not r.text.strip():
            return []
        lines  = r.text.strip().split("\n")
        header = lines[0].strip().lower().split(",")
        has_time = "time" in header
        candles  = []
        for line in lines[1:]:
            parts = line.strip().split(",")
            try:
                if has_time and len(parts) >= 6:
                    d, t = parts[0], parts[1]
                    o, h, l, c = float(parts[2]), float(parts[3]), float(parts[4]), float(parts[5])
                elif len(parts) >= 5:
                    d, t = parts[0], "00:00:00"
                    o, h, l, c = float(parts[1]), float(parts[2]), float(parts[3]), float(parts[4])
                else:
                    continue
                combined = f"{d} {t}".strip()
                for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
                    try:
                        ts = int(datetime.strptime(combined if " " in combined else d, fmt)
                                 .replace(tzinfo=timezone.utc).timestamp())
                        break
                    except ValueError:
                        continue
                else:
                    continue
                for m in range(60):
                    frac  = m / 59 if m < 59 else 1.0
                    cmini = o + (c - o) * frac
                    candles.append({
                        "open":   o if m == 0 else candles[-1]["close"],
                        "high":   h, "low": l, "close": round(cmini, 5),
                        "volume": 100.0, "time": ts + m * 60,
                    })
            except (ValueError, IndexError):
                continue
        return candles[-CANDLES_COUNT:]
    except Exception as e:
        log.warning("Stooq error for %s (%s): %s", pair["id"], interval, e)
        return []

async def fetch_stooq(pair: dict) -> list:
    candles = await _fetch_stooq_interval(pair, "h")
    if candles:
        return candles
    log.info("Stooq hourly empty for %s — trying daily", pair["id"])
    return await _fetch_stooq_interval(pair, "d")


# =============================================================================
# WATERFALL FETCHER — Twelve Data → Yahoo → Polygon → Alpha Vantage → Stooq
# =============================================================================
async def fetch_pair_with_waterfall(pair_id: str) -> Optional[dict]:
    pair = PAIR_MAP.get(pair_id)
    if not pair:
        return None

    candles, source = [], "unknown"

    if TWELVE_DATA_KEY:
        candles = await fetch_twelve_data(pair)
        if candles:
            source = "twelve_data"

    if not candles:
        candles = await fetch_yahoo_finance(pair)
        if candles:
            source = "yahoo_finance"

    if not candles and POLYGON_KEY:
        candles = await fetch_polygon(pair)
        if candles:
            source = "polygon"

    if not candles and ALPHA_VANTAGE_KEY:
        candles = await fetch_alpha_vantage(pair)
        if candles:
            source = "alpha_vantage"

    if not candles:
        candles = await fetch_stooq(pair)
        if candles:
            source = "stooq"

    if not candles:
        log.error("[ALL SOURCES FAILED] %s", pair_id)
        return None

    candles = candles[-CANDLES_COUNT:]
    source_used[pair_id] = source
    return {
        "pair":        pair_id,
        "market":      pair["market"],
        "candles":     candles,
        "lastPrice":   round(candles[-1]["close"], 5),
        "candleCount": len(candles),
        "source":      source,
        "fetchedAt":   datetime.now(timezone.utc).isoformat(),
    }


# ── Lifespan ──────────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    mode = "OTC only (weekend)" if is_weekend_utc() else "Forex + OTC (weekday)"
    log.info("=" * 65)
    log.info("  SIGNALEX V9.0 - Python Data Backend")
    log.info("=" * 65)
    log.info("  Market mode: %s | Pairs: %d forex + %d otc = %d total",
             mode, len(FOREX_PAIRS), len(OTC_PAIRS), len(ALL_PAIRS))
    log.info("")
    log.info("Data sources:")
    log.info("  1. %s Twelve Data   (PRIMARY real-time 1-min candles)",
             "✅" if TWELVE_DATA_KEY else "⚠️ NO KEY —")
    log.info("  2.    Yahoo Finance (free fallback)")
    log.info("  3. %s Polygon.io    (%s)",
             "✅" if POLYGON_KEY else "  ", "configured" if POLYGON_KEY else "no key — skipped")
    log.info("  4. %s Alpha Vantage (%s)",
             "✅" if ALPHA_VANTAGE_KEY else "  ", "configured" if ALPHA_VANTAGE_KEY else "no key — skipped")
    log.info("  5.    Stooq        (last resort)")
    log.info("")
    log.info("  SAFETY: No auto-trading. Manual approval only.")
    log.info("  Ready on http://localhost:8000  |  /test to check sources")
    log.info("=" * 65)
    yield
    log.info("SIGNALEX V9.0 Backend shutting down.")


# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI(title="SIGNALEX V9.0 Data Backend", version="8.0.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET", "POST"], allow_headers=["*"])


@app.get("/")
async def root():
    weekend = is_weekend_utc()
    primary = "twelve_data" if TWELVE_DATA_KEY else "yahoo_finance"
    return {
        "service": "SIGNALEX V9.0 Data Backend", "version": "9.0.0",
        "status": "running", "market_mode": "otc_only" if weekend else "forex_otc",
        "primary_source": primary,
        "sources_configured": {
            "twelve_data": bool(TWELVE_DATA_KEY), "yahoo_finance": True,
            "polygon": bool(POLYGON_KEY), "alpha_vantage": bool(ALPHA_VANTAGE_KEY), "stooq": True,
        },
        "forex_pairs": len(FOREX_PAIRS), "otc_pairs": len(OTC_PAIRS),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


@app.get("/health")
async def health():
    return {
        "status": "ok", "version": "9.0.0",
        "market_mode": "otc_only" if is_weekend_utc() else "forex_otc",
        "primary_source": "twelve_data" if TWELVE_DATA_KEY else "yahoo_finance",
        "twelve_data_configured": bool(TWELVE_DATA_KEY),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


@app.get("/pairs")
async def list_pairs():
    active = get_active_pairs_for_session()
    return {
        "forex_pairs": [p["id"] for p in FOREX_PAIRS],
        "otc_pairs":   [p["id"] for p in OTC_PAIRS],
        "active_now":  [p["id"] for p in active],
        "is_weekend":  is_weekend_utc(), "total": len(ALL_PAIRS),
    }


@app.get("/source")
async def source_status():
    return {
        "sources_in_use": source_used,
        "cache_sizes": {k: len(v.get("candles", [])) for k, v in candle_cache.items()},
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


@app.get("/prices")
async def get_all_prices():
    now              = time.time()
    active_pair_defs = get_active_pairs_for_session()
    results, to_fetch = [], []

    for pair in active_pair_defs:
        pid = pair["id"]
        if pid in candle_cache and (now - cache_time.get(pid, 0)) < get_cache_ttl(pid):
            results.append(candle_cache[pid])
        else:
            to_fetch.append(pid)

    if to_fetch:
        log.info("%s mode — Fetching %d pairs: %s",
                 "Weekend" if is_weekend_utc() else "Weekday",
                 len(to_fetch), ", ".join(to_fetch))
        fetched = await asyncio.gather(
            *[fetch_pair_with_waterfall(pid) for pid in to_fetch],
            return_exceptions=True,
        )
        for item in fetched:
            if isinstance(item, Exception) or item is None:
                continue
            candle_cache[item["pair"]] = item
            cache_time[item["pair"]]   = time.time()
            results.append(item)

    if not results:
        raise HTTPException(status_code=503, detail="All data sources unavailable. Try again shortly.")

    sources_now  = list(set(r.get("source", "unknown") for r in results))
    primary_now  = "twelve_data" if any(r.get("source") == "twelve_data" for r in results) else sources_now[0]
    return {
        "pairs":       results,
        "source":      primary_now,
        "sources":     sources_now,
        "count":       len(results),
        "market_mode": "otc_only" if is_weekend_utc() else "forex_otc",
        "is_weekend":  is_weekend_utc(),
        "forex_count": sum(1 for r in results if r.get("market") == "forex"),
        "otc_count":   sum(1 for r in results if r.get("market") == "otc"),
        "timestamp":   datetime.now(timezone.utc).isoformat(),
    }


@app.get("/test")
async def test_sources():
    test_pair = {"id": "EUR/USD", "market": "forex", "polygon": "C:EURUSD",
                 "yf": "EURUSD=X", "td": "EUR/USD", "av": "EUR", "av_to": "USD", "stooq": "eurusd"}
    results = {}

    try:
        c = await fetch_twelve_data(test_pair)
        results["twelve_data"] = {"ok": len(c) > 0, "candles": len(c), "key_configured": bool(TWELVE_DATA_KEY)}
    except Exception as e:
        results["twelve_data"] = {"ok": False, "error": str(e)}

    try:
        c = await fetch_yahoo_finance(test_pair)
        results["yahoo_finance"] = {"ok": len(c) > 0, "candles": len(c)}
    except Exception as e:
        results["yahoo_finance"] = {"ok": False, "error": str(e)}

    if POLYGON_KEY:
        try:
            c = await fetch_polygon(test_pair)
            results["polygon"] = {"ok": len(c) > 0, "candles": len(c), "key_configured": True}
        except Exception as e:
            results["polygon"] = {"ok": False, "error": str(e), "key_configured": True}
    else:
        results["polygon"] = {"ok": False, "key_configured": False, "note": "Add POLYGON_API_KEY to .env"}

    if ALPHA_VANTAGE_KEY:
        try:
            c = await fetch_alpha_vantage(test_pair)
            results["alpha_vantage"] = {"ok": len(c) > 0, "candles": len(c), "key_configured": True}
        except Exception as e:
            results["alpha_vantage"] = {"ok": False, "error": str(e), "key_configured": True}
    else:
        results["alpha_vantage"] = {"ok": False, "key_configured": False, "note": "Add ALPHA_VANTAGE_KEY to .env"}

    try:
        c = await fetch_stooq(test_pair)
        results["stooq"] = {"ok": len(c) > 0, "candles": len(c), "note": "Synthesised — last resort only"}
    except Exception as e:
        results["stooq"] = {"ok": False, "error": str(e)}

    working = [k for k, v in results.items() if v.get("ok")]
    primary = next((s for s in ["twelve_data", "yahoo_finance", "polygon"] if results.get(s, {}).get("ok")), "none")
    return {
        "sources": results, "working": working, "active_primary": primary,
        "any_working": len(working) > 0,
        "market_mode": "otc_only" if is_weekend_utc() else "forex_otc",
        "recommendation": (
            "✅ Twelve Data active — real-time 1-min candles flowing" if results.get("twelve_data", {}).get("ok")
            else "⚠️ Yahoo Finance fallback active — add TWELVE_DATA_API_KEY for best results"
            if results.get("yahoo_finance", {}).get("ok")
            else "❌ All sources failed — check internet connection"
        ),
    }


@app.get("/price/{pair_id:path}")
async def get_single_price(pair_id: str):
    pair_id = pair_id.replace("%2F", "/").strip()
    pair    = PAIR_MAP.get(pair_id)
    if not pair:
        raise HTTPException(status_code=404, detail=f"Unknown pair: {pair_id}")
    now = time.time()
    if pair_id in candle_cache and (now - cache_time.get(pair_id, 0)) < get_cache_ttl(pair_id):
        candles = candle_cache[pair_id].get("candles", [])
        if candles:
            return {"pair": pair_id, "price": round(candles[-1]["close"], 5),
                    "source": "cache", "timestamp": datetime.now(timezone.utc).isoformat()}
    for fn, src in [(fetch_twelve_data, "twelve_data") if TWELVE_DATA_KEY else (None, None),
                    (fetch_yahoo_finance, "yahoo_finance")]:
        if fn is None:
            continue
        candles = await fn(pair)
        if candles:
            candle_cache[pair_id] = {**candle_cache.get(pair_id, {}), "candles": candles}
            cache_time[pair_id]   = time.time()
            source_used[pair_id]  = src
            return {"pair": pair_id, "price": round(candles[-1]["close"], 5),
                    "source": src, "timestamp": datetime.now(timezone.utc).isoformat()}
    raise HTTPException(status_code=503, detail=f"Could not fetch price for {pair_id}")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=False, log_level="info")
