from __future__ import annotations
from abc import ABC, abstractmethod
from typing import Literal, Optional
from pydantic import BaseModel

class AssetMetadata(BaseModel):
    pair: str
    asset_id: Optional[int] = None
    label: str
    is_otc: bool
    open: bool
    payout_pct: int
    min_expiration: int = 60
    default_expiration: int = 60
    digits: int = 5

class CandleData(BaseModel):
    timestamp: int  # Unix timestamp in seconds (start of the 1-minute candle bucket)
    open: float
    high: float
    low: float
    close: float
    volume: int = 0
    is_closed: bool = True

class PriceUpdate(BaseModel):
    pair: str
    price: float
    timestamp: int
    age_seconds: float

class OrderResult(BaseModel):
    deal_id: str
    pair: str
    account: Literal["demo", "real"]
    direction: Literal["CALL", "PUT"]
    stake: float
    payout_pct: int
    entry_price: float
    exit_price: Optional[float] = None
    open_time: int
    close_time: Optional[int] = None
    status: Literal["OPEN", "WIN", "LOSS", "TIE", "UNCONFIRMED", "REJECTED"]
    profit: Optional[float] = None
    result_source: Literal["broker", "unconfirmed", "simulated"] = "broker"
    raw_response: Optional[dict] = None

class PocketOptionAdapter(ABC):
    @abstractmethod
    async def connect(self) -> None:
        """Connect to Pocket Option and authenticate."""
        pass

    @abstractmethod
    async def disconnect(self) -> None:
        """Disconnect client."""
        pass

    @abstractmethod
    def is_connected(self) -> bool:
        """Return True if connection is alive."""
        pass

    @abstractmethod
    def get_session_status(self) -> Literal["valid", "expired", "unknown"]:
        """Return session authentication status."""
        pass

    @abstractmethod
    def get_last_message_at(self) -> float:
        """Return unix timestamp of last received message."""
        pass

    @abstractmethod
    async def subscribe(self, pairs: list[str]) -> None:
        """Subscribe to real-time streams for given pairs."""
        pass

    @abstractmethod
    async def get_candles(self, pair: str, n: int = 100) -> list[CandleData]:
        """Return closed 1-minute candles only."""
        pass

    @abstractmethod
    async def get_latest_price(self, pair: str) -> Optional[PriceUpdate]:
        """Return the latest closed candle summary with age in seconds."""
        pass

    @abstractmethod
    async def get_assets(self) -> list[AssetMetadata]:
        """Return tradable assets with availability, payout, and OTC flags."""
        pass

    @abstractmethod
    async def get_balance(self, account: Literal["demo", "real"]) -> float:
        """Return account balance."""
        pass

    @abstractmethod
    async def place_order(
        self,
        pair: str,
        direction: Literal["CALL", "PUT"],
        stake: float,
        expiry_secs: int,
        account: Literal["demo", "real"] = "demo",
    ) -> OrderResult:
        """Place order with broker and confirm deal acceptance."""
        pass

    @abstractmethod
    async def track_order_result(
        self,
        deal_id: str,
        expiry_secs: int,
        timeout_secs: int = 90,
    ) -> OrderResult:
        """Watch deal until close and return final result."""
        pass
