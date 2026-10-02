"""
Unit tests for Phase A: Closed candles only requirement (A2).
Proves that the forming candle is never exposed or returned.
"""

import time
import pytest
from deriv_client import filter_closed_candles, is_forex_market_open

def test_forming_candle_is_never_returned():
    # Simulate a fixed current time: minute boundary 1,700,000,000 + 45 seconds
    current_minute = 1700000000
    now = current_minute + 45.0  # 45s into current minute

    candle_closed_1 = {"epoch": current_minute - 120, "open": 1.1000, "close": 1.1010, "time": current_minute - 120}
    candle_closed_2 = {"epoch": current_minute - 60, "open": 1.1010, "close": 1.1020, "time": current_minute - 60}
    candle_forming  = {"epoch": current_minute, "open": 1.1020, "close": 1.1025, "time": current_minute}
    candle_future   = {"epoch": current_minute + 60, "open": 1.1025, "close": 1.1030, "time": current_minute + 60}

    input_candles = [candle_closed_1, candle_closed_2, candle_forming, candle_future]
    result = filter_closed_candles(input_candles, current_time=now)

    # 1. Must return only closed candles
    assert len(result) == 2, f"Expected 2 closed candles, got {len(result)}"

    # 2. Result epochs must all be strictly less than current_minute
    for c in result:
        assert c["epoch"] < current_minute, f"Forming or future candle exposed! epoch={c['epoch']}"
        assert c["time"] < current_minute

    # 3. Explicitly check that candle_forming is NOT in result
    epochs = [c["epoch"] for c in result]
    assert current_minute not in epochs, "Forming candle epoch 1700000000 was included in output!"
    assert (current_minute + 60) not in epochs, "Future candle epoch 1700000060 was included in output!"

def test_candle_becomes_closed_only_when_next_minute_begins():
    current_minute = 1700000000
    candle_to_test = {"epoch": current_minute, "open": 1.10, "close": 1.11, "time": current_minute}

    # At 59.9 seconds into minute, it is still forming
    still_forming = filter_closed_candles([candle_to_test], current_time=current_minute + 59.9)
    assert len(still_forming) == 0, "Candle leaked before minute ended!"

    # Exactly at start of next minute (T + 60), it is closed
    now_closed = filter_closed_candles([candle_to_test], current_time=current_minute + 60.0)
    assert len(now_closed) == 1, "Candle was not emitted after minute closed!"
    assert now_closed[0]["epoch"] == current_minute

if __name__ == "__main__":
    test_forming_candle_is_never_returned()
    test_candle_becomes_closed_only_when_next_minute_begins()
    print("ALL A2 CLOSED CANDLE UNIT TESTS PASSED!")
