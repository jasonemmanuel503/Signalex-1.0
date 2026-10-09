// ═══════════════════════════════════════════════════════════════════════════════
// SIGNALEX V10 — Unified Data Repository Layer
// Replaces sqlite-shim.js with Supabase + Asynchronous Non-Blocking Outbox.
// Maintains 100% backward compatibility with all lib/db.js exported signatures.
// ═══════════════════════════════════════════════════════════════════════════════

import { getSupabaseAdmin, isSupabaseConfigured } from "./supabaseClient.js";
import outbox from "./outbox.js";

// Fast in-memory state store for zero-latency engine reads
const memoryState = {
  trades: new Map(),
  signals: new Map(),
  journal: new Map(),
  tierPerformance: {
    A: { wins: 0, losses: 0, uses: 0, updated_at: Date.now() },
    B: { wins: 0, losses: 0, uses: 0, updated_at: Date.now() },
    C: { wins: 0, losses: 0, uses: 0, updated_at: Date.now() },
  },
  sessionLogs: [],
  marketConditions: [],
  killSwitchLogs: [],
  preSessions: new Map(),
  appState: new Map(),
  pendingConfirmations: new Map(),
  auditLogs: [],
  appSettings: {
    id: 1,
    mode: "OFF",
    account: "demo",
    trading_paused: false,
    pause_reason: null,
    loss_streak_limit: 3,
    max_stake: 25.0,
    stake_mode: "fixed",
    stake_value: 10.0,
    max_trades_per_day: 30,
    daily_loss_limit: 100.0,
    min_payout_pct: 80,
    min_tier_for_auto: "B",
    max_signal_age_secs: 3,
    max_data_age_secs: 120,
    trading_hours_filter: "off",
    updated_at: new Date().toISOString(),
  },
};

// Warm in-memory cache from Supabase on module load
(async function initCacheFromSupabase() {
  if (!isSupabaseConfigured) return;
  const sb = getSupabaseAdmin();
  if (!sb) return;

  try {
    const { data: settings } = await sb.from("app_settings").select("*").eq("id", 1).maybeSingle();
    if (settings) {
      memoryState.appSettings = { ...memoryState.appSettings, ...settings };
    }

    const { data: trades } = await sb.from("trades").select("*").order("closed_at", { ascending: false }).limit(200);
    if (trades) {
      for (const t of trades) memoryState.trades.set(t.id, t);
    }

    const { data: tiers } = await sb.from("tier_performance").select("*");
    if (tiers) {
      for (const tp of tiers) {
        if (memoryState.tierPerformance[tp.tier]) {
          memoryState.tierPerformance[tp.tier] = tp;
        }
      }
    }

    const { data: stateRows } = await sb.from("app_state").select("*");
    if (stateRows) {
      for (const r of stateRows) memoryState.appState.set(r.key, r.value);
    }
  } catch (err) {
    console.warn("[Repository] Supabase cache warm-up error:", err.message);
  }
})();

// ── App Settings ─────────────────────────────────────────────────────────────
export function getAppSettings() {
  return { ...memoryState.appSettings };
}

export function updateAppSettings(patch) {
  memoryState.appSettings = {
    ...memoryState.appSettings,
    ...patch,
    updated_at: new Date().toISOString(),
  };
  outbox.enqueue("settings:update", memoryState.appSettings);
  return { ...memoryState.appSettings };
}

