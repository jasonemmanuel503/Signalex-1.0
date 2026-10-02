"""
SIGNALEX V10 — Candle Store (SQLite)
Owned solely by the Python backend process.
Stores 1-minute closed candles in data/candles.db.
"""

import os
import sqlite3
import threading
from typing import List, Dict, Optional, Any

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
DB_PATH = os.path.join(DATA_DIR, "candles.db")

_local = threading.local()

def _get_connection() -> sqlite3.Connection:
    if not hasattr(_local, "conn") or _local.conn is None:
        os.makedirs(DATA_DIR, exist_ok=True)
        conn = sqlite3.connect(DB_PATH, timeout=30.0, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode = WAL;")
        conn.execute("PRAGMA synchronous = NORMAL;")
        _local.conn = conn
    return _local.conn

def init_db():
    conn = _get_connection()
    with conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS candles (
                pair TEXT NOT NULL,
                epoch INTEGER NOT NULL,
                open REAL NOT NULL,
                high REAL NOT NULL,
                low REAL NOT NULL,
                close REAL NOT NULL,
                volume REAL DEFAULT 0,
                PRIMARY KEY(pair, epoch)
            );
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_candles_pair_epoch ON candles(pair, epoch);")

def save_candles(pair: str, candles: List[Dict[str, Any]]) -> int:
    if not candles:
        return 0
    conn = _get_connection()
    rows = []
    for c in candles:
        epoch = int(c.get("epoch") or c.get("time") or 0)
        if epoch <= 0:
            continue
        o = float(c.get("open") or 0.0)
        h = float(c.get("high") or 0.0)
        l = float(c.get("low") or 0.0)
        cl = float(c.get("close") or 0.0)
        vol = float(c.get("volume") or 0.0) if c.get("volume") is not None else 0.0
        rows.append((pair, epoch, o, h, l, cl, vol))

    if not rows:
        return 0

    with conn:
        conn.executemany("""
            INSERT OR REPLACE INTO candles (pair, epoch, open, high, low, close, volume)
            VALUES (?, ?, ?, ?, ?, ?, ?);
        """, rows)
    return len(rows)

def get_candles(pair: str, limit: int = 500, before_epoch: Optional[int] = None) -> List[Dict[str, Any]]:
    conn = _get_connection()
    if before_epoch is not None:
        cursor = conn.execute("""
            SELECT epoch, open, high, low, close, volume
            FROM candles
            WHERE pair = ? AND epoch < ?
            ORDER BY epoch DESC
            LIMIT ?;
        """, (pair, before_epoch, limit))
    else:
        cursor = conn.execute("""
            SELECT epoch, open, high, low, close, volume
            FROM candles
            WHERE pair = ?
            ORDER BY epoch DESC
            LIMIT ?;
        """, (pair, limit))
    rows = cursor.fetchall()
    # Return chronologically ascending (oldest first)
    result = []
    for r in reversed(rows):
        result.append({
            "epoch": r["epoch"],
            "time": r["epoch"],
            "open": r["open"],
            "high": r["high"],
            "low": r["low"],
            "close": r["close"],
            "volume": r["volume"]
        })
    return result

def get_latest_epoch(pair: str) -> Optional[int]:
    conn = _get_connection()
    cursor = conn.execute("SELECT MAX(epoch) as max_epoch FROM candles WHERE pair = ?;", (pair,))
    row = cursor.fetchone()
    if row and row["max_epoch"] is not None:
        return int(row["max_epoch"])
    return None

def count_candles(pair: str) -> int:
    conn = _get_connection()
    cursor = conn.execute("SELECT COUNT(*) as cnt FROM candles WHERE pair = ?;", (pair,))
    row = cursor.fetchone()
    return int(row["cnt"]) if row else 0

init_db()
