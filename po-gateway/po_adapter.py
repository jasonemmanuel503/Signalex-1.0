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

class PocketOptionSDKAdapter(PocketOptionAdapter):
    """
    Real adapter wrapping the pocket-option (0.4.0) SDK.
    Connects to Pocket Option WebSocket, handles authentication,
    streams candles, monitors balances, and executes deals.
    """
    def __init__(
        self,
        session: str,
        uid: int,
        real_session: Optional[str] = None,
        real_uid: Optional[int] = None,
        region_name: str = "DEMO",
    ):
        self.session = session
        self.uid = uid
        self.real_session = real_session or session
        self.real_uid = real_uid or uid
        self.region_name = region_name

        self._connected = False
        self._session_status: Literal["valid", "expired", "unknown"] = "unknown"
        self._last_message_at = 0.0
        self._subscribed_pairs: set[str] = set()

        self._balances: Dict[str, float] = {"demo": 0.0, "real": 0.0}
        self._assets_cache: Dict[str, AssetMetadata] = {}

        self._client = None
        self._candle_storage = None
        self._assets_storage = None
        self._deals_storage = None
        self._reconnect_task = None
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
            # Try matching enum attribute
            if hasattr(Asset, clean):
                return getattr(Asset, clean)
            return None

    async def connect(self) -> None:
        from pocket_option import PocketOptionClient
        from pocket_option.contrib.candles import MemoryCandleStorage
        from pocket_option.contrib.assets import MemoryAssetsStorage
        from pocket_option.contrib.deals import MemoryDealsStorage
        from pocket_option.models import AuthorizationData, SuccessUpdateBalanceEvent

        if not self.session or not self.uid:
            self._session_status = "expired"
            logger.warning("PO_SESSION or PO_UID not provided. Session marked as expired.")
            return

        self._running = True
        self._client = PocketOptionClient(logger=False, reconnection=True)
        self._candle_storage = MemoryCandleStorage(self._client)
        self._assets_storage = MemoryAssetsStorage(self._client)
        self._deals_storage = MemoryDealsStorage(self._client)

        # Register event callbacks
        @self._client.on.connect
        async def on_connect():
            logger.info("PocketOption WebSocket connected. Sending auth...")
            self._connected = True
            self._last_message_at = time.time()
            auth_data = AuthorizationData.model_validate({
                "session": self.session,
                "isDemo": 1,
                "uid": int(self.uid),
                "platform": 2,
                "isFastHistory": True,
                "isOptimized": True,
            })
            try:
                await self._client.send("auth", auth_data)
            except Exception as e:
                logger.error(f"Failed to send auth: {e}")

        @self._client.on.success_auth
        async def on_success_auth(event):
            logger.info("PocketOption auth successful.")
            self._session_status = "valid"
            self._last_message_at = time.time()
            # Request initial balance update
            try:
                await self._client.emit.update_balance()
            except Exception as e:
                logger.debug(f"Balance update request: {e}")

            # Re-subscribe to any previously active pairs
            if self._subscribed_pairs:
                await self.subscribe(list(self._subscribed_pairs))

        @self._client.on.disconnect
        async def on_disconnect():
            logger.warning("PocketOption WebSocket disconnected.")
            self._connected = False
            self._last_message_at = time.time()

        @self._client.on.balance_success_update
        async def on_balance_update(event: SuccessUpdateBalanceEvent):
            self._last_message_at = time.time()
            val = float(event.balance)
            if event.is_demo == 1:
                self._balances["demo"] = val
            else:
                self._balances["real"] = val

        @self._client.on.update_close_value
        async def on_update_close(items):
            self._last_message_at = time.time()

        # Connect to region
        region = self._get_region()
        logger.info(f"Connecting to PocketOption region {region}...")
        try:
            await self._client.connect(region)
            # Wait briefly for auth confirmation
            for _ in range(40):
                if self._session_status == "valid":
                    break
                await asyncio.sleep(0.1)
        except Exception as e:
            logger.error(f"Error during PocketOption connect: {e}")
            self._connected = False
            self._session_status = "unknown"

    async def disconnect(self) -> None:
        self._running = False
        if self._client:
            try:
                await self._client.disconnect()
            except Exception as e:
                logger.debug(f"Error during disconnect: {e}")
        self._connected = False
        self._session_status = "unknown"

    def is_connected(self) -> bool:
        return self._connected

    def get_session_status(self) -> Literal["valid", "expired", "unknown"]:
        return self._session_status

    def get_last_message_at(self) -> float:
        return self._last_message_at

    async def subscribe(self, pairs: list[str]) -> None:
        if not self._client or not self._connected:
            self._subscribed_pairs.update(pairs)
            return

        for p in pairs:
            self._subscribed_pairs.add(p)
            asset_enum = self._get_asset_enum(p)
            if asset_enum:
                try:
                    await self._client.emit.subscribe_to_asset(asset_enum)
                except Exception as e:
                    logger.debug(f"Subscribe error for {p}: {e}")

    async def get_candles(self, pair: str, n: int = 100) -> list[CandleData]:
        if not self._candle_storage:
            return []

        asset_enum = self._get_asset_enum(pair)
        if not asset_enum:
            return []

        # Pocket Option SDK CandleStorage builds candles in timeframe buckets
        try:
            candles = await self._candle_storage.get_candles(asset_enum, timeframe=60, count=n + 5)
        except Exception as e:
            logger.error(f"Error getting candles for {pair}: {e}")
            return []

        # STRICT RULE: Expose closed candles only.
        # Any bucket matching or exceeding the current minute bucket is still in-progress.
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
        if not self._assets_storage:
            return []

        try:
            items = await self._assets_storage.get_assets()
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

    async def get_balance(self, account: Literal["demo", "real"]) -> float:
        if self._client and self._connected:
            try:
                await self._client.emit.update_balance()
            except Exception:
                pass
        return self._balances.get(account, 0.0)

    async def place_order(
        self,
        pair: str,
        direction: Literal["CALL", "PUT"],
        stake: float,
        expiry_secs: int,
        account: Literal["demo", "real"] = "demo",
    ) -> OrderResult:
        if not self._client or not self._connected:
            raise RuntimeError("PocketOption client is not connected")
        if self._session_status != "valid":
            raise RuntimeError(f"PocketOption session is not valid ({self._session_status})")

        from pocket_option.models import DealAction
        asset_enum = self._get_asset_enum(pair)
        if not asset_enum:
            raise ValueError(f"Unknown asset identifier: {pair}")

        deal_action = DealAction.CALL if direction.upper() == "CALL" else DealAction.PUT
        is_demo_val = 1 if account.lower() == "demo" else 0

        # Execute deal via SDK deals storage
        sent_time = int(time.time())
        try:
            deal = await self._deals_storage.open_deal(
                asset=asset_enum,
                amount=stake,
                action=deal_action,
                time=expiry_secs,
                is_demo=is_demo_val,
                option_type=100,
                check_limits=True,
            )
        except Exception as e:
            logger.error(f"Broker rejected deal: {e}")
            raise RuntimeError(f"Broker order rejection: {e}")

        # Fetch payout for asset
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
        if not self._deals_storage:
            raise RuntimeError("Deals storage not initialized")

        total_wait = expiry_secs + timeout_secs
        try:
            closed_deal = await self._deals_storage.check_deal_result(
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

        # Determine result strictly from broker response
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