// ── Trades & History ─────────────────────────────────────────────────────────
export function saveTrade(trade) {
  if (!trade || !trade.id) return false;
  const row = {
    id: trade.id,
    signal_id: trade.signalId || trade.signal_id || null,
    account: trade.account || "demo",
    source: trade.source || "auto",
    pair: trade.pair,
    market: trade.market || (trade.pair.includes("_otc") ? "otc" : "forex"),
    direction: trade.direction,
    stake: Number(trade.positionSize || trade.stake || 10.0),
    payout_pct: Number(trade.payout_pct || 85),
    expiry_secs: Number(trade.expirySecs || trade.expiry_secs || 60),
    signal_price: trade.signalPrice != null ? Number(trade.signalPrice) : null,
    entry_price: trade.entryPrice != null ? Number(trade.entryPrice) : null,
    exit_price: trade.exitPrice != null ? Number(trade.exitPrice) : null,
    po_deal_id: trade.poDealId || trade.po_deal_id || null,
    result: trade.result || null,
    profit: trade.profit != null ? Number(trade.profit) : null,
    result_source: trade.resultSource || trade.result_source || "broker",
    shadow_result: trade.shadowResult || trade.shadow_result || null,
    signal_time: trade.signalTime || new Date().toISOString(),
    sent_at: trade.entryTimestamp ? new Date(trade.entryTimestamp).toISOString() : new Date().toISOString(),
    confirmed_at: trade.confirmed_at || null,
    closed_at: trade.expiryTimestamp ? new Date(trade.expiryTimestamp).toISOString() : null,
    latency_ms: trade.latency_ms || null,
    slippage: trade.slippage || null,
    session_label: trade.session || trade.session_label || null,
    tier: trade.signalTier || trade.tier || null,
  };

  memoryState.trades.set(row.id, row);
  outbox.enqueue("trades:insert", row);
  return true;
}

export function updateTradeResultDb(id, result, exitPrice = null) {
  const existing = memoryState.trades.get(id);
  if (!existing) return false;

  existing.result = result;
  if (exitPrice !== null) existing.exit_price = Number(exitPrice);
  existing.closed_at = new Date().toISOString();

  // Compute profit if not set
  if (result === "WIN") {
    existing.profit = Number((existing.stake * (existing.payout_pct / 100)).toFixed(2));
  } else if (result === "LOSS") {
    existing.profit = -Number(existing.stake);
  } else if (result === "TIE") {
    existing.profit = 0.0;
  }

  outbox.enqueue("trades:update", {
    id,
    result,
    exit_price: existing.exit_price,
    profit: existing.profit,
    closed_at: existing.closed_at,
  });
  return true;
}

export function getTradeHistory(limit = 200) {
  const all = Array.from(memoryState.trades.values());
  all.sort((a, b) => new Date(b.sent_at || 0) - new Date(a.sent_at || 0));
  return all.slice(0, limit);
}

export function getWinRateByTier() {
  const stats = { A: { wins: 0, total: 0 }, B: { wins: 0, total: 0 }, C: { wins: 0, total: 0 } };
  for (const t of memoryState.trades.values()) {
    const tier = t.tier || "B";
    if (!stats[tier]) stats[tier] = { wins: 0, total: 0 };
    if (t.result === "WIN") {
      stats[tier].wins += 1;
      stats[tier].total += 1;
    } else if (t.result === "LOSS") {
      stats[tier].total += 1;
    }
  }

  const result = {};
  for (const [tier, data] of Object.entries(stats)) {
    result[tier] = data.total > 0 ? Number(((data.wins / data.total) * 100).toFixed(1)) : null;
  }
  return result;
}

export function getStats() {
  let wins = 0;
  let losses = 0;
  let totalProfit = 0;

  for (const t of memoryState.trades.values()) {
    if (t.result === "WIN") {
      wins += 1;
      totalProfit += Number(t.profit || 0);
    } else if (t.result === "LOSS") {
      losses += 1;
      totalProfit += Number(t.profit || 0);
    }
  }

  const total = wins + losses;
  const winRate = total > 0 ? Number(((wins / total) * 100).toFixed(1)) : 0;

  return {
    wins,
    losses,
    total,
    winRate,
    netProfit: Number(totalProfit.toFixed(2)),
  };
}

