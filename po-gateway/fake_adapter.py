from __future__ import annotations
import asyncio
import os
import time
import math
import random
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

class FakePocketOptionAdapter(PocketOptionAdapter):
    """
    Fake adapter for deterministic testing and development.
    Simulates real-time price feeds, asset metadata, balances, and deal results.
    """
    def __init__(
        self,
        demo_balance: float = 10000.0,
        real_balance: float = 250.0,
        real_configured: bool = False,
    ):
        self._demo_connected = False
        self._demo_session_status: Literal["missing", "connecting", "valid", "disconnected", "expired", "unknown"] = "unknown"
        self._demo_last_message_at = 0.0
        self._demo_balance: Optional[float] = demo_balance
        self._initial_demo_balance = demo_balance

        self._real_configured = real_configured
        self._real_connected = False
        self._real_session_status: Literal["missing", "connecting", "valid", "disconnected", "expired", "unknown"] = "unknown"
        self._real_last_message_at = 0.0
        self._real_balance: Optional[float] = real_balance

        # Simulation & watchdog state
        self._network_down = False
        self._auth_reject_mode = False
        self._auth_fail_count = 0
        self._net_fail_count = 0
        self._next_attempt_at = 0.0
        self._generation = 0
        self.disconnect_call_count = 0

        self._subscribed_pairs: set[str] = set()
        self._assets: Dict[str, AssetMetadata] = {}
        self._candles: Dict[str, List[CandleData]] = {}
        self._deals: Dict[str, OrderResult] = {}
        self._price_bases: Dict[str, float] = {
            "EURUSD": 1.08500,
            "GBPUSD": 1.29500,
            "USDJPY": 154.200,
            "AUDUSD": 0.65500,
            "USDCAD": 1.38500,
            "EURUSD_otc": 1.08550,
            "GBPUSD_otc": 1.29480,
            "AUDCAD_otc": 0.89200,
            "USDJPY_otc": 154.150,
            "NZDUSD_otc": 0.59800,
        }
        self._init_default_assets()
        self._init_mock_candles()

    def _init_default_assets(self):
        pairs_config = [
            ("EURUSD", False, True, 86),
            ("GBPUSD", False, True, 85),
            ("USDJPY", False, True, 84),
            ("AUDUSD", False, True, 82),
            ("USDCAD", False, True, 80),
            ("EURUSD_otc", True, True, 92),
            ("GBPUSD_otc", True, True, 90),
            ("AUDCAD_otc", True, True, 91),
            ("USDJPY_otc", True, True, 88),
            ("NZDUSD_otc", True, True, 89),
        ]
        for idx, (p, is_otc, is_open, payout) in enumerate(pairs_config, 1):
            self._assets[p] = AssetMetadata(
                pair=p,
                asset_id=idx,
                label=p.replace("_otc", " (OTC)"),
                is_otc=is_otc,
                open=is_open,
                payout_pct=payout,
                min_expiration=60,
                default_expiration=60,
                digits=3 if "JPY" in p else 5,
            )

    def _init_mock_candles(self):
        # Generate 60 historical closed 1-minute candles for each pair
        now_bucket = (int(time.time()) // 60) * 60
        for pair, base in self._price_bases.items():
            candles = []
            curr_p = base
            for i in range(60, 0, -1):
                ts = now_bucket - (i * 60)
                step = (random.random() - 0.49) * (0.0004 if "JPY" not in pair else 0.04)
                open_p = curr_p
                close_p = open_p + step
                high_p = max(open_p, close_p) + abs(step) * 0.5
                low_p = min(open_p, close_p) - abs(step) * 0.5
                curr_p = close_p
                digits = 3 if "JPY" in pair else 5
                candles.append(CandleData(
                    timestamp=ts,
                    open=round(open_p, digits),
                    high=round(high_p, digits),
                    low=round(low_p, digits),
                    close=round(close_p, digits),
                    volume=random.randint(10, 100),
                    is_closed=True,
                ))
            self._candles[pair] = candles

    async def connect(self) -> None:
        await asyncio.sleep(0.01)
        if self._network_down:
            self._demo_connected = False
            self._demo_session_status = "disconnected"
            self._demo_balance = None
            return

        if self._auth_reject_mode:
            self._demo_connected = True
            self._demo_session_status = "connecting"
            self._demo_balance = None
            return

        self._demo_connected = True
        self._demo_session_status = "valid"
        self._demo_balance = self._initial_demo_balance
        self._demo_last_message_at = time.time()
        self._auth_fail_count = 0
        self._net_fail_count = 0
        if self._real_configured:
            self._real_connected = True
            self._real_session_status = "valid"
            self._real_last_message_at = time.time()

    async def disconnect(self) -> None:
        self.disconnect_call_count += 1
        self._demo_connected = False
        self._demo_session_status = "disconnected" if self._demo_session_status != "expired" else "expired"
        self._demo_balance = None
        self._real_connected = False
        self._real_session_status = "disconnected" if self._real_session_status != "expired" else "expired"
        self._real_balance = None

    def simulate_disconnect(self) -> None:
        self._demo_connected = False
        self._demo_session_status = "disconnected"
        self._demo_balance = None

    def simulate_network_down(self) -> None:
        self._network_down = True
        self._demo_connected = False
        self._demo_session_status = "disconnected"
        self._demo_balance = None

    def simulate_network_up(self) -> None:
        self._network_down = False

    def simulate_auth_reject(self, enabled: bool = True) -> None:
        self._auth_reject_mode = enabled
        if enabled:
            self._demo_session_status = "connecting"

    async def check_watchdog(self) -> None:
        backoff_base = float(os.getenv("PO_BACKOFF_BASE", "10"))
        backoff_max = float(os.getenv("PO_BACKOFF_MAX", "60"))
        auth_fail_limit = int(os.getenv("PO_AUTH_FAIL_LIMIT", "3"))

        if self._demo_session_status in ("expired", "missing"):
            return

        now = time.time()
        if now < self._next_attempt_at:
            return

        if self._network_down:
            self._net_fail_count += 1
            n = self._net_fail_count + self._auth_fail_count
            backoff = min(backoff_base * (2 ** max(0, n - 1)), backoff_max)
            self._next_attempt_at = now + backoff
            self._demo_connected = False
            self._demo_session_status = "disconnected"
            self._demo_balance = None
            return

        if self._auth_reject_mode:
            self._auth_fail_count += 1
            n = self._net_fail_count + self._auth_fail_count
            backoff = min(backoff_base * (2 ** max(0, n - 1)), backoff_max)
            self._next_attempt_at = now + backoff

            if self._auth_fail_count >= auth_fail_limit:
                self._demo_session_status = "expired"
                self._demo_connected = False
                self._demo_balance = None
                await self.disconnect()
            else:
                self._demo_connected = False
                self._demo_session_status = "disconnected"
                self._demo_balance = None
            return

        if not self._demo_connected or self._demo_session_status != "valid":
            await self.connect()

    async def set_session(self, session: str, uid: int) -> bool:
        if self._auth_reject_mode:
            self._auth_fail_count += 1
            self._demo_connected = False
            self._demo_session_status = "disconnected"
            self._demo_balance = None
            return False

        self._demo_connected = True
        self._demo_session_status = "valid"
        self._demo_balance = self._initial_demo_balance
        self._auth_fail_count = 0
        self._net_fail_count = 0
        return True

    def is_connected(self, account: Literal["demo", "real"] = "demo") -> bool:
        if account == "real":
            return bool(self._real_configured and self._real_connected)
        return self._demo_connected

    def get_session_status(self, account: Literal["demo", "real"] = "demo") -> Literal["missing", "connecting", "valid", "disconnected", "expired", "unknown"]:
        if account == "real":
            return self._real_session_status if self._real_configured else "unknown"
        return self._demo_session_status

    def get_last_message_at(self, account: Literal["demo", "real"] = "demo") -> float:
        if account == "real":
            return self._real_last_message_at if self._real_configured else 0.0
        return self._demo_last_message_at

    async def subscribe(self, pairs: list[str]) -> None:
        self._subscribed_pairs.update(pairs)
        self._demo_last_message_at = time.time()
        if self._real_configured:
            self._real_last_message_at = time.time()

    async def get_candles(self, pair: str, n: int = 100) -> list[CandleData]:
        self._demo_last_message_at = time.time()
        # Always return only closed candles up to current completed minute
        now_bucket = (int(time.time()) // 60) * 60
        candles = self._candles.get(pair, [])
        # Append latest closed bucket if time progressed
        if candles and candles[-1].timestamp < now_bucket - 60:
            last_close = candles[-1].close
            missing_ts = candles[-1].timestamp + 60
            while missing_ts < now_bucket:
                step = (random.random() - 0.49) * 0.0002
                o = last_close
                c = o + step
                h = max(o, c) + 0.0001
                l = min(o, c) - 0.0001
                digits = 3 if "JPY" in pair else 5
                candles.append(CandleData(
                    timestamp=missing_ts,
                    open=round(o, digits),
                    high=round(h, digits),
                    low=round(l, digits),
                    close=round(c, digits),
                    volume=30,
                    is_closed=True,
                ))
                last_close = c
                missing_ts += 60
            self._candles[pair] = candles[-200:]

        closed = [c for c in candles if c.timestamp < now_bucket]
        return closed[-n:]

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
        self._demo_last_message_at = time.time()
        return list(self._assets.values())

    async def get_balance(self, account: Literal["demo", "real"]) -> Optional[float]:
        if account == "real":
            if not self._real_configured:
                raise RuntimeError("Real account is not configured")
            if not self._real_connected or self._real_session_status != "valid" or self._real_balance is None:
                return None
            return float(self._real_balance)
        if not self._demo_connected or self._demo_session_status != "valid" or self._demo_balance is None:
            return None
        return float(self._demo_balance)

    async def get_accounts_status(self) -> dict:
        demo_status = {
            "connected": bool(self._demo_connected),
            "session": self._demo_session_status,
            "balance": float(self._demo_balance) if (self._demo_balance is not None and self._demo_connected and self._demo_session_status == "valid") else None,
        }
        if not self._real_configured:
            real_status = {"status": "not_configured"}
        else:
            real_status = {
                "connected": bool(self._real_connected),
                "session": self._real_session_status,
                "balance": float(self._real_balance) if (self._real_balance is not None and self._real_connected and self._real_session_status == "valid") else None,
            }
        return {
            "demo": demo_status,
            "real": real_status,
        }

    async def place_order(
        self,
        pair: str,
        direction: Literal["CALL", "PUT"],
        stake: float,
        expiry_secs: int,
        account: Literal["demo", "real"] = "demo",
    ) -> OrderResult:
        if account == "real":
            if not self._real_configured:
                raise RuntimeError("Real account is not configured")
            if not self._real_connected:
                raise RuntimeError("Broker not connected on real account")
            if self._real_session_status != "valid":
                raise RuntimeError(f"Real session not valid: {self._real_session_status}")
            if self._real_balance < stake:
                raise RuntimeError(f"Insufficient real balance: {self._real_balance} < {stake}")
            self._real_balance -= stake
            self._real_last_message_at = time.time()
        else:
            if not self._demo_connected:
                raise RuntimeError("Broker not connected on demo account")
            if self._demo_session_status != "valid":
                raise RuntimeError(f"Demo session not valid: {self._demo_session_status}")
            if self._demo_balance < stake:
                raise RuntimeError(f"Insufficient demo balance: {self._demo_balance} < {stake}")
            self._demo_balance -= stake
            self._demo_last_message_at = time.time()

        asset = self._assets.get(pair)
        if not asset or not asset.open:
            raise RuntimeError(f"Asset {pair} is closed or not available")

        deal_id = f"mock_deal_{int(time.time()*1000)}_{random.randint(100, 999)}"
        entry_price = self._candles.get(pair, [CandleData(timestamp=int(time.time()), open=1.0, high=1.0, low=1.0, close=1.0)])[-1].close
        now = int(time.time())

        result = OrderResult(
            deal_id=deal_id,
            pair=pair,
            account=account,
            direction=direction,
            stake=stake,
            payout_pct=asset.payout_pct,
            entry_price=entry_price,
            open_time=now,
            status="OPEN",
            result_source="broker",
        )
        self._deals[deal_id] = result
        return result

    async def track_order_result(
        self,
        deal_id: str,
        expiry_secs: int,
        timeout_secs: int = 90,
    ) -> OrderResult:
        order = self._deals.get(deal_id)
        if not order:
            raise RuntimeError(f"Deal {deal_id} not found")

        # Simulate outcome based on slight price movement
        digits = 3 if "JPY" in order.pair else 5
        delta = (random.random() - 0.48) * (0.0003 if "JPY" not in order.pair else 0.03)
        exit_price = round(order.entry_price + delta, digits)
        order.exit_price = exit_price
        order.close_time = order.open_time + expiry_secs

        is_win = (order.direction == "CALL" and exit_price > order.entry_price) or \
                 (order.direction == "PUT" and exit_price < order.entry_price)
        is_tie = (exit_price == order.entry_price)

        def _add_balance(account_name, amount):
            if account_name == "real":
                self._real_balance += amount
            else:
                self._demo_balance += amount

        if is_tie:
            order.status = "TIE"
            order.profit = 0.0
            _add_balance(order.account, order.stake)
        elif is_win:
            order.status = "WIN"
            profit = round(order.stake * (order.payout_pct / 100.0), 2)
            order.profit = profit
            _add_balance(order.account, order.stake + profit)
        else:
            order.status = "LOSS"
            order.profit = -order.stake

        order.result_source = "broker"
        return order
