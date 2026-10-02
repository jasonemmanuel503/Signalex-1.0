#!/usr/bin/env python3
"""
Probe Deriv API for active symbols and 1-minute closed candles.
"""
import asyncio
import json
import os
import sys
import websockets

DEFAULT_WS_URL = os.getenv("DERIV_WS_URL", "wss://red.derivws.com/websockets/v3")
DEFAULT_APP_ID = os.getenv("DERIV_APP_ID", "1089")

FOREX_PAIRS_TO_CHECK = [
    "EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD", "USD/CAD",
    "USD/CHF", "NZD/USD", "EUR/GBP", "EUR/JPY", "GBP/JPY",
    "AUD/JPY", "CAD/JPY", "EUR/AUD", "GBP/AUD"
]

async def probe():
    url = f"{DEFAULT_WS_URL}?app_id={DEFAULT_APP_ID}"
    print(f"[probe] Connecting to {url}...")
    try:
        async with websockets.connect(url, ssl=True, ping_interval=20, ping_timeout=10) as ws:
            print("[probe] Connected successfully!")

            # 1. Fetch active symbols
            print("\n[probe] Requesting active_symbols...")
            await ws.send(json.dumps({
                "active_symbols": "brief",
                "product_type": "basic"
            }))
            resp = json.loads(await ws.recv())
            if "error" in resp:
                print(f"[probe] active_symbols error: {resp['error']}")
                return

            active_symbols = resp.get("active_symbols", [])
            print(f"[probe] Received {len(active_symbols)} active symbols.")

            # Map symbols: symbol -> display_name
            deriv_symbol_map = {}
            for item in active_symbols:
                sym = item.get("symbol", "")
                display = item.get("display_name", "")
                market = item.get("market", "")
                submarket = item.get("submarket", "")
                if market == "forex" or "frx" in sym:
                    deriv_symbol_map[sym] = display

            print(f"[probe] Found {len(deriv_symbol_map)} forex symbols in Deriv.")

            # Check our pairs
            mapped = {}
            dropped = []
            for pair in FOREX_PAIRS_TO_CHECK:
                clean = pair.replace("/", "")
                deriv_sym = f"frx{clean}"
                if deriv_sym in deriv_symbol_map:
                    mapped[pair] = deriv_sym
                else:
                    dropped.append(pair)

            print("\n[probe] Pair Mapping Results:")
            for pair, sym in mapped.items():
                print(f"  ✓ {pair:8} -> {sym} ({deriv_symbol_map.get(sym, '')})")
            if dropped:
                print(f"\n[probe] Dropped (unavailable) pairs: {dropped}")
            else:
                print("\n[probe] All pairs available in Deriv!")

            # 2. Test ticks_history for EUR/USD (frxEURUSD)
            test_symbol = "frxEURUSD"
            print(f"\n[probe] Requesting 5 1-minute candles for {test_symbol}...")
            await ws.send(json.dumps({
                "ticks_history": test_symbol,
                "adjust_start_time": 1,
                "count": 5,
                "end": "latest",
                "granularity": 60,
                "style": "candles"
            }))
            candle_resp = json.loads(await ws.recv())
            if "error" in candle_resp:
                print(f"[probe] ticks_history error: {candle_resp['error']}")
            else:
                candles = candle_resp.get("candles", [])
                print(f"[probe] Successfully received {len(candles)} candles:")
                for c in candles:
                    print(f"  epoch={c.get('epoch')} | O={c.get('open')} H={c.get('high')} L={c.get('low')} C={c.get('close')}")

            # 3. Test max candles count in single request
            print(f"\n[probe] Testing maximum candle count per request...")
            for count_test in [1000, 2000, 5000]:
                await ws.send(json.dumps({
                    "ticks_history": test_symbol,
                    "adjust_start_time": 1,
                    "count": count_test,
                    "end": "latest",
                    "granularity": 60,
                    "style": "candles"
                }))
                res = json.loads(await ws.recv())
                if "error" in res:
                    print(f"  Count {count_test}: ERROR {res['error'].get('message')}")
                else:
                    got = len(res.get("candles", []))
                    print(f"  Count {count_test}: SUCCESS, received {got} candles")

    except Exception as e:
        print(f"[probe] Error during probe: {e}")

if __name__ == "__main__":
    asyncio.run(probe())