// ── Signals ──────────────────────────────────────────────────────────────────
export function saveSignal(signal) {
  if (!signal || !signal.id) return false;
  const row = {
    id: signal.id,
    pair: signal.pair,
    market: signal.market || (signal.pair.includes("_otc") ? "otc" : "forex"),
    price_source: signal.price_source || "po",
    direction: signal.direction,
    confidence: signal.confidence || 0,
    tier: signal.tier || "B",
    quality_score: signal.quality_score || signal.marketQualityScore || 50,
    strategy: signal.strategy || signal.strategyUsed || null,
    expiry_secs: signal.expiry_secs || 60,
    session_label: signal.session || signal.session_label || null,
    status: signal.status || "NEW",
    created_at: signal.created_at || new Date().toISOString(),
  };

  memoryState.signals.set(row.id, row);
  outbox.enqueue("signals:insert", row);
  return true;
}

export function updateSignalResult(id, result) {
  const s = memoryState.signals.get(id);
  if (!s) return false;
  s.status = result;
  outbox.enqueue("signals:update", { id, status: result });
  return true;
}

export function updateSignalStatus(id, status, extraFields = {}) {
  const s = memoryState.signals.get(id);
  if (!s) return false;
  s.status = status;
  Object.assign(s, extraFields);
  outbox.enqueue("signals:update", { id, status, ...extraFields });
  return true;
}

export function getSignals(limit = 100, sessionKey = null) {
  const all = Array.from(memoryState.signals.values());
  const filtered = sessionKey ? all.filter((s) => s.session_label === sessionKey) : all;
  filtered.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return filtered.slice(0, limit);
}

export function getSignalById(id) {
  return memoryState.signals.get(id) || null;
}

// ── Market Conditions & Kill Switch Logs ─────────────────────────────────────
export function logMarketCondition(pair, state, riskType, confidence, reason) {
  const entry = {
    pair,
    state,
    risk_type: riskType,
    confidence,
    reason,
    logged_at: new Date().toISOString(),
  };
  memoryState.marketConditions.unshift(entry);
  if (memoryState.marketConditions.length > 500) memoryState.marketConditions.pop();
  outbox.enqueue("market_condition:insert", entry);
}

export function getRecentConditions(pair = null, limit = 50) {
  if (pair) {
    return memoryState.marketConditions.filter((c) => c.pair === pair).slice(0, limit);
  }
  return memoryState.marketConditions.slice(0, limit);
}

export function logKillSwitch(pair, reason, pauseMs) {
  const entry = {
    pair,
    reason,
    pause_ms: pauseMs,
    logged_at: new Date().toISOString(),
  };
  memoryState.killSwitchLogs.unshift(entry);
  if (memoryState.killSwitchLogs.length > 200) memoryState.killSwitchLogs.pop();
  outbox.enqueue("kill_switch:insert", entry);
}

// ── Tier Performance ─────────────────────────────────────────────────────────
export function loadTierPerformance() {
  return JSON.parse(JSON.stringify(memoryState.tierPerformance));
}

export function saveTierPerformance(tierPerformance) {
  if (!tierPerformance) return;
  for (const [tier, data] of Object.entries(tierPerformance)) {
    if (memoryState.tierPerformance[tier]) {
      memoryState.tierPerformance[tier] = {
        tier,
        wins: data.wins || 0,
        losses: data.losses || 0,
        uses: data.uses || 0,
        updated_at: new Date().toISOString(),
      };
      outbox.enqueue("tier_performance:upsert", memoryState.tierPerformance[tier]);
    }
  }
}

// ── Session Logs ─────────────────────────────────────────────────────────────
export function saveSessionLog(sessionLog) {
  if (!sessionLog) return;
  const entry = {
    session_key: sessionLog.session_key || null,
    wins: sessionLog.wins || 0,
    losses: sessionLog.losses || 0,
    total: sessionLog.total || 0,
    accuracy: sessionLog.accuracy || 0.0,
    started_at: sessionLog.started_at ? new Date(sessionLog.started_at).toISOString() : null,
    ended_at: sessionLog.ended_at ? new Date(sessionLog.ended_at).toISOString() : null,
  };
  memoryState.sessionLogs.unshift(entry);
  outbox.enqueue("session_log:insert", entry);
}

