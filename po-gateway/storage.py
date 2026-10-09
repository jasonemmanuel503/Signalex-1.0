from __future__ import annotations
import os
import time
import aiosqlite
from typing import Optional, List
try:
    from .adapter_interface import CandleData, OrderResult
except ImportError:
    from adapter_interface import CandleData, OrderResult

class LocalStorage:
    def __init__(self, data_dir: str = "../data"):
        self.data_dir = os.path.abspath(data_dir)
        os.makedirs(self.data_dir, exist_ok=True)
        self.candles_db_path = os.path.join(self.data_dir, "po_candles.db")
        self.orders_db_path = os.path.join(self.data_dir, "po_orders.db")

    async def init_db(self):
        # 1. Candles DB
        async with aiosqlite.connect(self.candles_db_path) as db:
            await db.execute("PRAGMA journal_mode = WAL")
            await db.execute("""
                CREATE TABLE IF NOT EXISTS po_candles (
                    pair TEXT NOT NULL,
                    timestamp INTEGER NOT NULL,
                    open REAL NOT NULL,
                    high REAL NOT NULL,
                    low REAL NOT NULL,
                    close REAL NOT NULL,
                    volume INTEGER DEFAULT 0,
                    created_at INTEGER NOT NULL,
                    PRIMARY KEY (pair, timestamp)
                )
            """)
            await db.execute("CREATE INDEX IF NOT EXISTS idx_candles_pair_ts ON po_candles (pair, timestamp DESC)")
            await db.commit()

        # 2. Orders DB
        async with aiosqlite.connect(self.orders_db_path) as db:
            await db.execute("PRAGMA journal_mode = WAL")
            await db.execute("""
                CREATE TABLE IF NOT EXISTS po_orders (
                    idempotency_key TEXT PRIMARY KEY,
                    deal_id TEXT,
                    signal_id TEXT,
                    account TEXT NOT NULL,
                    pair TEXT NOT NULL,
                    direction TEXT NOT NULL,
                    stake REAL NOT NULL,
                    payout_pct INTEGER NOT NULL,
                    expiry_secs INTEGER NOT NULL,
                    signal_price REAL,
                    entry_price REAL,
                    exit_price REAL,
                    status TEXT NOT NULL,
                    result TEXT,
                    profit REAL,
                    result_source TEXT DEFAULT 'broker',
                    sent_at INTEGER NOT NULL,
                    confirmed_at INTEGER,
                    closed_at INTEGER,
                    latency_ms INTEGER,
                    slippage REAL,
                    error_message TEXT
                )
            """)
            await db.execute("CREATE INDEX IF NOT EXISTS idx_orders_deal_id ON po_orders (deal_id)")
            await db.execute("CREATE INDEX IF NOT EXISTS idx_orders_status ON po_orders (status)")
            await db.commit()

    # ── Candles Storage Methods ──────────────────────────────────────────────
    async def save_candle(self, pair: str, candle: CandleData):
        now = int(time.time())
        async with aiosqlite.connect(self.candles_db_path) as db:
            await db.execute("""
                INSERT INTO po_candles (pair, timestamp, open, high, low, close, volume, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(pair, timestamp) DO UPDATE SET
                    open=excluded.open,
                    high=excluded.high,
                    low=excluded.low,
                    close=excluded.close,
                    volume=excluded.volume
            """, (pair, candle.timestamp, candle.open, candle.high, candle.low, candle.close, candle.volume, now))
            await db.commit()

    async def save_candles_bulk(self, pair: str, candles: List[CandleData]):
        if not candles:
            return
        now = int(time.time())
        rows = [
            (pair, c.timestamp, c.open, c.high, c.low, c.close, c.volume, now)
            for c in candles
        ]
        async with aiosqlite.connect(self.candles_db_path) as db:
            await db.executemany("""
                INSERT INTO po_candles (pair, timestamp, open, high, low, close, volume, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(pair, timestamp) DO UPDATE SET
                    open=excluded.open,
                    high=excluded.high,
                    low=excluded.low,
                    close=excluded.close,
                    volume=excluded.volume
            """, rows)
            await db.commit()

    async def get_candles(self, pair: str, n: int = 100) -> List[CandleData]:
        async with aiosqlite.connect(self.candles_db_path) as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute("""
                SELECT timestamp, open, high, low, close, volume
                FROM po_candles
                WHERE pair = ?
                ORDER BY timestamp DESC
                LIMIT ?
            """, (pair, n))
            rows = await cursor.fetchall()
            # Return in chronological order
            candles = [
                CandleData(
                    timestamp=r["timestamp"],
                    open=r["open"],
                    high=r["high"],
                    low=r["low"],
                    close=r["close"],
                    volume=r["volume"],
                    is_closed=True
                )
                for r in reversed(rows)
            ]
            return candles

    async def purge_old_candles(self, retention_days: int = 14):
        cutoff = int(time.time()) - (retention_days * 86400)
        async with aiosqlite.connect(self.candles_db_path) as db:
            await db.execute("DELETE FROM po_candles WHERE timestamp < ?", (cutoff,))
            await db.commit()

    # ── Orders Ledger Storage Methods ─────────────────────────────────────────
    async def get_order_by_idempotency_key(self, key: str) -> Optional[dict]:
        async with aiosqlite.connect(self.orders_db_path) as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute("SELECT * FROM po_orders WHERE idempotency_key = ?", (key,))
            row = await cursor.fetchone()
            return dict(row) if row else None

    async def get_order_by_deal_id(self, deal_id: str) -> Optional[dict]:
        async with aiosqlite.connect(self.orders_db_path) as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute("SELECT * FROM po_orders WHERE deal_id = ?", (deal_id,))
            row = await cursor.fetchone()
            return dict(row) if row else None

    async def record_pending_order(
        self,
        idempotency_key: str,
        account: str,
        pair: str,
        direction: str,
        stake: float,
        expiry_secs: int,
        payout_pct: int,
        signal_id: Optional[str] = None,
        signal_price: Optional[float] = None,
    ) -> bool:
        """Insert order record before sending. Returns False if idempotency key already exists."""
        now = int(time.time() * 1000)
        try:
            async with aiosqlite.connect(self.orders_db_path) as db:
                await db.execute("""
                    INSERT INTO po_orders (
                        idempotency_key, signal_id, account, pair, direction,
                        stake, payout_pct, expiry_secs, signal_price, status, sent_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)
                """, (
                    idempotency_key, signal_id or idempotency_key, account, pair,
                    direction, stake, payout_pct, expiry_secs, signal_price, now
                ))
                await db.commit()
                return True
        except aiosqlite.IntegrityError:
            return False

    async def mark_order_confirmed(
        self,
        idempotency_key: str,
        deal_id: str,
        entry_price: float,
        payout_pct: int,
        latency_ms: Optional[int] = None,
        slippage: Optional[float] = None,
    ):
        now = int(time.time() * 1000)
        async with aiosqlite.connect(self.orders_db_path) as db:
            await db.execute("""
                UPDATE po_orders
                SET deal_id = ?, entry_price = ?, payout_pct = ?,
                    status = 'OPEN', confirmed_at = ?, latency_ms = ?, slippage = ?
                WHERE idempotency_key = ?
            """, (deal_id, entry_price, payout_pct, now, latency_ms, slippage, idempotency_key))
            await db.commit()

    async def mark_order_result(
        self,
        deal_id: str,
        result: str,
        exit_price: Optional[float],
        profit: Optional[float],
        result_source: str = "broker",
    ):
        now = int(time.time() * 1000)
        async with aiosqlite.connect(self.orders_db_path) as db:
            await db.execute("""
                UPDATE po_orders
                SET status = 'CLOSED', result = ?, exit_price = ?, profit = ?,
                    result_source = ?, closed_at = ?
                WHERE deal_id = ?
            """, (result, exit_price, profit, result_source, now, deal_id))
            await db.commit()

    async def mark_order_failed(self, idempotency_key: str, error_message: str):
        async with aiosqlite.connect(self.orders_db_path) as db:
            await db.execute("""
                UPDATE po_orders
                SET status = 'REJECTED', error_message = ?
                WHERE idempotency_key = ?
            """, (error_message, idempotency_key))
            await db.commit()

    async def get_active_orders_count(self) -> int:
        async with aiosqlite.connect(self.orders_db_path) as db:
            cursor = await db.execute("SELECT COUNT(*) FROM po_orders WHERE status IN ('PENDING', 'OPEN')")
            row = await cursor.fetchone()
            return row[0] if row else 0

    async def get_unresolved_open_orders(self) -> List[dict]:
        async with aiosqlite.connect(self.orders_db_path) as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute("SELECT * FROM po_orders WHERE status = 'OPEN'")
            rows = await cursor.fetchall()
            return [dict(r) for r in rows]
