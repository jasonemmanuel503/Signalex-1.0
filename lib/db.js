// ═══════════════════════════════════════════════════════════════════════════════
// SIGNALEX V9.0 — SQLite Persistence Layer
// ═══════════════════════════════════════════════════════════════════════════════
// V9.0 ADDITIONS (per audit spec P1-P4):
//   signals table     — per-signal tracking (PRIMARY/SECONDARY, PENDING/SENT/EXPIRED)
//   stats endpoint    — dynamic win/loss/accuracy from trades table
//   session labels    — every signal carries its session key
//   pre_session table — already existed; kept intact
// ═══════════════════════════════════════════════════════════════════════════════

import Database from "./sqlite-shim.js";
import path     from "path";
import fs       from "fs";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH  = path.join(DATA_DIR, "signalex.db");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let db = null;
try {
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    -- ── Existing tables (unchanged) ──────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS trades (
      id                  TEXT PRIMARY KEY,
      pair                TEXT,
      direction           TEXT,
      confidence          INTEGER,
      signalTier          TEXT,
      marketPhase         TEXT,
      marketQualityScore  INTEGER,
      volatilityTier      TEXT,
      expiry              TEXT,
      expirySecs          INTEGER,
      strategyUsed        TEXT,
      result              TEXT,
      entryPrice          REAL,
      exitPrice           REAL,
      positionSize        REAL,
      entryTimestamp      INTEGER,
      expiryTimestamp     INTEGER,
      session             TEXT
    );
    CREATE TABLE IF NOT EXISTS tier_performance (
      tier        TEXT PRIMARY KEY,
      wins        INTEGER DEFAULT 0,
      losses      INTEGER DEFAULT 0,
      uses        INTEGER DEFAULT 0,
      updated_at  INTEGER
    );
    INSERT OR IGNORE INTO tier_performance (tier, wins, losses, uses, updated_at)
    VALUES ('A', 0, 0, 0, 0), ('B', 0, 0, 0, 0), ('C', 0, 0, 0, 0);
    CREATE TABLE IF NOT EXISTS session_log (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      session_key        TEXT,
      wins               INTEGER DEFAULT 0,
      losses             INTEGER DEFAULT 0,
      total              INTEGER DEFAULT 0,
      win_rate           REAL,
      started_at         TEXT UNIQUE,
      saved_at           TEXT,
      consecutive_losses INTEGER DEFAULT 0,
      trades_json        TEXT DEFAULT '[]'
    );

    -- ── V9.0: Per-signal tracking table (P2) ─────────────────────────────────
    -- Each detected signal is stored independently.
    -- PRIMARY = sent to Telegram, tracked, win/loss assigned.
    -- SECONDARY = displayed in UI, opt-in only, never auto-assigned result.
    CREATE TABLE IF NOT EXISTS signals (
      id           TEXT PRIMARY KEY,
      pair         TEXT NOT NULL,
      direction    TEXT NOT NULL,
      confidence   INTEGER NOT NULL,
      type         TEXT NOT NULL DEFAULT 'PRIMARY',
      status       TEXT NOT NULL DEFAULT 'PENDING',
      result       TEXT,
      session      TEXT NOT NULL DEFAULT 'UNKNOWN_SESSION',
      signal_tier  TEXT,
      market_phase TEXT,
      quality_score INTEGER,
      expiry       TEXT,
      expiry_secs  INTEGER,
      strategy     TEXT,
      created_at   INTEGER NOT NULL,
      sent_at      INTEGER,
      expired_at   INTEGER,
      executed_at  INTEGER,
      notes        TEXT
    );

    -- ── V9.0: Market condition log (P6/P8) ───────────────────────────────────
    CREATE TABLE IF NOT EXISTS market_condition_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      pair        TEXT NOT NULL,
      state       TEXT NOT NULL,
      risk_type   TEXT DEFAULT 'NONE',
      confidence  REAL,
      reason      TEXT,
      logged_at   INTEGER NOT NULL
    );

    -- ── V9.0: Kill switch pause log (P8) ─────────────────────────────────────
    CREATE TABLE IF NOT EXISTS kill_switch_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      pair        TEXT,
      reason      TEXT NOT NULL,
      paused_at   INTEGER NOT NULL,
      resume_at   INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL
    );
  `);
  console.log("[db] SQLite V9.0 initialized at", DB_PATH);
} catch (err) {
  console.error("[db] FATAL: SQLite failed to initialize:", err.message);
  console.error("[db] Run: npm install   to rebuild native binaries.");
  db = null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TRADES
// ═══════════════════════════════════════════════════════════════════════════════

export function saveTrade(trade) {
  if (!db) return;
  try {
    db.prepare(`
      INSERT OR REPLACE INTO trades
        (id, pair, direction, confidence, signalTier, marketPhase,
         marketQualityScore, volatilityTier, expiry, expirySecs, strategyUsed,
         result, entryPrice, exitPrice, positionSize,
         entryTimestamp, expiryTimestamp, session)
      VALUES
        (@id, @pair, @direction, @confidence, @signalTier, @marketPhase,
         @marketQualityScore, @volatilityTier, @expiry, @expirySecs, @strategyUsed,
         @result, @entryPrice, @exitPrice, @positionSize,
         @entryTimestamp, @expiryTimestamp, @session)
    `).run({
      id:                 trade.id                 ?? null,
      pair:               trade.pair               ?? null,
      direction:          trade.direction           ?? null,
      confidence:         trade.confidence          ?? null,
      signalTier:         trade.signalTier          ?? null,
      marketPhase:        trade.marketPhase         ?? null,
      marketQualityScore: trade.marketQualityScore  ?? null,
      volatilityTier:     trade.volatilityTier      ?? null,
      expiry:             trade.expiry              ?? null,
      expirySecs:         trade.expirySecs          ?? null,
      strategyUsed:       trade.strategyUsed        ?? null,
      result:             trade.result              ?? null,
      entryPrice:         trade.entryPrice          ?? null,
      exitPrice:          trade.exitPrice           ?? null,
      positionSize:       trade.positionSize        ?? null,
      entryTimestamp:     trade.entryTimestamp      ?? null,
      expiryTimestamp:    trade.expiryTimestamp     ?? null,
      session:            trade.session             ?? null,
    });
  } catch (err) {
    console.error("[db] saveTrade error:", err.message);
  }
}

export function updateTradeResultDb(id, result, exitPrice = null) {
  if (!db) return;
  try {
    db.prepare("UPDATE trades SET result = ?, exitPrice = ? WHERE id = ?")
      .run(result, exitPrice, id);
  } catch (err) {
    console.error("[db] updateTradeResultDb error:", err.message);
  }
}

export function getTradeHistory(limit = 200) {
  if (!db) return [];
  try {
    return db.prepare("SELECT * FROM trades ORDER BY entryTimestamp DESC LIMIT ?").all(limit);
  } catch (err) {
    return [];
  }
}

export function getWinRateByTier() {
  if (!db) return [];
  try {
    return db.prepare(`
      SELECT signalTier,
             COUNT(*) AS total,
             SUM(CASE WHEN result = 'WIN' THEN 1 ELSE 0 END) AS wins,
             ROUND(100.0 * SUM(CASE WHEN result = 'WIN' THEN 1 ELSE 0 END) / COUNT(*), 1) AS winRate
      FROM trades WHERE result IS NOT NULL GROUP BY signalTier
    `).all();
  } catch (err) {
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATS (P3) — computed dynamically from trades table
// ═══════════════════════════════════════════════════════════════════════════════

export function getStats() {
  if (!db) return { total: 0, wins: 0, losses: 0, accuracy: 0, bySession: [], byPair: [] };
  try {
    const overall = db.prepare(`
      SELECT
        COUNT(*)                                                      AS total,
        SUM(CASE WHEN result = 'WIN'  THEN 1 ELSE 0 END)             AS wins,
        SUM(CASE WHEN result = 'LOSS' THEN 1 ELSE 0 END)             AS losses,
        ROUND(100.0 * SUM(CASE WHEN result = 'WIN' THEN 1 ELSE 0 END)
              / NULLIF(COUNT(*), 0), 1)                              AS accuracy
      FROM trades WHERE result IS NOT NULL
    `).get();

    const bySession = db.prepare(`
      SELECT session,
             COUNT(*) AS total,
             SUM(CASE WHEN result = 'WIN' THEN 1 ELSE 0 END) AS wins,
             ROUND(100.0 * SUM(CASE WHEN result = 'WIN' THEN 1 ELSE 0 END)
                   / NULLIF(COUNT(*), 0), 1) AS accuracy
      FROM trades WHERE result IS NOT NULL GROUP BY session ORDER BY total DESC
    `).all();

    const byPair = db.prepare(`
      SELECT pair,
             COUNT(*) AS total,
             SUM(CASE WHEN result = 'WIN' THEN 1 ELSE 0 END) AS wins,
             ROUND(100.0 * SUM(CASE WHEN result = 'WIN' THEN 1 ELSE 0 END)
                   / NULLIF(COUNT(*), 0), 1) AS accuracy
      FROM trades WHERE result IS NOT NULL GROUP BY pair ORDER BY total DESC LIMIT 20
    `).all();

    return {
      total:    overall?.total    ?? 0,
      wins:     overall?.wins     ?? 0,
      losses:   overall?.losses   ?? 0,
      accuracy: overall?.accuracy ?? 0,
      bySession,
      byPair,
    };
  } catch (err) {
    console.error("[db] getStats error:", err.message);
    return { total: 0, wins: 0, losses: 0, accuracy: 0, bySession: [], byPair: [] };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SIGNALS TABLE (P2) — per-signal independent tracking
// ═══════════════════════════════════════════════════════════════════════════════

export function saveSignal(signal) {
  if (!db) return;
  try {
    db.prepare(`
      INSERT OR REPLACE INTO signals
        (id, pair, direction, confidence, type, status, result, session,
         signal_tier, market_phase, quality_score, expiry, expiry_secs,
         strategy, created_at, sent_at, expired_at, executed_at, notes)
      VALUES
        (@id, @pair, @direction, @confidence, @type, @status, @result, @session,
         @signal_tier, @market_phase, @quality_score, @expiry, @expiry_secs,
         @strategy, @created_at, @sent_at, @expired_at, @executed_at, @notes)
    `).run({
      id:            signal.id            ?? null,
      pair:          signal.pair          ?? null,
      direction:     signal.direction     ?? null,
      confidence:    signal.confidence    ?? null,
      type:          signal.type          ?? "PRIMARY",
      status:        signal.status        ?? "PENDING",
      result:        signal.result        ?? null,
      session:       signal.session       ?? "UNKNOWN_SESSION",
      signal_tier:   signal.signalTier    ?? null,
      market_phase:  signal.marketPhase   ?? null,
      quality_score: signal.qualityScore  ?? null,
      expiry:        signal.expiry        ?? null,
      expiry_secs:   signal.expirySecs    ?? null,
      strategy:      signal.strategy      ?? null,
      created_at:    signal.createdAt     ?? Date.now(),
      sent_at:       signal.sentAt        ?? null,
      expired_at:    signal.expiredAt     ?? null,
      executed_at:   signal.executedAt    ?? null,
      notes:         signal.notes         ?? null,
    });
    console.log(`[db] Signal saved: ${signal.type} ${signal.pair} ${signal.direction} [${signal.status}]`);
  } catch (err) {
    console.error("[db] saveSignal error:", err.message);
  }
}

export function updateSignalResult(id, result) {
  if (!db) return;
  try {
    db.prepare("UPDATE signals SET result = ?, status = 'SENT' WHERE id = ? AND type = 'PRIMARY'")
      .run(result, id);
    console.log(`[db] Signal result updated: id=${id} result=${result}`);
  } catch (err) {
    console.error("[db] updateSignalResult error:", err.message);
  }
}

export function updateSignalStatus(id, status, extraFields = {}) {
  if (!db) return;
  try {
    const fields = ["status = ?"];
    const vals   = [status];
    if (extraFields.executedAt) { fields.push("executed_at = ?"); vals.push(extraFields.executedAt); }
    if (extraFields.sentAt)     { fields.push("sent_at = ?");     vals.push(extraFields.sentAt);     }
    if (extraFields.expiredAt)  { fields.push("expired_at = ?");  vals.push(extraFields.expiredAt);  }
    vals.push(id);
    db.prepare(`UPDATE signals SET ${fields.join(", ")} WHERE id = ?`).run(...vals);
  } catch (err) {
    console.error("[db] updateSignalStatus error:", err.message);
  }
}

export function getSignals(limit = 100, sessionKey = null) {
  if (!db) return [];
  try {
    if (sessionKey) {
      return db.prepare(
        "SELECT * FROM signals WHERE session = ? ORDER BY created_at DESC LIMIT ?"
      ).all(sessionKey, limit);
    }
    return db.prepare("SELECT * FROM signals ORDER BY created_at DESC LIMIT ?").all(limit);
  } catch (err) {
    return [];
  }
}

export function getSignalById(id) {
  if (!db) return null;
  try {
    return db.prepare("SELECT * FROM signals WHERE id = ?").get(id) ?? null;
  } catch (err) {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MARKET CONDITION LOG (P6/P8)
// ═══════════════════════════════════════════════════════════════════════════════

export function logMarketCondition(pair, state, riskType, confidence, reason) {
  if (!db) return;
  try {
    db.prepare(`
      INSERT INTO market_condition_log (pair, state, risk_type, confidence, reason, logged_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(pair, state, riskType ?? "NONE", confidence ?? null, reason ?? null, Date.now());
  } catch (err) {
    console.error("[db] logMarketCondition error:", err.message);
  }
}