export function loadSessionHistory(limit = 100) {
  return memoryState.sessionLogs.slice(0, limit);
}

export function loadLatestSessionLog() {
  return memoryState.sessionLogs[0] || null;
}

export function clearSessionHistory() {
  memoryState.sessionLogs = [];
}

// ── Journal Functions ────────────────────────────────────────────────────────
export function recordSignalInJournal(signal) {
  if (!signal || !signal.id) return false;
  const row = {
    signal_id: signal.id,
    pair: signal.pair,
    direction: signal.direction,
    tier: signal.tier || "B",
    session_label: signal.session || signal.session_label || null,
    strategy: signal.strategy || null,
    entered: false,
    entry_time: null,
    entry_price: null,
    payout_pct: signal.payout_pct || 85,
    stake: signal.stake || 10.0,
    result: null,
    exit_price: null,
    shadow_result: null,
    notes: null,
    created_at: new Date().toISOString(),
  };
  memoryState.journal.set(signal.id, row);
  return true;
}

export function markJournalEntered(signal_id, { entry_time, entry_price, payout_pct, stake, notes } = {}) {
  const row = memoryState.journal.get(signal_id);
  if (!row) return false;
  row.entered = true;
  if (entry_time) row.entry_time = entry_time;
  if (entry_price != null) row.entry_price = Number(entry_price);
  if (payout_pct != null) row.payout_pct = Number(payout_pct);
  if (stake != null) row.stake = Number(stake);
  if (notes) row.notes = notes;
  return true;
}

export function updateJournalResult(signal_id, result, { entry_price, exit_price, notes } = {}) {
  const row = memoryState.journal.get(signal_id);
  if (!row) return false;
  row.result = result;
  if (entry_price != null) row.entry_price = Number(entry_price);
  if (exit_price != null) row.exit_price = Number(exit_price);
  if (notes) row.notes = notes;
  return true;
}

export function updateJournalShadowResult(signal_id, shadow_result) {
  const row = memoryState.journal.get(signal_id);
  if (!row) return false;
  row.shadow_result = shadow_result;
  return true;
}

export function getJournalRow(signal_id) {
  return memoryState.journal.get(signal_id) || null;
}

export function getJournalHistory(limit = 100) {
  const all = Array.from(memoryState.journal.values());
  all.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return all.slice(0, limit);
}

export function getSessionJournalStats(session_start_ms = 0) {
  let wins = 0;
  let losses = 0;
  for (const j of memoryState.journal.values()) {
    if (new Date(j.created_at).getTime() >= session_start_ms) {
      if (j.result === "WIN") wins += 1;
      else if (j.result === "LOSS") losses += 1;
    }
  }
  const total = wins + losses;
  return {
    wins,
    losses,
    total,
    winRate: total > 0 ? Number(((wins / total) * 100).toFixed(1)) : 0,
  };
}

// ── Pre-Session Storage ──────────────────────────────────────────────────────
export function savePreSessionRecord(data) {
  memoryState.preSessions.set(`${data.sessionKey}_${data.sessionDate}`, data);
  outbox.enqueue("pre_session:upsert", {
    session_key: data.sessionKey,
    session_date: data.sessionDate,
    selected_pairs: JSON.stringify(data.selectedPairs || []),
    backup_pairs: JSON.stringify(data.backupPairs || []),
    scores_json: JSON.stringify(data.scores || []),
    triggered_at: data.triggeredAt,
    trigger_type: data.triggerType || "auto",
    telegram_sent: data.telegramSent ? 1 : 0,
    gmt1_hour: data.gmt1Hour,
    gmt1_minute: data.gmt1Minute,
  });
}

export function loadPreSessionRecord(sessionKey, sessionDate) {
  return memoryState.preSessions.get(`${sessionKey}_${sessionDate}`) || null;
}

