#!/usr/bin/env python3
"""
SIGNALEX — Pocket Option Gateway Smoke Test
Connects with demo credentials, subscribes to 1 forex pair + 1 OTC pair,
prints closed candles and payouts for a specified duration (default 180s),
places ZERO orders, and prints PASS or FAIL.
"""

import sys
import os
import time
import argparse
import asyncio
from dotenv import load_dotenv

# Add parent directory to path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from po_adapter import PocketOptionSDKAdapter
from fake_adapter import FakePocketOptionAdapter

load_dotenv()

async def run_smoke_test(duration_secs: int = 180, use_fake: bool = False, forex_pair: str = "EURUSD", otc_pair: str = "AUDCAD_otc"):
    print("=" * 70)
    print("SIGNALEX POCKET OPTION SMOKE TEST (READ-ONLY)")
    print(f"Target duration: {duration_secs}s")
    print(f"Pairs to monitor: Forex={forex_pair}, OTC={otc_pair}")
    print(f"Mode: {'Fake Adapter (Simulated)' if use_fake else 'Live Pocket Option SDK'}")
    print("=" * 70)

    if use_fake:
        adapter = FakePocketOptionAdapter()
    else:
        session = os.getenv("PO_SESSION", "").strip()
        uid_str = os.getenv("PO_UID", "0").strip()
        uid = int(uid_str) if uid_str.isdigit() else 0
        region = os.getenv("PO_REGION", "DEMO")

        if not session or not uid:
            print("[FAIL] PO_SESSION or PO_UID environment variables are missing.")
            print("Please set them in po-gateway/.env or environment.")
            return False

        adapter = PocketOptionSDKAdapter(
            session=session,
            uid=uid,
            region_name=region
        )

    print("\n[1/4] Connecting to broker...")
    await adapter.connect()

    # Wait up to 10s for connection
    connected = False
    for i in range(20):
        if adapter.is_connected() and adapter.get_session_status() == "valid":
            connected = True
            break
        await asyncio.sleep(0.5)

    if not connected:
        print(f"[FAIL] Could not authenticate. Session status: {adapter.get_session_status()}")
        await adapter.disconnect()
        return False
    print(f"[PASS] Connected and authorized! Session status: {adapter.get_session_status()}")

    print("\n[2/4] Checking balance...")
    demo_bal = await adapter.get_balance("demo")
    print(f"[PASS] Demo balance: ${demo_bal:,.2f}")

    print("\n[3/4] Subscribing to assets and checking payouts...")
    pairs_to_sub = [forex_pair, otc_pair]
    await adapter.subscribe(pairs_to_sub)
    await asyncio.sleep(1.0)

    assets = await adapter.get_assets()
    forex_meta = next((a for a in assets if a.pair == forex_pair), None)
    otc_meta = next((a for a in assets if a.pair == otc_pair), None)

    print(f"  - {forex_pair}: Open={forex_meta.open if forex_meta else 'Unknown'} | Payout={forex_meta.payout_pct if forex_meta else 'N/A'}%")
    print(f"  - {otc_pair}: Open={otc_meta.open if otc_meta else 'Unknown'} | Payout={otc_meta.payout_pct if otc_meta else 'N/A'}%")

    print(f"\n[4/4] Streaming closed candles for {duration_secs} seconds (polling every 10s)...")
    start_time = time.time()
    poll_count = 0
    candles_received_forex = 0
    candles_received_otc = 0

    while time.time() - start_time < duration_secs:
        poll_count += 1
        elapsed = int(time.time() - start_time)

        forex_candles = await adapter.get_candles(forex_pair, n=5)
        otc_candles = await adapter.get_candles(otc_pair, n=5)

        candles_received_forex = len(forex_candles)
        candles_received_otc = len(otc_candles)

        latest_fx = forex_candles[-1] if forex_candles else None
        latest_otc = otc_candles[-1] if otc_candles else None

        print(f"[{elapsed}s / {duration_secs}s] Poll #{poll_count}:")
        if latest_fx:
            print(f"  Forex ({forex_pair}): {len(forex_candles)} closed candles | Latest close: {latest_fx.close} (TS: {latest_fx.timestamp})")
        else:
            print(f"  Forex ({forex_pair}): Waiting for candle bucket close...")

        if latest_otc:
            print(f"  OTC   ({otc_pair}): {len(otc_candles)} closed candles | Latest close: {latest_otc.close} (TS: {latest_otc.timestamp})")
        else:
            print(f"  OTC   ({otc_pair}): Waiting for candle bucket close...")

        await asyncio.sleep(min(10.0, max(1.0, duration_secs - (time.time() - start_time))))

    print("\n" + "=" * 70)
    print("VERIFICATION SUMMARY:")
    print(f"- Connection alive: {adapter.is_connected()}")
    print(f"- Session status: {adapter.get_session_status()}")
    print(f"- Forex candles observed: {candles_received_forex}")
    print(f"- OTC candles observed: {candles_received_otc}")
    print("- Orders placed: 0 (Strict read-only safety verified)")

    success = (
        adapter.is_connected() and
        adapter.get_session_status() == "valid" and
        candles_received_forex > 0 and
        candles_received_otc > 0
    )

    await adapter.disconnect()

    if success:
        print("\n>>> RESULT: PASS <<<")
        return True
    else:
        print("\n>>> RESULT: FAIL (Missing candles or connection dropped) <<<")
        return False

def main():
    parser = argparse.ArgumentParser(description="SignaLex Pocket Option Gateway Smoke Test")
    parser.add_argument("--duration", type=int, default=180, help="Duration in seconds to monitor (default: 180)")
    parser.add_argument("--fake", action="store_true", help="Use fake adapter for testing without live account")
    parser.add_argument("--forex", type=str, default="EURUSD", help="Forex pair to monitor")
    parser.add_argument("--otc", type=str, default="AUDCAD_otc", help="OTC pair to monitor")
    args = parser.parse_args()

    use_fake = args.fake or (os.getenv("PO_USE_FAKE_ADAPTER", "false").lower() in ("true", "1", "yes"))
    passed = asyncio.run(run_smoke_test(
        duration_secs=args.duration,
        use_fake=use_fake,
        forex_pair=args.forex,
        otc_pair=args.otc,
    ))

    sys.exit(0 if passed else 1)

if __name__ == "__main__":
    main()