export function getRecentConditions(pair = null, limit = 50) {
  if (!db) return [];
  try {
    if (pair) {
      return db.prepare(
        "SELECT * FROM market_condition_log WHERE pair = ? ORDER BY logged_at DESC LIMIT ?"
      ).all(pair, limit);
    }
    return db.prepare(
      "SELECT * FROM market_condition_log ORDER BY logged_at DESC LIMIT ?"
    ).all(limit);
  } catch (err) {
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// KILL SWITCH LOG (P8)
// ═══════════════════════════════════════════════════════════════════════════════

export function logKillSwitch(pair, reason, pauseMs) {
  if (!db) return;
  try {
    const now = Date.now();
    db.prepare(`
      INSERT INTO kill_switch_log (pair, reason, paused_at, resume_at, duration_ms)
      VALUES (?, ?, ?, ?, ?)
    `).run(pair ?? "ALL", reason, now, now + pauseMs, pauseMs);
    console.log(`[db] Kill switch logged: ${pair ?? "ALL"} paused ${pauseMs / 60000}min — ${reason}`);
  } catch (err) {
    console.error("[db] logKillSwitch error:", err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TIER PERFORMANCE
// ═══════════════════════════════════════════════════════════════════════════════

const _emptyTiers = () => ({
  A: { wins: 0, losses: 0, uses: 0 },
  B: { wins: 0, losses: 0, uses: 0 },
  C: { wins: 0, losses: 0, uses: 0 },
});

export function loadTierPerformance() {
  if (!db) return _emptyTiers();
  try {
    const rows = db.prepare("SELECT * FROM tier_performance").all();
    return rows.reduce((acc, row) => {
      acc[row.tier] = { wins: row.wins, losses: row.losses, uses: row.uses };
      return acc;
    }, {});
  } catch (err) {
    return _emptyTiers();
  }
}

export function saveTierPerformance(tierPerformance) {
  if (!db) return;
  try {
    const stmt = db.prepare(`
      UPDATE tier_performance
      SET wins = @wins, losses = @losses, uses = @uses, updated_at = @now
      WHERE tier = @tier
    `);
    const updateAll = db.transaction((tp) => {
      for (const [tier, data] of Object.entries(tp)) {
        stmt.run({ tier, wins: data.wins, losses: data.losses, uses: data.uses, now: Date.now() });
      }
    });
    updateAll(tierPerformance);
  } catch (err) {
    console.error("[db] saveTierPerformance error:", err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SESSION LOG
// ═══════════════════════════════════════════════════════════════════════════════

export function saveSessionLog(sessionLog) {
  if (!db) return;
  try {
    const winRate = sessionLog.total > 0
      ? parseFloat(((sessionLog.wins / sessionLog.total) * 100).toFixed(1))
      : null;
    const existing = db.prepare("SELECT id FROM session_log WHERE started_at = ?").get(sessionLog.startedAt);
    if (existing) {
      db.prepare(`
        UPDATE session_log
        SET wins = ?, losses = ?, total = ?, win_rate = ?,
            saved_at = ?, consecutive_losses = ?, trades_json = ?, session_key = ?
        WHERE started_at = ?
      `).run(
        sessionLog.wins, sessionLog.losses, sessionLog.total, winRate,
        new Date().toISOString(), sessionLog.consecutiveLosses ?? 0,
        JSON.stringify(sessionLog.trades || []),
        sessionLog.sessionKey ?? "UNKNOWN", sessionLog.startedAt,
      );
    } else {
      db.prepare(`
        INSERT INTO session_log
          (session_key, wins, losses, total, win_rate, started_at, saved_at,
           consecutive_losses, trades_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        sessionLog.sessionKey ?? "UNKNOWN",
        sessionLog.wins, sessionLog.losses, sessionLog.total, winRate,
        sessionLog.startedAt, new Date().toISOString(),
        sessionLog.consecutiveLosses ?? 0,
        JSON.stringify(sessionLog.trades || []),
      );
    }
  } catch (err) {
    console.error("[db] saveSessionLog error:", err.message);
  }
}

function _rowToSession(row) {
  return {
    startedAt:         row.started_at,
    savedAt:           row.saved_at,
    sessionKey:        row.session_key,
    wins:              row.wins,
    losses:            row.losses,
    total:             row.total,
    winRate:           row.win_rate != null ? String(row.win_rate) : null,
    consecutiveLosses: row.consecutive_losses ?? 0,
    trades: (() => { try { return JSON.parse(row.trades_json || "[]"); } catch { return []; } })(),
  };
}

export function loadSessionHistory(limit = 100) {
  if (!db) return [];
  try {
    return db.prepare("SELECT * FROM session_log ORDER BY id DESC LIMIT ?")
      .all(limit).map(_rowToSession);
  } catch (err) {
    return [];
  }
}

export function loadLatestSessionLog() {
  if (!db) return null;
  try {
    const row = db.prepare("SELECT * FROM session_log ORDER BY id DESC LIMIT 1").get();
    return row ? _rowToSession(row) : null;
  } catch (err) {
    return null;
  }
}

export function clearSessionHistory() {
  if (!db) return;
  try {
    db.prepare("DELETE FROM session_log").run();
    console.log("[db] Session history cleared");
  } catch (err) {
    console.error("[db] clearSessionHistory error:", err.message);
  }
}

export default db;