export function markPreSessionTelegramSent(sessionKey, sessionDate) {
  const rec = memoryState.preSessions.get(`${sessionKey}_${sessionDate}`);
  if (rec) {
    rec.telegramSent = true;
    savePreSessionRecord(rec);
  }
}

export function getPreSessionHistoryRecords(limit = 20) {
  const list = Array.from(memoryState.preSessions.values());
  list.sort((a, b) => new Date(b.triggeredAt || 0) - new Date(a.triggeredAt || 0));
  return list.slice(0, limit);
}

// ── App State (Key-Value) ────────────────────────────────────────────────────
export function getAppState(key, defaultValue = null) {
  if (memoryState.appState.has(key)) {
    try {
      return JSON.parse(memoryState.appState.get(key));
    } catch {
      return memoryState.appState.get(key);
    }
  }
  return defaultValue;
}

export function setAppState(key, value) {
  const str = typeof value === "string" ? value : JSON.stringify(value);
  memoryState.appState.set(key, str);
  outbox.enqueue("app_state:upsert", { key, value: str, updated_at: new Date().toISOString() });
}

export function clearAppState(key) {
  memoryState.appState.delete(key);
}

// ── Pending Confirmations (SEMI Mode) ────────────────────────────────────────
export function createPendingConfirmation(signal_id, payload, ttlSecs = 20) {
  const id = `conf_${Date.now()}_${signal_id}`;
  const row = {
    id,
    signal_id,
    payload,
    expires_at: new Date(Date.now() + ttlSecs * 1000).toISOString(),
    state: "pending",
    created_at: new Date().toISOString(),
  };
  memoryState.pendingConfirmations.set(id, row);
  outbox.enqueue("pending_confirmation:upsert", row);
  return row;
}

export function getPendingConfirmations(state = "pending") {
  const now = Date.now();
  const list = [];
  for (const conf of memoryState.pendingConfirmations.values()) {
    if (conf.state === "pending" && new Date(conf.expires_at).getTime() <= now) {
      conf.state = "expired";
      outbox.enqueue("pending_confirmation:upsert", conf);
    }
    if (!state || conf.state === state) {
      list.push(conf);
    }
  }
  return list;
}

export function updatePendingConfirmationState(id, newState) {
  const conf = memoryState.pendingConfirmations.get(id);
  if (!conf) return false;
  conf.state = newState;
  outbox.enqueue("pending_confirmation:upsert", conf);
  return true;
}

// ── Audit Log ────────────────────────────────────────────────────────────────
export function writeAuditLog(actor, action, details = {}) {
  const entry = {
    at: new Date().toISOString(),
    actor,
    action,
    details,
  };
  memoryState.auditLogs.unshift(entry);
  if (memoryState.auditLogs.length > 500) memoryState.auditLogs.pop();
  outbox.enqueue("audit:insert", entry);
}

export function getAuditLogs(limit = 50) {
  return memoryState.auditLogs.slice(0, limit);
}

// ── DB Interface Compatibility Default Export ────────────────────────────────
export const db = {
  saveTrade,
  updateTradeResultDb,
  getTradeHistory,
  getWinRateByTier,
  getStats,
  saveSignal,
  updateSignalResult,
  updateSignalStatus,
  getSignals,
  getSignalById,
  logMarketCondition,
  getRecentConditions,
  logKillSwitch,
  loadTierPerformance,
  saveTierPerformance,
  saveSessionLog,
  loadSessionHistory,
  loadLatestSessionLog,
  clearSessionHistory,
  recordSignalInJournal,
  markJournalEntered,
  updateJournalResult,
  updateJournalShadowResult,
  getJournalRow,
  getJournalHistory,
  getSessionJournalStats,
  getAppState,
  setAppState,
  clearAppState,
  getAppSettings,
  updateAppSettings,
  writeAuditLog,
  getAuditLogs,
};

export default db;
