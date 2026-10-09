// SIGNALEX V8.0 — SIGNAL ENGINE
// SIGNALEX V8.0 — SIGNAL THROUGHPUT PATCH
// ═══════════════════════════════════════════════════════════════════════════════
//
// ROOT CAUSE: Engine produced < 3 signals per London/NY session because 7 filter
// layers were each individually miscalibrated for 1-minute binary options data.
// Compounded together they created near-total silence even in active markets.
//
// [FIX A] isChoppy: 0.005 → 0.002   — normal 1m consolidation was CHAOTIC
// [FIX B] TRENDING scoreDiff: 3→2, 2→1 — real forex rarely stacks 3+ points
// [FIX C] entryPrecision weight: 20pt → 10pt — one wicky candle was a veto
// [FIX D] HTF hard block → only when htfTrendStrong (slope > 15% EMA range)
// [FIX E] RANGING zone: 25/75% → 35/65% — tight zone rarely hit on 1m
// [FIX F] RANGE_CONFIRMATION_MINIMUM: 2 → 1 — score=1 passes as Tier C
// [FIX G] Bias skip: only when trendStrength=2, not just TRENDING phase
//
// All V7.0.4.1 fixes preserved. Architecture unchanged.
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// SIGNALEX V7.0.4.1 — BUG FIX PATCH
// ═══════════════════════════════════════════════════════════════════════════════
//
//  [FIX 1] REAL MULTI-TIMEFRAME CONFIRMATION  (confirmMultiTimeframe)
//      BUG: Previous "HTF" used EMA200 on the same 1m dataset and compared
//           it to itself 10 candles ago — this is NOT a higher timeframe.
//           The "LTF RSI" was computed from only 6 candles — statistically
//           meaningless and highly noise-sensitive.
//      FIX: resampleTo5m() groups every 5 consecutive 1m candles into a real
//           5m OHLC bar (~40 bars from the 200 candles already in memory).
//           HTF: EMA20 on 5m bars — slope + price-above-EMA determines 5m trend.
//           LTF: Proper 14-period RSI on full 1m dataset for entry timing.
//           Zero extra API calls. Genuine higher-timeframe structure.
//
//  [FIX 2] OTC AUTO WIN/LOSS DETECTION  (scheduleOutcomeCheck)
//      BUG: OTC pairs were silently skipped — the function returned early for
//           any marketType !== "forex". The adaptive learning layer never
//           received real outcome data for OTC trades, which are the primary
//           market traded. The SQLite tier performance was therefore only
//           ever updated from forex trades.
//      FIX: OTC pairs shadow real forex rates. Strip " OTC" suffix and fetch
//           the underlying forex price from the Python backend at expiry+5s.
//           Same WIN/LOSS logic applies. Adaptive learning now works for ALL
//           trade types. Manual PATCH remains available as a fallback.
//
//  [FIX 3] EV MODEL CIRCULAR DEPENDENCY  (calcExpectedValue)
//      BUG: Win probability was computed from weightedScore + confidence,
//           both of which are derived from the same RSI/MACD/BB values.
//           The EV number looked mathematical but added no independent
//           evidence — it amplified existing signals and called it a
//           probability. This is a circular dependency.
//      FIX: When SQLite has >=5 real trades for a tier, the actual observed
//           win rate is used as a Bayesian prior and blended with the
//           indicator estimate. Blend weight ramps from 0→100% as trade
//           count grows from 5→25. After ~2 weeks of trading, the EV model
//           becomes genuinely data-driven. The reason string now shows
//           "[blended w/ XX% real win rate]" vs "[indicator-only]" so you
//           can see exactly which mode is active.
//
//  [FIX 4] STOOQ SYNTHETIC CANDLE BLOCK  (POST handler)
//      BUG: When Stooq was the last-resort source, the engine synthesised 60
//           fake 1m candles by linearly interpolating from a single hourly
//           bar. Signals generated on this fabricated price action looked
//           real but were based on invented data. No guard existed.
//      FIX: Pairs sourced from Stooq are now stripped from allPricePairs
//           before analysis begins. They are logged as warnings. A pair with
//           no real data simply does not participate in that scan cycle.
//
// ═══════════════════════════════════════════════════════════════════════════════

import { NextResponse } from "next/server";
import {
  saveTrade,
  updateTradeResultDb,
  loadTierPerformance,
  saveTierPerformance,
  getTradeHistory,
  getWinRateByTier,
  saveSessionLog,
  loadLatestSessionLog,
  loadSessionHistory,
  clearSessionHistory,
  saveSignal,            // V9.0 P2 — per-signal tracking
  updateSignalResult,    // V9.0 P2
  updateSignalStatus,    // V9.0 P2
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
} from "../../../lib/db.js";
import { isNewsBlackout, getUpcomingEvents, forceNewsRefresh, isNewsBlackoutExtended, addDynamicBlackout, detectVolatilitySpike } from "../../../lib/newsFilter.js";
import {
  getPreSelectedPairs,
  storePreScan,
  startScheduler,
  getCurrentSessionKey,
  SESSION_DEFS as PRE_SESSION_DEFS,
} from "../../../lib/preSessionScheduler.js";
// V9.0 — Pre-filter modules (P6, P8, P10) — act as guards only, never modify signal logic
import { classifyAll, shouldBlock } from "../../../lib/marketCondition.js";
import { forecastAll, getCachedForecast, getLastFullRunAge } from "../../../lib/marketForecast.js";
import { evaluateAndPause, isPaused, pauseRemainingMs, getPauseStatus, clearAllPauses } from "../../../lib/killSwitch.js";
import { resolveAllMarketData, calcBreakEven } from "../../../lib/trading/priceResolver.js";
import { scheduleShadowEvaluation } from "../../../lib/trading/shadowEvaluator.js";
import { orchestrator } from "../../../lib/trading/orchestrator.js";

// ─── Self-start the pre-session scheduler on first request (guarded) ──────────
if (!globalThis.__signalex_scheduler_started) {
  globalThis.__signalex_scheduler_started = true;
  startScheduler();
}

// ─── V9.0 P10: 30-minute market forecast background loop ──────────────────────
// Runs independently of signal requests. Populates forecast cache so
// every signal request has fresh market intelligence available.
// Fire-and-forget — never blocks the signal engine.
let _forecastLoopStarted = false;
function startForecastLoop() {
  if (_forecastLoopStarted) return;
  _forecastLoopStarted = true;
  const INTERVAL_MS = 30 * 60 * 1000;   // 30 minutes

  async function runForecastCycle() {
    try {
      const backendUrl = process.env.PYTHON_BACKEND_URL || "http://127.0.0.1:8001";
      const internalToken = process.env.INTERNAL_API_TOKEN || "dev_internal_token_signalex_2026";
      const res = await fetch(`${backendUrl}/prices`, {
        headers: { "X-Internal-Token": internalToken },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) { console.warn("[V9.0 forecast] Backend unavailable — skipping forecast cycle"); return; }
      const data  = await res.json();
      const pairs = (data.pairs || []).map((p) => ({ pair: p.pair, candles: p.candles || [] }));
      if (pairs.length === 0) return;
      await forecastAll(pairs);
      console.log(`[V9.0 forecast] 30-min cycle complete — ${pairs.length} pairs assessed`);
    } catch (err) {
      console.warn("[V9.0 forecast] Cycle error (non-fatal):", err.message);
    }
  }

  // Run immediately on startup, then every 30 min
  runForecastCycle();
  setInterval(runForecastCycle, INTERVAL_MS);
  console.log("[V9.0 forecast] Background 30-min forecast loop started");
}
startForecastLoop();

// ═══════════════════════════════════════════════════════════════════════════════
// SIGNALEX V6.5.6 — ADAPTIVE PROBABILISTIC TRADING SIGNAL ENGINE
// ═══════════════════════════════════════════════════════════════════════════════
//
// V6.5.6 UPGRADES (over V6.5.5):
//
//  [1] DYNAMIC ENTRY INSTRUCTION
//      PROBLEM: hardcoded "enter on the second candle" is wrong for 1m/2m expiries.
//      FIX: buildEntryInstruction() derives the correct instruction from
//           signal.entryWindow + signal.expiry. Each timeframe gets its own
//           accurate entry message. Engine-computed entryWindow takes priority.
//
//  [2] AUTO WIN/LOSS OUTCOME DETECTION
//      PROBLEM: PATCH endpoint required manual reporting — never consistently done
//               in live trading, starving the adaptive learning layer of real data.
//      FIX: scheduleOutcomeCheck() fires automatically after each signal.
//           At expirySecs + 5s buffer: fetches exit price from Python /price/:pair,
//           computes WIN/LOSS, updates tradeLog + tierPerformance + SQLite.
//           Forex only — OTC pairs gracefully fall back to manual PATCH.
//
//  [3] DYNAMIC POSITION SIZING
//      PROBLEM: static "1-2% of balance" ignores signal quality.
//      FIX: calcPositionSize() scales from tier (A=1.5x, B=1.0x, C=0.5x),
//           confidence (>=85 boost, <65 penalty), and EV win probability.
//           Hard cap 2.5%, hard floor 0.5%. Attached to signal object.
//           Telegram message updated to show dynamic sizing.
//
//  [4] SQLITE PERSISTENCE
//      PROBLEM: all adaptive learning wiped on server restart.
//      FIX: /lib/db.js (better-sqlite3) stores trades + tier_performance.
//           On startup: tierPerformance restored from DB — adaptive learning
//           continues from last state without interruption.
//           On logTrade(): saveTrade() writes to DB.
//           On updateTierPerformance(): saveTierPerformance() persists it.
//
//  [5] BACKEND-DOWN HARD ALERT
//      PROBLEM: Python backend failure silently fell through to demo data —
//               real signals were being generated on fake prices.
//      FIX: checkBackendHealth() runs first. If down: hard-blocked response,
//           no signals issued, no silent demo fallback.
//           Three-tier chain: Python → direct JS Yahoo fetch (2 pairs as check)
//           → HARD STOP with explicit error. Demo data no longer substituted.
//
//  All V6.5.5 fixes intact. Architecture preserved. No structural changes.
// ═══════════════════════════════════════════════════════════════════════════════
//
// V6.5.5 FIXES (over V6.5.4):
//
//  [1] GATE 8 — EVICTION LOOP (assembleSignals)
//      PROBLEM: evicted pairs with score < 65 OR isChoppy — fired on every single
//               cycle dip, could empty sessionPairs entirely → guaranteed silence.
//      FIX: raise eviction floor to < 50 (absolute unusable threshold only).
//           isChoppy alone no longer triggers eviction.
//           GUARD: never evict if it would leave sessionPairs empty.
//
//  [2] GATE 9 — FINAL QUALITY ASSERTION (double-gate)
//      PROBLEM: called getDynamicQualityThreshold() again after assembleSignals
//               already filtered by effectiveThresh — same threshold applied twice,
//               silently killing signals that already passed Gate 1 upstream.
//      FIX: final assertion now checks ONLY against SIGNAL_QUALITY_FLOOR (50).
//           Dynamic threshold enforcement stays exclusively in assembleSignals.
//
//  [3] LOSS PREVENTION — blockedThisCycle trigger removed
//      PROBLEM: "blockedThisCycle >= 5" locked the engine every cycle — blocking
//               pairs during a scan is NORMAL engine behavior, not an error signal.
//      FIX: remove that trigger entirely. Loss prevention now only activates on
//           genuinely poor EMITTED trade quality (4+ consecutive weak, avg < 50).
//           Lock durations reduced: 8 min → 5 min (weak signals), 10 min → 8 min.
//
//  [4] LOSS PREVENTION — confidence threshold calibrated
//      PROBLEM: confidence < 65 as "weak" was too broad for real forex.
//      FIX: threshold lowered to < 60. consecutiveWeak raised from 3 → 4.
//
//  All prior V6.5.4 fixes (hard/soft gate separation, MTF LTF demotion,
//  goodQuality 78→62, CV threshold 0.40→0.65, LTF RSI 55→65, EV fallback,
//  tier thresholds A:5→4 / B:3→2) remain fully intact.
// ═══════════════════════════════════════════════════════════════════════════════
//
//  [1] EXPECTED VALUE MODEL
//      — Win probability estimated from score + confluence
//      — Only positive-EV trades are allowed through
//      — Replaces sole reliance on raw score thresholds
//
//  [2] TIERED TRADE CLASSIFICATION (A / B / C)
//      A = High probability, strong confluence (full confidence)
//      B = Moderate probability, acceptable confluence (controlled trade)
//      C = Low probability but acceptable in strong market context (fallback)
//      — Tier C restricted to favorable conditions only; never auto-rejected
//      — Priority: A > B > C in signal selection
//
//  [3] CONTEXT-AWARE DECISION LOGIC
//      — Trending markets: allow slightly lower score trades
//      — Ranging markets: allow mean-reversion setups
//      — Choppy markets: reduce confidence instead of hard-reject
//      — High uncertainty: increase selectivity
//
//  [4] DYNAMIC ADAPTIVE THRESHOLDS
//      — High volatility: require higher confidence
//      — Medium volatility: moderate threshold
//      — Low volatility: lower threshold allowed (but expiry still blocks)
//
//  [5] ANTI-SILENCE MECHANISM
//      — Tracks time since last signal
//      — If quiet > 8 min → allow best Tier B trade
//      — If quiet > 15 min → allow best Tier C under safe conditions
//
//  [6] SMARTER REVALIDATION
//      — Only cancels on major structural change
//      — Minor confidence fluctuations pass through
//
//  [7] WEIGHTED SCORING MODEL (5 components)
//      trend_strength, structure_quality, entry_precision,
//      volume_confirmation, volatility_alignment
//
//  [8] ADAPTIVE LEARNING LAYER
//      — Win rate tracked per tier (A/B/C) per session
//      — Tier usage adjusted dynamically based on recent results
//      — Threshold refinement per market condition
//
//  All existing PROTECTED modules (waterfall, cache, ATR, HTF, confluence,
//  session clock, loss prevention) remain completely intact.
//  Architecture preserved — upgrades integrated as modular extensions.
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Config ───────────────────────────────────────────────────────────────────
const PYTHON_BACKEND = process.env.PYTHON_BACKEND_URL || "http://127.0.0.1:8001";
const VERSION = "7.0.4.2";

// ═══════════════════════════════════════════════════════════════════════════════
// BETA — EXECUTION CONTROLLER (ported from V4.1.2, adapted for V6.5.5)
// Handles: trade locking, win/loss tracking, persistent session log
// ═══════════════════════════════════════════════════════════════════════════════

if (!globalThis.__signalex_controller) {
  const savedLock = getAppState("active_trade", null);
  const isStopped = getAppState("session_stopped", false);
  globalThis.__signalex_controller = {
    activeTrade: savedLock?.locked ?? false,
    activeTradeExpiry: savedLock?.expiry ? new Date(savedLock.expiry) : null,
    sessionStopped: Boolean(isStopped),
    resultSentIds: new Set(),
  };
}
const _ctrl = globalThis.__signalex_controller;
let _activeTrade       = _ctrl.activeTrade;
let _activeTradeExpiry = _ctrl.activeTradeExpiry;
const _resultSentIds   = _ctrl.resultSentIds;

// FIX [4]: Restore session log from SQLite on startup (survives server restarts)
// FIX [17]: consecutiveLosses — stop trading after 2 losses in a row per session
let _sessionLog = (() => {
  try {
    const saved = loadLatestSessionLog();
    if (saved && saved.total > 0) {
      console.log(`[V9.0] Session log restored from DB: W${saved.wins} L${saved.losses} T${saved.total} (started ${saved.startedAt})`);
      return {
        wins:              saved.wins,
        losses:            saved.losses,
        total:             saved.total,
        startedAt:         saved.startedAt,
        sessionKey:        saved.sessionKey ?? null,
        trades:            saved.trades || [],
        consecutiveLosses: saved.consecutiveLosses ?? 0,
      };
    }
  } catch (err) {
    console.warn("[V9.0] Could not restore session log from DB:", err.message);
  }
  return { wins: 0, losses: 0, total: 0, startedAt: new Date().toISOString(), trades: [], consecutiveLosses: 0 };
})();

// FIX [17]: Stop-trade flag — set after 2 consecutive losses, cleared on session reset or win
let _sessionStopped = _ctrl.sessionStopped || (_sessionLog.consecutiveLosses >= 2);

function _isTradeActive() {
  const savedLock = getAppState("active_trade", null);
  if (savedLock && savedLock.expiry && Date.now() < new Date(savedLock.expiry).getTime()) {
    _activeTrade = true;
    _activeTradeExpiry = new Date(savedLock.expiry);
    _ctrl.activeTrade = true;
    _ctrl.activeTradeExpiry = _activeTradeExpiry;
    return true;
  }
  if (!_activeTrade || !_activeTradeExpiry) return false;
  if (Date.now() >= _activeTradeExpiry.getTime()) {
    // Expired — auto-clear lock
    _activeTrade       = false;
    _activeTradeExpiry = null;
    _ctrl.activeTrade = false;
    _ctrl.activeTradeExpiry = null;
    clearAppState("active_trade");
    return false;
  }
  return true;
}

function _parseExpiryMs(expiryStr) {
  if (!expiryStr) return 5 * 60 * 1000;
  const s = String(expiryStr).toLowerCase();
  const match = s.match(/([\d.]+)\s*(s|sec|m|min)/);
  if (!match) return 5 * 60 * 1000;
  const val  = parseFloat(match[1]);
  const unit = match[2];
  if (unit.startsWith("s")) return Math.round(val * 1000);
  return Math.round(val * 60 * 1000);
}

function _controllerState() {
  const secsLeft = _activeTrade && _activeTradeExpiry
    ? Math.max(0, Math.round((_activeTradeExpiry.getTime() - Date.now()) / 1000))
    : 0;
  const winRate  = _sessionLog.total > 0
    ? ((_sessionLog.wins / _sessionLog.total) * 100).toFixed(1)
    : null;
  return {
    activeTrade:            _activeTrade,
    activeTradeExpiresAt:   _activeTradeExpiry?.toISOString() ?? null,
    activeTradeSecondsLeft: secsLeft,
    sessionLog:             { ..._sessionLog, winRate },
    sessionStopped:         _sessionStopped,  // FIX [17]: stop after 2 consecutive losses
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// V6.2 — FOREX PAIR REGISTRY & MARKET PRIORITY
// ═══════════════════════════════════════════════════════════════════════════════

const FOREX_PAIR_IDS = new Set([
  "EUR/USD", "GBP/USD", "USD/JPY", "USD/CHF",
  "AUD/USD", "USD/CAD", "EUR/JPY", "GBP/JPY",
  "EUR/GBP", "AUD/JPY",
]);

const OTC_PAIR_IDS = new Set([
  "EUR/USD OTC", "GBP/USD OTC", "USD/JPY OTC", "AUD/USD OTC",
  "USD/CAD OTC", "EUR/GBP OTC", "NZD/USD OTC", "USD/CHF OTC",
]);

/** Returns "forex" | "otc" | "unknown" for a pair id */
function getMarketType(pairId) {
  if (FOREX_PAIR_IDS.has(pairId)) return "forex";
  if (OTC_PAIR_IDS.has(pairId))   return "otc";
  return "unknown";
}

/** Detect weekend (Saturday or Sunday) in UTC */
function isWeekend() {
  const day = new Date().getUTCDay();
  return day === 0 || day === 6;
}

// V6.3 UX STATUS MESSAGES — non-intrusive market state feedback per phase
const UX_MESSAGES = {
  CHAOTIC:        "Market structure unstable — waiting for clarity",
  LOW_VOLATILITY: "Market unfavorable — volatility too low to trade",
  RANGING:        "Scanning for high-quality range reversal setups",
  TRENDING:       "Scanning for high-quality trend continuation setups",
  OFF_HOURS:      "Outside active sessions — monitoring market quality",
};

// ─── V6.3: Strategy constants ─────────────────────────────────────────────────
const STRATEGY_NONE  = "NONE";
const STRATEGY_TREND = "TREND";
const STRATEGY_RANGE = "RANGE";

// Minimum Forex signal count before OTC is allowed as supplement (Task 3)
const FOREX_MIN_THRESHOLD = 1;

// ── V6.5.3: DYNAMIC QUALITY THRESHOLDS ───────────────────────────────────────
// BETA CALIBRATION: Thresholds further relaxed to stop blocking viable signals.
// Real forex rarely scores 72+ on every metric — these floors were too high.
const QUALITY_THRESHOLDS = {
  high:     62,   // V7.0.5: was 65 — high vol pairs slightly easier to pass
  medium:   52,   // V7.0.5: was 55
  low:      45,   // V7.0.5: was 48
};
const SIGNAL_QUALITY_FLOOR = 43;   // V7.0.5: was 45 — absolute minimum

// V6.5.3: Anti-silence timing — relaxed so Tier B is reachable (was 8/15 min)
const SILENCE_TIER_B_MS   = 2  * 60 * 1000;   // V7.0.5: was 3 min → 2 min — anti-silence unlocks faster
const SILENCE_TIER_C_MS   = 4  * 60 * 1000;   // V7.0.5: was 6 min → 4 min

// V6.5.6: Adaptive learning — restored from SQLite on startup (survives restarts)
let tierPerformance = (() => {
  try {
    const loaded = loadTierPerformance();
    // loadTierPerformance returns { A, B, C } — check if any real data exists
    const hasHistory = Object.values(loaded).some((t) => t.uses > 0);
    if (hasHistory) {
      console.log("[V6.5.6] Tier performance restored from SQLite:", JSON.stringify(loaded));
    }
    // Ensure all three tiers exist even if DB returned partial data
    return {
      A: loaded.A ?? { wins: 0, losses: 0, uses: 0 },
      B: loaded.B ?? { wins: 0, losses: 0, uses: 0 },
      C: loaded.C ?? { wins: 0, losses: 0, uses: 0 },
    };
  } catch (err) {
    console.warn("[V6.5.6] Could not restore tier performance from DB:", err.message);
    return {
      A: { wins: 0, losses: 0, uses: 0 },
      B: { wins: 0, losses: 0, uses: 0 },
      C: { wins: 0, losses: 0, uses: 0 },
    };
  }
})();
let lastSignalEmittedAt = 0;   // epoch ms — for anti-silence tracking

// [BUG1-FIX] Kill-switch evaluation throttle — run at most once per 60 seconds,
// not on every scan. Per-scan calls caused pause state to accumulate across scans,
// leaving all pairs locked with no UI feedback.
let _lastKillSwitchEvalAt = 0;
const KILL_SWITCH_EVAL_INTERVAL_MS = 60 * 1000; // 1 minute

// Legacy alias — still used in some helpers for backward compat (was 60, relaxed for beta)
const SIGNAL_QUALITY_THRESHOLD = 52;

// ═══════════════════════════════════════════════════════════════════════════════
// MODULE-LEVEL STATE
// ═══════════════════════════════════════════════════════════════════════════════

let sessionPairs         = [];
let backupPairs          = [];
let activePairs          = null;
let pairBias             = {};
let activeSessionKey     = null;
let lastRefreshTimestamp = null;
let preSessionExecuted   = false;
let sessionTradeCount    = 0;
let usedPairs            = {};
let lossPrevention       = { active: false, until: null, reason: "" };
let tradeLog             = [];

const REFRESH_INTERVAL_MS   = 25 * 60 * 1000;
// V8.0: Session-aware cooldown. Active sessions (London/NY) use 3 min.
// Low-vol sessions (Evening/Asian) use 2 min — pairs are fewer so faster
// recycling is needed to maintain signal throughput without dropping quality.
const PAIR_COOLDOWN_MS = (sessionKey) => {
  if (!sessionKey) return 3 * 60 * 1000;
  const key = sessionKey.replace("PRE_", "");
  return (key === "EVENING" || key === "ASIAN") ? 2 * 60 * 1000 : 3 * 60 * 1000;
};
const MAX_TRADES_PER_SESSION = 15;
const SESSION_GUARD_MINUTES  = 3;

// ═══════════════════════════════════════════════════════════════════════════════
// MATH UTILITIES  [PROTECTED]
// ═══════════════════════════════════════════════════════════════════════════════

function ema(data, period) {
  if (!data || data.length < period) return data || [];
  const k = 2 / (period + 1);
  let e = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const result = [e];
  for (let i = period; i < data.length; i++) {
    e = data[i] * k + e * (1 - k);
    result.push(e);
  }
  return result;
}

function stdDev(data) {
  if (!data || data.length === 0) return 0;
  const mean = data.reduce((a, b) => a + b, 0) / data.length;
  return Math.sqrt(data.reduce((s, v) => s + (v - mean) ** 2, 0) / data.length);
}

function last(arr) { return arr && arr.length > 0 ? arr[arr.length - 1] : 0; }
function prev(arr) { return arr && arr.length > 1 ? arr[arr.length - 2] : last(arr); }

// ═══════════════════════════════════════════════════════════════════════════════
// SESSION CLOCK  [PROTECTED]
// ═══════════════════════════════════════════════════════════════════════════════

function getGMT1Time() {
  const now      = new Date();
  const gmt1Hour = (now.getUTCHours() + 1) % 24;
  const gmt1Min  = now.getUTCMinutes();
  const t        = gmt1Hour + gmt1Min / 60;
  return { gmt1Hour, gmt1Min, t };
}

// V10.6 SESSION WINDOWS (GMT+1 — Cameroon / Central Africa Time)
// ─────────────────────────────────────────────────────────────────────────────
// All hours are in GMT+1 (UTC+1) — the timezone the app clock runs in.
// Real Forex market opens in GMT+1:
//   ASIAN:   03:00–09:00 GMT+1  (Tokyo open 03:00, Sydney overlap)
//   LONDON:  09:00–17:30 GMT+1  (London open 09:00 GMT+1 = 08:00 UTC)
//   NEWYORK: 14:30–21:00 GMT+1  (NY open 14:30 GMT+1 = 13:30 UTC)
//   EVENING: 20:00–23:00 GMT+1  (OTC trading window, post-NY)
//
// NOTE: Windows are intentionally scoped to the HIGH-LIQUIDITY overlap period
// within each session — not the full session duration — to concentrate signals
// on the most tradeable hours.
// ─────────────────────────────────────────────────────────────────────────────
const SESSION_DEFS = [
  { key: "ASIAN",   start: 3.0,   end: 9.0  },   // 03:00–09:00 GMT+1
  { key: "LONDON",  start: 9.0,   end: 13.0 },   // 09:00–13:00 GMT+1 (peak London liquidity)
  { key: "NEWYORK", start: 14.5,  end: 18.0 },   // 14:30–18:00 GMT+1 (NY open + London/NY overlap)
  { key: "EVENING", start: 20.0,  end: 23.0 },   // 20:00–23:00 GMT+1 (OTC evening)
];
const PRE_SESSION_WINDOW = 0.25;   // 15 min pre-session scan window

function deriveSessionKey(t) {
  for (const s of SESSION_DEFS) {
    if (t >= s.start && t < s.end) return s.key;
    if (t >= s.start - PRE_SESSION_WINDOW && t < s.start) return `PRE_${s.key}`;
  }
  return "OFF_HOURS";
}

function sameSessionGroup(keyA, keyB) {
  if (!keyA || !keyB) return false;
  const normalize = (k) => k.replace("PRE_", "");
  return normalize(keyA) === normalize(keyB);
}

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 1 — MARKET STRUCTURE  [PROTECTED]
// ═══════════════════════════════════════════════════════════════════════════════

function analyzeMarketStructure(prices) {
  const closes = prices.map((p) => p.close);
  const highs  = prices.map((p) => p.high);
  const lows   = prices.map((p) => p.low);
  const n      = closes.length;

  const ema50  = ema(closes, Math.min(50,  n - 1));
  const ema200 = ema(closes, Math.min(200, n - 1));
  const e50    = last(ema50);
  const e200   = last(ema200);
  const c      = last(closes);

  let trend = "sideways", trendStrength = 0;
  if      (e50 > e200 && c > e50)  { trend = "uptrend";   trendStrength = 2; }
  else if (e50 > e200)              { trend = "uptrend";   trendStrength = 1; }
  else if (e50 < e200 && c < e50)  { trend = "downtrend"; trendStrength = 2; }
  else if (e50 < e200)              { trend = "downtrend"; trendStrength = 1; }

  const lb         = Math.min(20, n);
  const resistance = Math.max(...highs.slice(-lb));
  const support    = Math.min(...lows.slice(-lb));
  const range      = resistance - support;
  const pricePos   = range > 0 ? (c - support) / range : 0.5;
  const nearSupport    = pricePos < 0.25;
  const nearResistance = pricePos > 0.75;

  const phSlice  = highs.slice(-lb - 5, -lb);
  const plSlice  = lows.slice(-lb - 5, -lb);
  const prevHigh = phSlice.length > 0 ? Math.max(...phSlice) : 0;
  const prevLow  = plSlice.length  > 0 ? Math.min(...plSlice) : 0;
  const breakoutUp   = prevHigh > 0 && c > prevHigh * 1.001;
  const breakoutDown = prevLow  > 0 && c < prevLow  * 0.999;

  let atrSum = 0;
  const atrLen = Math.min(14, n - 1);
  for (let i = n - atrLen; i < n; i++) {
    atrSum += Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i]  - closes[i - 1])
    );
  }
  const atr      = atrLen > 0 ? atrSum / atrLen : 0;
  const isChoppy = range > 0 && atr < range * 0.002;  // V7.0.4.2 [FIX A]: was 0.005 — fired on normal 1m consolidation, classifying ranging pairs as CHAOTIC

  return {
    trend, trendStrength,
    ema50: parseFloat(e50.toFixed(5)), ema200: parseFloat(e200.toFixed(5)),
    support: parseFloat(support.toFixed(5)), resistance: parseFloat(resistance.toFixed(5)),
    pricePos: parseFloat(pricePos.toFixed(3)),
    nearSupport, nearResistance, breakoutUp, breakoutDown, isChoppy,
    atr: parseFloat(atr.toFixed(6)),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 2 — CONFLUENCE INDICATORS  [PROTECTED]
// ═══════════════════════════════════════════════════════════════════════════════

function analyzeConfluence(prices) {
  const closes = prices.map((p) => p.close);
  const n      = closes.length;

  let gains = 0, losses = 0;
  const rsiLen = Math.min(14, n - 1);
  for (let i = n - rsiLen; i < n; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const ag  = rsiLen > 0 ? gains / rsiLen : 0;
  const al  = rsiLen > 0 ? losses / rsiLen : 0;
  const rsi = al === 0 ? 100 : 100 - 100 / (1 + ag / al);

  const rsiOversold   = rsi < 30;
  const rsiBullish    = rsi < 38;
  const rsiNeutral    = rsi >= 40 && rsi <= 60;
  const rsiBearish    = rsi > 62;
  const rsiOverbought = rsi > 70;

  const ema12    = ema(closes, 12);
  const ema26    = ema(closes, 26);
  const mLen     = Math.min(ema12.length, ema26.length);
  const macdLine = ema12.slice(-mLen).map((v, i) => v - ema26[ema26.length - mLen + i]);
  const sigLine  = ema(macdLine, 9);
  const macdVal  = last(macdLine);
  const sigVal   = last(sigLine);
  const hist     = macdVal - sigVal;
  const prevHist = prev(macdLine) - prev(sigLine);

  const macdCrossUp   = hist > 0 && prevHist <= 0;
  const macdCrossDown = hist < 0 && prevHist >= 0;
  const macdBullish   = hist > 0 && hist > prevHist;
  const macdBearish   = hist < 0 && hist < prevHist;

  const bb20    = closes.slice(-Math.min(20, n));
  const bbMid   = bb20.reduce((a, b) => a + b, 0) / bb20.length;
  const bbStd   = stdDev(bb20);
  const bbUpper = bbMid + 2 * bbStd;
  const bbLower = bbMid - 2 * bbStd;
  const bbPos   = bbUpper !== bbLower
    ? Math.max(0, Math.min(1, (last(closes) - bbLower) / (bbUpper - bbLower)))
    : 0.5;
  const bbWidth   = bbMid > 0 ? (bbUpper - bbLower) / bbMid : 0;
  const bbSqueeze = bbWidth < 0.0003;
  const bbBullish = bbPos < 0.2;
  const bbBearish = bbPos > 0.8;

  const fast9    = ema(closes, Math.min(9,  n - 1));
  const slow21   = ema(closes, Math.min(21, n - 1));
  const fastNow  = last(fast9);
  const fastPrev = fast9.length  > 1 ? prev(fast9)  : fastNow;
  const slowNow  = last(slow21);
  const slowPrev = slow21.length > 1 ? prev(slow21) : slowNow;
  const maCrossUp   = fastNow > slowNow && fastPrev <= slowPrev;
  const maCrossDown = fastNow < slowNow && fastPrev >= slowPrev;
  const maBullish   = fastNow > slowNow;
  const maBearish   = fastNow < slowNow;

  let bullScore = 0, bearScore = 0;
  if (rsiBullish)    bullScore += rsiOversold  ? 2 : 1;
  if (rsiBearish)    bearScore += rsiOverbought ? 2 : 1;
  if (macdBullish)   bullScore += macdCrossUp   ? 2 : 1;
  if (macdBearish)   bearScore += macdCrossDown  ? 2 : 1;
  if (bbBullish)     bullScore += 1;
  if (bbBearish)     bearScore += 1;
  if (maBullish)     bullScore += maCrossUp   ? 2 : 1;
  if (maBearish)     bearScore += maCrossDown  ? 2 : 1;
  if (rsiNeutral) {
    bullScore = Math.max(0, bullScore - 1);
    bearScore = Math.max(0, bearScore - 1);
  }

  return {
    rsi: parseFloat(rsi.toFixed(2)),
    rsiOversold, rsiBullish, rsiNeutral, rsiBearish, rsiOverbought,
    macd: parseFloat(macdVal.toFixed(6)), macdSignal: parseFloat(sigVal.toFixed(6)),
    macdHistogram: parseFloat(hist.toFixed(6)),
    macdBullish, macdBearish, macdCrossUp, macdCrossDown,
    bbPosition: parseFloat(bbPos.toFixed(3)),
    bbUpper: parseFloat(bbUpper.toFixed(5)), bbLower: parseFloat(bbLower.toFixed(5)),
    bbMid: parseFloat(bbMid.toFixed(5)), bbWidth: parseFloat(bbWidth.toFixed(5)),
    bbSqueeze, bbBullish, bbBearish,
    maBullish, maBearish, maCrossUp, maCrossDown,
    bullScore: Math.max(0, bullScore),
    bearScore: Math.max(0, bearScore),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 3 — VOLATILITY + SESSION  [PROTECTED]
// ═══════════════════════════════════════════════════════════════════════════════

function analyzeVolatilityAndSession(prices) {
  const closes = prices.map((p) => p.close);
  const highs  = prices.map((p) => p.high);
  const lows   = prices.map((p) => p.low);
  const n      = closes.length;

  let trSum = 0;
  const atrLen = Math.min(14, n - 1);
  for (let i = n - atrLen; i < n; i++) {
    trSum += Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i]  - closes[i - 1])
    );
  }
  const atr    = atrLen > 0 ? trSum / atrLen : 0;
  const lastPx = last(closes);
  const atrPct = lastPx > 0 ? (atr / lastPx) * 100 : 0;

  let volatility = "moderate";
  if (atrPct < 0.002) volatility = "low";
  if (atrPct > 0.08)  volatility = "high";

  const moves          = closes.slice(-5).map((c, i, arr) => i === 0 ? 0 : Math.abs(c - arr[i - 1]));
  const avgMove        = moves.reduce((a, b) => a + b, 0) / 5;
  const strongMomentum = atr > 0 && avgMove > atr * 0.8;

  const { t, gmt1Hour, gmt1Min } = getGMT1Time();
  const inAsian   = t >= 2.0  && t < 5.0;
  const inLondon  = t >= 8.0  && t < 12.0;
  const inNewYork = t >= 13.0 && t < 17.0;
  const inEvening = t >= 19.0 && t < 23.0;
  const inSession = inAsian || inLondon || inNewYork || inEvening;

  let sessionName = "OFF-HOURS";
  if      (inAsian)   sessionName = "ASIAN SESSION";
  else if (inEvening) sessionName = "EVENING SESSION";
  else if (inLondon)  sessionName = "LONDON SESSION";
  else if (inNewYork) sessionName = "NEW YORK SESSION";

  return {
    atr: parseFloat(atr.toFixed(6)), atrPercent: parseFloat(atrPct.toFixed(4)),
    volatility, strongMomentum,
    sessionName, inSession, inLondon, inNewYork, inEvening,
    gmt1Hour, gmt1Time: parseFloat(t.toFixed(2)),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MARKET PHASE CLASSIFICATION  [PROTECTED — extended in V6.2 with LOW_VOLATILITY]
// TRENDING | RANGING | CHAOTIC | LOW_VOLATILITY
// ═══════════════════════════════════════════════════════════════════════════════

function classifyMarketPhase(structure, confluence, volSession) {
  const { trendStrength, isChoppy } = structure;
  const { bbWidth, bullScore, bearScore, bbSqueeze } = confluence;

  const scoreDiff  = Math.abs(bullScore - bearScore);
  const totalScore = bullScore + bearScore;

  // LOW_VOLATILITY: BB squeeze + very low ATR → no tradeable movement
  // V8.0: Relaxed for EVENING/ASIAN sessions where low vol is NORMAL and
  // still produces clean range bounces. Only block if BOTH squeeze AND
  // ATR is critically low (not just "low" session label).
  const isLowVolSession = volSession && (volSession.inEvening || volSession.inAsian);
  if (bbSqueeze && volSession && volSession.volatility === "low" && !isLowVolSession)
    return "LOW_VOLATILITY";
  // During evening/asian: only block on true dead-market conditions
  if (bbSqueeze && volSession && volSession.atrPercent < 0.001 && isLowVolSession)
    return "LOW_VOLATILITY";

  // CHAOTIC: choppy OR heavy indicator conflict OR wide BB with no trend
  if (isChoppy)                                   return "CHAOTIC";
  // [BUG5-FIX] was totalScore >= 8 — a 4bull+4bear split (totalScore=8, scoreDiff=0) is the
  // most common weekend OTC ranging condition, NOT chaos. Raised to >= 10 so CHAOTIC is only
  // triggered by genuine extreme conflict (e.g. 5+5 on a full indicator stack).
  if (scoreDiff <= 1 && totalScore >= 10)         return "CHAOTIC";
  if (bbWidth > 0.020 && trendStrength === 0)     return "CHAOTIC";

  // TRENDING: strong directional bias
  if (trendStrength === 2 && scoreDiff >= 2)      return "TRENDING";
  if (trendStrength >= 1 && bbWidth >= 0.0003 && scoreDiff >= 1) return "TRENDING";

  // RANGING: default bounded zone — valid for trading at support/resistance
  return "RANGING";
}

// ═══════════════════════════════════════════════════════════════════════════════
// V6.3 NEW — RANGE DETECTION ENGINE  (Task 2)
// Determines whether price is genuinely oscillating within a tight bounded range.
// Returns { isRange, support, resistance, rangeWidth, touchCount, oscillating }
// ═══════════════════════════════════════════════════════════════════════════════

function detectRangeZone(prices) {
  if (!prices || prices.length < 30) {
    return { isRange: false, support: 0, resistance: 0, rangeWidth: 0, touchCount: 0, oscillating: false };
  }

  const highs  = prices.map((p) => p.high);
  const lows   = prices.map((p) => p.low);
  const closes = prices.map((p) => p.close);
  const n      = closes.length;
  const lb     = Math.min(40, n);   // lookback for range detection

  const recentHighs  = highs.slice(-lb);
  const recentLows   = lows.slice(-lb);
  const recentCloses = closes.slice(-lb);

  const resistance = Math.max(...recentHighs);
  const support    = Math.min(...recentLows);
  const rangeWidth = resistance - support;

  if (rangeWidth === 0) return { isRange: false, support, resistance, rangeWidth: 0, touchCount: 0, oscillating: false };

  // Zone thickness: 15% of range = tolerance band for "touching" a level
  const zoneTolerance = rangeWidth * 0.15;

  // Count touches near resistance and support
  let resistanceTouches = 0, supportTouches = 0;
  for (let i = 0; i < recentHighs.length; i++) {
    if (recentHighs[i] >= resistance - zoneTolerance) resistanceTouches++;
    if (recentLows[i]  <= support    + zoneTolerance) supportTouches++;
  }
  const touchCount = resistanceTouches + supportTouches;

  // Oscillation: price must have crossed the midline at least twice recently
  const midLine = (resistance + support) / 2;
  let crossings = 0;
  for (let i = 1; i < recentCloses.length; i++) {
    const prev = recentCloses[i - 1];
    const curr = recentCloses[i];
    if ((prev < midLine && curr > midLine) || (prev > midLine && curr < midLine)) crossings++;
  }
  const oscillating = crossings >= 2;

  // Breakout check: last close must be inside the range, not outside it
  const lastClose   = last(closes);
  const insideRange = lastClose >= support * 0.999 && lastClose <= resistance * 1.001;

  // ATR-based tightness: ATR should be less than 30% of the range (range is "tight" relative to noise)
  let atrSum = 0;
  const atrLen = Math.min(14, n - 1);
  for (let i = n - atrLen; i < n; i++) {
    atrSum += Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i]  - closes[i - 1])
    );
  }
  const atr       = atrLen > 0 ? atrSum / atrLen : 0;
  const isTight   = atr < rangeWidth * 0.30;

  const isRange = (
    touchCount >= 3 &&    // at least 3 level touches total
    oscillating &&        // price is oscillating across midline
    insideRange &&        // not currently broken out
    isTight               // ATR noise is within tolerable range size
  );

  return {
    isRange,
    support:    parseFloat(support.toFixed(5)),
    resistance: parseFloat(resistance.toFixed(5)),
    rangeWidth: parseFloat(rangeWidth.toFixed(5)),
    touchCount,
    oscillating,
    insideRange,
    isTight,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// V6.3 NEW — RANGE REJECTION CONFIRMATION  (Task 2-D)
// Requires at least 2 of: wick rejection, momentum slowdown, indicator agreement.
// Returns { confirmed, score, reasons }
// ═══════════════════════════════════════════════════════════════════════════════

function confirmRangeRejection(prices, direction, confluence) {
  const n      = prices.length;
  if (n < 5) return { confirmed: false, score: 0, reasons: ["Insufficient data for rejection check"] };

  const isBuy  = direction === "BUY";
  const recent = prices.slice(-3);
  const c1     = recent[recent.length - 2]; // prior candle
  const c0     = recent[recent.length - 1]; // last candle

  let score   = 0;
  const hits  = [];

  // ── Check 1: Wick rejection ───────────────────────────────────────────────
  // For BUY: long lower wick on last candle (rejection of support)
  // For SELL: long upper wick on last candle (rejection of resistance)
  const c0Body  = Math.abs(c0.close - c0.open);
  const c0Range = c0.high - c0.low;
  if (c0Range > 0) {
    const lowerWick = isBuy  ? (Math.min(c0.open, c0.close) - c0.low)  : 0;
    const upperWick = !isBuy ? (c0.high - Math.max(c0.open, c0.close)) : 0;
    const wickRatio = isBuy
      ? lowerWick / c0Range
      : upperWick / c0Range;
    if (wickRatio >= 0.40) {  // wick covers 40%+ of candle range = strong rejection
      score++;
      hits.push("Strong wick rejection at level");
    }
  }

  // ── Check 2: Momentum slowdown ────────────────────────────────────────────
  // Recent candle bodies shrinking = momentum losing steam at the level
  const bodies = prices.slice(-5).map((p) => Math.abs(p.close - p.open));
  const avgBodyRecent = (bodies[3] + bodies[4]) / 2;
  const avgBodyPrior  = (bodies[0] + bodies[1] + bodies[2]) / 3;
  if (avgBodyPrior > 0 && avgBodyRecent < avgBodyPrior * 0.70) {
    score++;
    hits.push("Momentum slowdown — candle bodies shrinking");
  }

  // ── Check 3: Indicator agreement ─────────────────────────────────────────
  // Reuse existing confluence signals
  if (isBuy) {
    const indAgree = confluence.rsiBullish || confluence.rsiOversold
      || confluence.macdBullish || confluence.macdCrossUp
      || confluence.bbBullish   || confluence.maBullish;
    if (indAgree) { score++; hits.push("Indicator agreement for BUY at support"); }
  } else {
    const indAgree = confluence.rsiBearish || confluence.rsiOverbought
      || confluence.macdBearish || confluence.macdCrossDown
      || confluence.bbBearish   || confluence.maBearish;
    if (indAgree) { score++; hits.push("Indicator agreement for SELL at resistance"); }
  }

  // V7.0.4.2 [FIX F]: lowered from 2 to 1. On 1m charts, genuine S/R rejections often show
  // only 1 clear signal (wick OR indicator). Score=0 still hard-blocks. Score=1 passes as Tier C.
  const RANGE_CONFIRMATION_MINIMUM = 1;
  if (score < RANGE_CONFIRMATION_MINIMUM) {
    return {
      confirmed: false,
      score,
      reasons:   hits,
      hardBlock: true,
      blockMsg:  `Range rejection failed: 0/3 confirmations — no signal at all`,
    };
  }
  return {
    confirmed: true,
    score,
    reasons:   hits,
    hardBlock: false,
    blockMsg:  null,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// V6.3 NEW — RANGE STRATEGY EXECUTOR  (Task 2 full implementation)
// Runs only when phase == RANGING.
// Returns { valid, direction, reason, rejectionScore } or null if no entry.
// ═══════════════════════════════════════════════════════════════════════════════

function executeRangeStrategy(prices, structure, confluence, rangeZone) {
  // Must have a valid range zone
  if (!rangeZone.isRange) {
    return { valid: false, direction: null, reason: "Range zone not confirmed — insufficient structure" };
  }

  const closes = prices.map((p) => p.close);
  const lastClose = last(closes);
  const { support, resistance, rangeWidth } = rangeZone;

  // No mid-range trades: price must be within 25% of support (BUY) or resistance (SELL)
  const pricePos         = rangeWidth > 0 ? (lastClose - support) / rangeWidth : 0.5;
  // V7.0.4.2 [FIX E]: was 0.25/0.75 — 25% zone too tight for 1m charts, hit rarely.
  // Widened to 35/65 so the engine catches more legitimate S/R approaches.
  const nearRangeSupport = pricePos <= 0.35;
  const nearRangeResist  = pricePos >= 0.65;

  if (!nearRangeSupport && !nearRangeResist) {
    return {
      valid:     false,
      direction: null,
      reason:    `Mid-range position (${(pricePos * 100).toFixed(0)}% of range) — no trade, wait for level`,
    };
  }

  // No breakout trades: price must not have just broken structure
  if (structure.breakoutUp || structure.breakoutDown) {
    return { valid: false, direction: null, reason: "Breakout detected — range may be invalidated" };
  }

  const direction = nearRangeSupport ? "BUY" : "SELL";

  // Require rejection confirmation (at least 2 of 3)
  const rejection = confirmRangeRejection(prices, direction, confluence);
  if (!rejection.confirmed) {
    return {
      valid:     false,
      direction: null,
      reason:    `Rejection not confirmed (score ${rejection.score}/3) — need 2+ signals: [${rejection.reasons.join("; ")}]`,
    };
  }

  return {
    valid:          true,
    direction,
    reason:         `RANGE ${direction} — ${direction === "BUY" ? "support" : "resistance"} confirmed. Rejection signals: ${rejection.reasons.join(", ")}`,
    rejectionScore: rejection.score,
    pricePos:       parseFloat(pricePos.toFixed(3)),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MARKET QUALITY SCORE  [PROTECTED]
// ═══════════════════════════════════════════════════════════════════════════════

function calcMarketQualityScore(prices, structure, volSession) {
  const closes = prices.map((p) => p.close);
  const highs  = prices.map((p) => p.high);
  const lows   = prices.map((p) => p.low);
  const opens  = prices.map((p) => p.open);
  const n      = closes.length;
  const recent = Math.min(20, n);

  const e50slice = ema(closes, Math.min(50, n - 1));
  let trendCount = 0;
  for (let i = n - recent; i < n; i++) {
    if (structure.trend === "uptrend"   && closes[i] > e50slice[Math.min(i, e50slice.length - 1)]) trendCount++;
    if (structure.trend === "downtrend" && closes[i] < e50slice[Math.min(i, e50slice.length - 1)]) trendCount++;
  }
  const trendConsistency = Math.round((trendCount / recent) * 25);

  let totalWick = 0, totalRange = 0;
  for (let i = n - recent; i < n; i++) {
    const body  = Math.abs(closes[i] - opens[i]);
    const range = highs[i] - lows[i];
    totalWick  += range - body;
    totalRange += range;
  }
  const avgWickRatio     = totalRange > 0 ? totalWick / totalRange : 1;
  const cleanlinessScore = Math.round(Math.max(0, (1 - avgWickRatio)) * 25);

  const trues = [];
  for (let i = Math.max(1, n - recent); i < n; i++) {
    trues.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i]  - closes[i - 1])
    ));
  }
  const atrMean      = trues.length > 0 ? trues.reduce((a, b) => a + b) / trues.length : 0;
  const atrStd       = stdDev(trues);
  const atrCv        = atrMean > 0 ? atrStd / atrMean : 1;
  const stabilityScore = Math.round(Math.max(0, (1 - Math.min(atrCv, 1))) * 25);

  const { support, resistance } = structure;
  let respectCount = 0;
  for (let i = n - recent; i < n; i++) {
    if (closes[i] >= support * 0.999 && closes[i] <= resistance * 1.001) respectCount++;
  }
  const structureScore = Math.round((respectCount / recent) * 25);

  return Math.min(100, Math.max(0, trendConsistency + cleanlinessScore + stabilityScore + structureScore));
}

// ═══════════════════════════════════════════════════════════════════════════════
// V6.3 — DYNAMIC EXPIRY ENGINE  (Task 5 — explicit tier mapping)
// HIGH vol (stable ATR) → 30–60s  |  MEDIUM → 60–120s  |  LOW → NO TRADE
// ═══════════════════════════════════════════════════════════════════════════════


// ═══════════════════════════════════════════════════════════════════════════════
// V6.4 TASK 2 — CENTRALIZED EXPIRY ENGINE
// getDynamicExpiry() is the ONLY authoritative source for expiry decisions.
// All signal paths must route through this function.
//
// Strict tier mapping:
//   HIGH   + STABLE  → 30–60s   (expirySecs: 60)
//   MEDIUM           → 60–120s  (expirySecs: 120 or 180)
//   LOW              → null     (NO TRADE — caller must block)
// ═══════════════════════════════════════════════════════════════════════════════

function getDynamicExpiry(prices, volSession) {
  // Delegate heavy ATR computation to existing calcVolatilityExpiry
  const raw = calcVolatilityExpiry(prices, volSession);

  // V6.4: LOW volatility returns null — caller must treat this as NO TRADE
  if (raw.volatilityTier === "LOW" || raw.volatilityTier === "LOW_EVENING") {
    return null;   // explicit null = hard no-trade signal
  }

  // Return the authoritative expiry object (unchanged structure)
  return raw;
}

// ═══════════════════════════════════════════════════════════════════════════════
// V7.0.3 — POCKET OPTION EXPIRY ALIGNMENT
// ═══════════════════════════════════════════════════════════════════════════════
//
// Pocket Option offers these exact expiry durations (verified from platform):
//   Forex:  1 min, 2 min, 3 min, 5 min, 10 min, 15 min, 30 min
//   OTC:    1 min, 2 min, 3 min, 5 min, 10 min, 15 min, 30 min
//
// The engine's getDynamicExpiry() produces: 1m, 2m, 3m, 5m
// All four already match PO exactly — no rounding needed for those.
//
// This function:
//   1. Validates the engine's expiry against PO's available list
//   2. If somehow a non-PO expiry slips through, rounds to nearest PO option
//   3. Attaches a human-readable Pocket Option clock-time entry instruction
//      e.g. "Enter at 14:32:00 — expires 14:33:00" so the trader knows the
//      exact time to select on PO's interface
//   4. Flags which expiry button to click on PO
// ═══════════════════════════════════════════════════════════════════════════════

// Pocket Option's available expiry durations in seconds (ordered ascending)
const PO_EXPIRY_OPTIONS_SECS = [60, 120, 180, 300, 600, 900, 1800];
const PO_EXPIRY_LABELS = {
  60:   "1 min",
  120:  "2 min",
  180:  "3 min",
  300:  "5 min",
  600:  "10 min",
  900:  "15 min",
  1800: "30 min",
};

function alignToPocketOption(expiryData) {
  if (!expiryData || expiryData.expirySecs == null) return expiryData;

  const rawSecs = expiryData.expirySecs;

  // Find the nearest Pocket Option expiry (round to closest available)
  let nearestSecs = PO_EXPIRY_OPTIONS_SECS[0];
  let minDist     = Infinity;
  for (const optSecs of PO_EXPIRY_OPTIONS_SECS) {
    const dist = Math.abs(optSecs - rawSecs);
    if (dist < minDist) { minDist = dist; nearestSecs = optSecs; }
  }

  // Build clock-time entry instruction
  const now        = new Date();
  const entrySecs  = Math.ceil(now.getTime() / 1000) * 1000;         // round up to next second
  const expireTime = new Date(entrySecs + nearestSecs * 1000);
  const entryTime  = new Date(entrySecs);

  const fmt = (d) => d.toLocaleTimeString("en-US", {
    hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit",
    timeZone: "UTC",
  }) + " UTC";

  const poLabel   = PO_EXPIRY_LABELS[nearestSecs] ?? `${nearestSecs}s`;
  const changed   = nearestSecs !== rawSecs;

  return {
    ...expiryData,
    expiry:         poLabel,
    expirySecs:     nearestSecs,
    poExpirySecs:   nearestSecs,
    poExpiryLabel:  poLabel,
    poEntryTime:    fmt(entryTime),
    poExpiryTime:   fmt(expireTime),
    poInstruction:  `Select "${poLabel}" on Pocket Option · Enter ~${fmt(entryTime)} · Expires ~${fmt(expireTime)}`,
    poAligned:      true,
    poRounded:      changed,
    expiryReason:   changed
      ? `${expiryData.expiryReason} → rounded to nearest PO option (${poLabel})`
      : expiryData.expiryReason,
  };
}

function calcVolatilityExpiry(prices, volSession) {
  const closes = prices.map((p) => p.close);
  const highs  = prices.map((p) => p.high);
  const lows   = prices.map((p) => p.low);
  const opens  = prices.map((p) => p.open);
  const n      = closes.length;
  const recent = Math.min(10, n);

  let bodySum = 0;
  for (let i = n - recent; i < n; i++) bodySum += Math.abs(closes[i] - opens[i]);
  const avgBodySize = bodySum / recent;

  const atr    = volSession.atr;
  const atrPct = volSession.atrPercent;
  const bodyToAtr = atr > 0 ? avgBodySize / atr : 0;

  const moves = closes.slice(-5).map((c, i, arr) => i === 0 ? 0 : Math.abs(c - arr[i - 1]));
  const avgMove       = moves.reduce((a, b) => a + b, 0) / 5;
  const momentumSpeed = atr > 0 ? avgMove / atr : 0;

  const isEveningSess = volSession.inEvening === true;
  const isInSession   = volSession.inSession  === true;

  const recentTRs = [];
  for (let i = n - 5; i < n; i++) {
    if (i > 0) recentTRs.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i]  - closes[i - 1])
    ));
  }
  const priorTRs = [];
  for (let i = n - 10; i < n - 5; i++) {
    if (i > 0) priorTRs.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i]  - closes[i - 1])
    ));
  }
  const avgRecentTR    = recentTRs.length > 0 ? recentTRs.reduce((a, b) => a + b) / recentTRs.length : atr;
  const avgPriorTR     = priorTRs.length  > 0 ? priorTRs.reduce((a, b) => a + b)  / priorTRs.length  : atr;
  const formationAccel = avgPriorTR > 0 ? avgRecentTR / avgPriorTR : 1;

  // ── V6.3 EXPLICIT TIER → EXPIRY MAPPING ──────────────────────────────────
  // HIGH volatility (stable ATR): 30–60s expiry
  const isHighVol = (
    atrPct > 0.04 ||
    (bodyToAtr > 0.7 && volSession.strongMomentum) ||
    momentumSpeed > 0.9 ||
    formationAccel > 1.4
  );

  // LOW volatility: no trade (caller blocks this via phase detection)
  const isLowVol = (
    // V6.5.3: was atrPct < 0.008 — too sensitive, flagged normal quiet periods as LOW vol
    // Now requires atrPct < 0.003 AND both bodyToAtr + momentumSpeed weak
    (atrPct < 0.003 && bodyToAtr < 0.25 && momentumSpeed < 0.2) ||
    (isEveningSess && atrPct < 0.02 && formationAccel < 0.8)
  );

  if (isHighVol && !isEveningSess) {
    // HIGH → 30–60s range: use 1 min (60s) for fast markets, add entryWindow label
    return {
      timeframe:      "1m",
      expiry:         "1 min",          // 60s — high end of 30–60s range
      expirySecs:     60,               // V6.3: explicit seconds for logging
      entryWindow:    formationAccel > 1.6 ? "10s" : "15s",
      volatilityTier: "HIGH",
      expiryReason:   `High volatility (ATR%: ${atrPct.toFixed(4)}) → 60s expiry`,
    };
  }

  if (isLowVol || isEveningSess) {
    // LOW / Evening → longest expiry; LOW_VOLATILITY phase blocks this at orchestration level
    return {
      timeframe:      "5m",
      expiry:         "5 min",
      expirySecs:     300,
      entryWindow:    "50s",
      volatilityTier: isEveningSess ? "LOW_EVENING" : "LOW",
      expiryReason:   isEveningSess ? "Evening session → 5 min expiry" : "Low volatility → 5 min expiry",
    };
  }

  // MEDIUM → 60–120s: differentiate 2m vs 3m
  if (bodyToAtr > 0.5 || momentumSpeed > 0.6 || formationAccel > 1.1) {
    return {
      timeframe:      "2m",
      expiry:         "2 min",          // 120s — medium range
      expirySecs:     120,
      entryWindow:    "25s",
      volatilityTier: "MEDIUM",
      expiryReason:   `Medium-high volatility (body/ATR: ${bodyToAtr.toFixed(2)}) → 2 min expiry`,
    };
  }

  return {
    timeframe:      "3m",
    expiry:         "3 min",            // 180s — lower medium
    expirySecs:     180,
    entryWindow:    "40s",
    volatilityTier: "MEDIUM",
    expiryReason:   `Medium volatility (ATR%: ${atrPct.toFixed(4)}) → 3 min expiry`,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SMART FILTER  [PROTECTED — unchanged except NONE strategy passes through]
// ═══════════════════════════════════════════════════════════════════════════════

function applySmartFilter(
  structure, confluence, volSession,
  marketPhase, marketQualityScore, direction,
  volStability, confConsistency, mtfConfirmation, entryPrecision, signalTier,
  analysis = null   // V6.4 TASK 3: full analysis passed for fail-safe checks
) {
  // V6.5.4: Separate HARD blocks (shouldSkip=true) from SOFT warnings (logged but don't block).
  // Previously every pushed reason caused a block — this was the root cause of most false blocks.
  const hardReasons = [];   // these WILL block the trade
  const softWarnings = [];  // these are logged but DO NOT block

  // ── HARD BLOCKS ───────────────────────────────────────────────────────────

  // V6.4 TASK 3 — FAIL-SAFE: expiry null = LOW vol = hard no-trade
  if (analysis && analysis.expiryNull) {
    hardReasons.push("Expiry engine returned null (LOW volatility) — hard no-trade enforced");
    return { shouldSkip: true, reasons: hardReasons };
  }

  // V6.4 TASK 3 — FAIL-SAFE: invalid/unknown phase blocks immediately
  const VALID_TRADE_PHASES = new Set(["TRENDING", "RANGING"]);
  if (!VALID_TRADE_PHASES.has(marketPhase)) {
    hardReasons.push(`Invalid phase for trading (${marketPhase}) — hard no-trade enforced`);
    return { shouldSkip: true, reasons: hardReasons };
  }

  // Signal tier SKIP is a hard block (means ALL quality criteria failed)
  if (signalTier === "SKIP")
    hardReasons.push("Signal tier SKIP — insufficient quality across all factors");

  // [BUG6-FIX] was SIGNAL_QUALITY_THRESHOLD (52) — same value already used by assembleSignals upstream.
  // A pair scoring exactly 52 passed assembleSignals then immediately hit this identical gate as a hard block.
  // applySmartFilter should only enforce the ABSOLUTE floor (43) as a last-resort safety net.
  if (marketQualityScore < SIGNAL_QUALITY_FLOOR)
    hardReasons.push(`Market quality below absolute floor (${marketQualityScore}/100) — minimum is ${SIGNAL_QUALITY_FLOOR}`);

  // Loss prevention is a hard block
  if (lossPrevention.active) {
    const now = Date.now();
    if (lossPrevention.until && now < lossPrevention.until) {
      const minsLeft = Math.ceil((lossPrevention.until - now) / 60000);
      hardReasons.push(`Loss prevention active — paused for ~${minsLeft} more min (${lossPrevention.reason})`);
    } else {
      lossPrevention = { active: false, until: null, reason: "" };
    }
  }

  // Max trades reached is a hard block
  if (sessionTradeCount >= MAX_TRADES_PER_SESSION)
    hardReasons.push(`Max trades per session reached (${MAX_TRADES_PER_SESSION}) — waiting for new session`);

  // Session guard is a hard block (too early in session)
  const { t } = getGMT1Time();
  for (const s of SESSION_DEFS) {
    const minsIntoSession = (t - s.start) * 60;
    if (minsIntoSession >= 0 && minsIntoSession < SESSION_GUARD_MINUTES) {
      hardReasons.push(`Session guard: first ${SESSION_GUARD_MINUTES} min of ${s.key} — no trades yet`);
      break;
    }
  }

  // Phase-direction compatibility is a hard block (trading against the trend)
  if (marketPhase === "TRENDING") {
    const isBuy = direction === "BUY";
    if (isBuy  && structure.trend !== "uptrend")   hardReasons.push("TRENDING phase: BUY rejected — trend is not uptrend");
    if (!isBuy && structure.trend !== "downtrend") hardReasons.push("TRENDING phase: SELL rejected — trend is not downtrend");
  }

  // BB squeeze + confirmed low vol = hard block (no tradeable movement)
  if (confluence.bbSqueeze && volSession.volatility === "low")
    hardReasons.push("Extreme low volatility squeeze — no tradeable movement");

  // Choppy structure = hard block only if truly choppy
  if (structure.isChoppy && marketPhase !== "CHAOTIC")
    hardReasons.push("Choppy market — no clear directional movement");

  // MTF: only block if HTF DISAGREES with direction — LTF RSI alone is NOT a hard block
  // FIX V6.5.4: previously mtfConfirmation.confirmed=false blocked even if only LTF failed.
  // htfAgrees = the higher timeframe EMA trend agrees. ltfReady = short-term RSI timing.
  // We only hard-block on HTF disagreement; LTF timing mismatch is a soft warning.
  if (mtfConfirmation && !mtfConfirmation.confirmed) {
    const isBuy = direction === "BUY";
    const htfDisagrees = isBuy ? !mtfConfirmation.htfBullish : mtfConfirmation.htfBullish;
    if (htfDisagrees) {
      // V7.0.4.2 [FIX D]: was always a hard block. On 1m binary options, 5m EMA20 and 1m signals
      // diverge constantly during consolidation — this silenced the engine for hours.
      // Now only hard-block when HTF trend is STRONG. Mild disagreement → soft warning.
      const htfTrendStrong = mtfConfirmation.htfTrendStrong === true;
      if (htfTrendStrong) {
        hardReasons.push(isBuy
          ? "Higher timeframe strongly bearish — BUY against confirmed HTF downtrend (hard block)"
          : "Higher timeframe strongly bullish — SELL against confirmed HTF uptrend (hard block)");
      } else {
        softWarnings.push(isBuy
          ? "[INFO] HTF leans bearish but not strongly — counter-trend BUY, confidence noted"
          : "[INFO] HTF leans bullish but not strongly — counter-trend SELL, confidence noted");
      }
    } else {
      // HTF agrees but LTF timing is off — soft warning only
      softWarnings.push("LTF timing not ideal — consider waiting for RSI pullback (soft warning)");
    }
  }

  // ── SOFT WARNINGS (logged, visible to UI, do NOT block) ───────────────────

  // Erratic volatility: downgraded to soft warning — CV 0.41-0.65 is normal in live forex
  if (volStability && !volStability.stable)
    softWarnings.push(`Volatility elevated (CV ${volStability.cv}) — ATR active, trade with awareness`);

  // Confidence spike: soft warning only — a spike can mean a real breakout
  if (confConsistency && confConsistency.spike)
    softWarnings.push(`Confidence spike (${confConsistency.avg} → current) — verify entry before committing`);

  // Entry precision failure: soft warning — price position or candle body not ideal
  // FIX V6.5.4: was a hard block; now a soft warning so marginal candles don't kill valid setups
  if (entryPrecision && !entryPrecision.valid)
    softWarnings.push(`Entry timing note: ${entryPrecision.reason} — consider waiting for next candle`);

  // Conflicting indicators: soft warning (common in real markets, not a disqualifier)
  const scoreDiff  = Math.abs(confluence.bullScore - confluence.bearScore);
  const totalScore = confluence.bullScore + confluence.bearScore;
  if (scoreDiff <= 1 && totalScore >= 2)
    softWarnings.push("Mixed indicator signals — trade with reduced size");

  // Weak confluence: soft warning
  if (Math.max(confluence.bullScore, confluence.bearScore) < 2)
    softWarnings.push("Weak confluence — fewer than 2 indicators agree, use caution");

  // Sideways outside ranging phase: soft warning
  if (structure.trend === "sideways" && structure.trendStrength === 0 && marketPhase !== "RANGING")
    softWarnings.push("Sideways consolidation — lower probability setup");

  // Off-hours: soft warning
  if (!volSession.inSession)
    softWarnings.push("Outside primary session windows — reduced liquidity expected");

  // Combine all reasons for UI visibility — hard blocks first, then soft warnings
  const allReasons = [...hardReasons, ...softWarnings.map(w => `[INFO] ${w}`)];
  return { shouldSkip: hardReasons.length > 0, reasons: allReasons };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIDENCE SCORE  [PROTECTED]
// ═══════════════════════════════════════════════════════════════════════════════

function buildConfidenceScore(structure, confluence, volSession, direction) {
  const isBuy = direction === "BUY";
  let score   = 50;

  const cs = isBuy ? confluence.bullScore : confluence.bearScore;
  score += Math.min(cs * 7, 28);

  if (isBuy  && structure.trend === "uptrend")   score += structure.trendStrength === 2 ? 10 : 5;
  if (!isBuy && structure.trend === "downtrend") score += structure.trendStrength === 2 ? 10 : 5;

  if (isBuy  && structure.nearSupport)    score += 8;
  if (!isBuy && structure.nearResistance) score += 8;
  if (isBuy  && structure.breakoutUp)     score += 6;
  if (!isBuy && structure.breakoutDown)   score += 6;

  if (volSession.inSession) score += 6; else score -= 5;

  if (isBuy  && confluence.macdCrossUp)   score += 5;
  if (!isBuy && confluence.macdCrossDown) score += 5;
  if (isBuy  && confluence.rsiOversold)   score += 5;
  if (!isBuy && confluence.rsiOverbought) score += 5;
  if (isBuy  && confluence.maCrossUp)     score += 4;
  if (!isBuy && confluence.maCrossDown)   score += 4;

  if (volSession.volatility === "high") score -= 5;
  if (structure.isChoppy)               score -= 10;

  return Math.min(93, Math.max(55, Math.round(score)));
}

// ═══════════════════════════════════════════════════════════════════════════════
// V6.3 — PHASE ORCHESTRATION LAYER  (Task 1 — central controller)
// This is the single decision point that determines WHICH strategy executes.
// Phase → Strategy → Analysis path is enforced here before signal generation.
// ═══════════════════════════════════════════════════════════════════════════════

function orchestrateStrategy(prices, pairName, structure, confluence, volSession, marketPhase, marketQualityScore) {

  // ── CHAOTIC or LOW_VOLATILITY → block immediately ────────────────────────
  if (marketPhase === "CHAOTIC" || marketPhase === "LOW_VOLATILITY") {
    return {
      strategyUsed:    STRATEGY_NONE,
      direction:       null,
      blocked:         true,
      blockReason:     `${marketPhase} phase — no trade`,
      rangeData:       null,
      rangeEntry:      null,
    };
  }

  // ── TRENDING → delegate to existing trend strategy (unmodified) ──────────
  if (marketPhase === "TRENDING") {
    const direction = confluence.bullScore >= confluence.bearScore ? "BUY" : "SELL";
    return {
      strategyUsed: STRATEGY_TREND,
      direction,
      blocked:      false,
      blockReason:  null,
      rangeData:    null,
      rangeEntry:   null,
    };
  }

  // ── RANGING → run full range strategy ────────────────────────────────────
  if (marketPhase === "RANGING") {
    const rangeZone  = detectRangeZone(prices);
    const rangeEntry = executeRangeStrategy(prices, structure, confluence, rangeZone);

    if (!rangeEntry.valid) {
      return {
        strategyUsed: STRATEGY_NONE,
        direction:    null,
        blocked:      true,
        blockReason:  rangeEntry.reason,
        rangeData:    rangeZone,
        rangeEntry,
      };
    }

    return {
      strategyUsed: STRATEGY_RANGE,
      direction:    rangeEntry.direction,
      blocked:      false,
      blockReason:  null,
      rangeData:    rangeZone,
      rangeEntry,
    };
  }

  // Fallback — should never reach here
  return {
    strategyUsed: STRATEGY_NONE,
    direction:    null,
    blocked:      true,
    blockReason:  "Unhandled phase — no strategy available",
    rangeData:    null,
    rangeEntry:   null,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// FULL ANALYSIS BUILDER — V6.3: orchestration layer drives strategy selection
// ═══════════════════════════════════════════════════════════════════════════════

function buildFullAnalysis(prices, pairName) {
  const structure  = analyzeMarketStructure(prices);
  const confluence = analyzeConfluence(prices);
  const volSession = analyzeVolatilityAndSession(prices);

  const marketPhase        = classifyMarketPhase(structure, confluence, volSession);
  const marketQualityScore = calcMarketQualityScore(prices, structure, volSession);

  // V6.3: orchestration layer determines strategy and direction
  const orchestration = orchestrateStrategy(
    prices, pairName, structure, confluence, volSession, marketPhase, marketQualityScore
  );

  // Direction comes from orchestration, not directly from confluence for ranging
  const direction = orchestration.direction || (confluence.bullScore >= confluence.bearScore ? "BUY" : "SELL");

  const confidence  = buildConfidenceScore(structure, confluence, volSession, direction);
  // V6.4 TASK 2: route through centralized getDynamicExpiry (single source of truth)
  const rawExpiryData = getDynamicExpiry(prices, volSession);
  // V7.0.3: align expiry to Pocket Option's exact available options
  const expiryData  = rawExpiryData ? alignToPocketOption(rawExpiryData) : null;
  // null means LOW volatility — orchestration will block, but we mark it defensively
  const expiryNull  = expiryData === null;
  const strength    = confidence >= 80 ? "STRONG" : confidence >= 68 ? "MODERATE" : "WEAK";

  const volStability    = calcVolatilityStability(prices);
  const confConsistency = calcConfidenceConsistency(prices, confidence);
  const mtfConfirmation = confirmMultiTimeframe(prices, direction);
  const entryPrecision  = checkEntryPrecision(prices, direction);
  // V6.5.3: Weighted scoring model (5 components)
  const weightedScoreData = calcWeightedScore(structure, confluence, volSession, entryPrecision, prices);
  const weightedScore     = weightedScoreData.weightedScore;

  // V6.5.3: Expected value model — V7.0.4.1: pass preliminary tier hint for historical blend
  const volatilityTierNow = expiryData?.volatilityTier ?? "MEDIUM";
  // Preliminary tier estimate for EV blending (uses indicator-only signals, no EV yet)
  const prelimTier = (() => {
    const hC = confidence >= 80;
    const hW = weightedScore >= 72;
    const hQ = marketQualityScore >= 62;
    const cnt = [hC, hW, hQ, volStability?.stable ?? true, mtfConfirmation?.confirmed ?? true].filter(Boolean).length;
    if (cnt >= 4) return "A";
    if (cnt >= 2) return "B";
    return "C";
  })();
  const ev = calcExpectedValue(weightedScore, confluence, marketPhase, confidence, volatilityTierNow, prelimTier);

  // V6.5.3: New A/B/C tier classifier (replaces old classifySignalTier)
  const signalTier = classifyTradeTier(
    confidence, weightedScore, ev, marketQualityScore,
    volStability, mtfConfirmation.confirmed, entryPrecision, marketPhase
  );

  // Smart filter — always applied regardless of strategy
  // If orchestration already blocked (range failed / CHAOTIC), propagate that block
  let filter;
  if (orchestration.blocked) {
    filter = { shouldSkip: true, reasons: [orchestration.blockReason] };
  } else {
    filter = applySmartFilter(
      structure, confluence, volSession,
      marketPhase, marketQualityScore, direction,
      volStability, confConsistency, mtfConfirmation, entryPrecision, signalTier,
      { expiryNull }   // V6.4 TASK 3: pass expiryNull for fail-safe gate
    );
  }

  return {
    pair:            pairName,
    structure,       confluence,      volSession,
    marketPhase,     marketQualityScore,
    strategyUsed:    orchestration.strategyUsed,   // V6.3
    rangeData:       orchestration.rangeData,       // V6.3
    rangeEntry:      orchestration.rangeEntry,      // V6.3
    volStability,    confConsistency, mtfConfirmation, entryPrecision,
    signalTier,
    weightedScore,   weightedScoreComponents: weightedScoreData.components,  // V6.5.3
    ev,              // V6.5.3: expected value object
    filter,          direction,       confidence,   strength,
    timeframe:       expiryData?.timeframe    ?? null,
    expiry:          expiryData?.expiry        ?? null,
    expirySecs:      expiryData?.expirySecs    ?? null,
    entryWindow:     expiryData?.entryWindow   ?? null,
    volatilityTier:  expiryData?.volatilityTier ?? "LOW",
    expiryReason:    expiryData?.expiryReason  ?? "Low volatility — no trade",
    expiryNull,
    // V7.0.3: Pocket Option alignment fields
    poExpiryLabel:   expiryData?.poExpiryLabel  ?? null,
    poEntryTime:     expiryData?.poEntryTime    ?? null,
    poExpiryTime:    expiryData?.poExpiryTime   ?? null,
    poInstruction:   expiryData?.poInstruction  ?? null,
    poAligned:       expiryData?.poAligned      ?? false,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// VOLATILITY STABILITY FILTER  [PROTECTED]
// ═══════════════════════════════════════════════════════════════════════════════

function calcVolatilityStability(prices) {
  const closes = prices.map((p) => p.close);
  const highs  = prices.map((p) => p.high);
  const lows   = prices.map((p) => p.low);
  const n      = closes.length;
  const window = Math.min(14, n - 1);

  const trs = [];
  for (let i = n - window; i < n; i++) {
    trs.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i]  - closes[i - 1])
    ));
  }
  const mean = trs.reduce((a, b) => a + b, 0) / trs.length;
  const sd   = stdDev(trs);
  const cv   = mean > 0 ? sd / mean : 1;
  return { stable: cv <= 0.65, cv: parseFloat(cv.toFixed(3)) };   // FIX: was <= 0.40 — too strict, CV 0.4-0.65 is normal in live forex (blocks London/NY opens)
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIDENCE CONSISTENCY FILTER  [PROTECTED]
// ═══════════════════════════════════════════════════════════════════════════════

function calcConfidenceConsistency(prices, currentConfidence) {
  const simConfs = [];
  for (let offset = 1; offset <= 5; offset++) {
    const subset = prices.slice(0, prices.length - offset);
    if (subset.length < 30) continue;
    const st  = analyzeMarketStructure(subset);
    const cf  = analyzeConfluence(subset);
    const vs  = analyzeVolatilityAndSession(subset);
    const dir = cf.bullScore >= cf.bearScore ? "BUY" : "SELL";
    simConfs.push(buildConfidenceScore(st, cf, vs, dir));
  }
  if (simConfs.length === 0) return { consistent: true, spike: false, avg: currentConfidence };
  const avg   = simConfs.reduce((a, b) => a + b, 0) / simConfs.length;
  const spike = currentConfidence > avg + 15;
  return { consistent: !spike, spike, avg: Math.round(avg) };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MULTI-TIMEFRAME CONFIRMATION  [PROTECTED]
// ═══════════════════════════════════════════════════════════════════════════════

// ── V7.0.4.1 REAL MULTI-TIMEFRAME CONFIRMATION ────────────────────────────────
// BUG FIX: Previous version used last 10 candles of the same 1m dataset as a
// "higher timeframe" proxy — this is the same data, not a higher timeframe.
//
// FIX: Resample the 200×1m candles already in memory into synthetic 5m bars
// (group every 5 consecutive 1m candles → OHLC). This gives ~40 real 5m bars
// from the data we already have — zero extra API calls, genuine HTF structure.
//
// HTF analysis (5m bars):
//   - EMA20 on 5m bars → slope determines 5m trend direction
//   - Price position vs EMA20 on 5m confirms bias
//
// LTF analysis (1m bars, last 14 candles):
//   - Standard 14-period RSI on 1m for short-term momentum timing
//   - Entry allowed when RSI is not at extreme against direction
// ──────────────────────────────────────────────────────────────────────────────
function resampleTo5m(prices) {
  const bars = [];
  for (let i = 0; i + 4 < prices.length; i += 5) {
    const slice = prices.slice(i, i + 5);
    bars.push({
      open:   slice[0].open,
      high:   Math.max(...slice.map((c) => c.high)),
      low:    Math.min(...slice.map((c) => c.low)),
      close:  slice[4].close,
      volume: slice.reduce((s, c) => s + (c.volume || 0), 0),
    });
  }
  return bars;
}

function confirmMultiTimeframe(prices, direction) {
  const isBuy = direction === "BUY";

  // ── HTF: resample 1m → 5m bars for genuine higher-timeframe view ──────────
  const bars5m = resampleTo5m(prices);
  if (bars5m.length < 10) {
    // Not enough data for 5m bars — pass through neutrally
    return { htfBullish: true, ltfReady: true, confirmed: true, htfSource: "insufficient_data" };
  }

  const closes5m  = bars5m.map((b) => b.close);
  const ema20_5m  = ema(closes5m, Math.min(20, closes5m.length - 1));
  const htfEma    = last(ema20_5m);
  const htfEmaPrev = ema20_5m.length > 3 ? ema20_5m[ema20_5m.length - 4] : ema20_5m[0];
  const htfSlope  = htfEma - htfEmaPrev;                  // positive = 5m uptrend
  const htfClose  = last(closes5m);
  const htfAbove  = htfClose > htfEma;                    // price above 5m EMA20
  const htfBullish = htfSlope > 0 && htfAbove;            // both slope + position agree

  // ── LTF: proper 14-period RSI on 1m data for entry timing ─────────────────
  const closes1m = prices.map((p) => p.close);
  const n        = closes1m.length;
  const rsiLen   = Math.min(14, n - 1);
  let g = 0, l = 0;
  for (let i = n - rsiLen; i < n; i++) {
    const d = closes1m[i] - closes1m[i - 1];
    if (d > 0) g += d; else l -= d;
  }
  const ag      = rsiLen > 0 ? g / rsiLen : 0;
  const al      = rsiLen > 0 ? l / rsiLen : 0;
  const ltfRsi  = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  // Entry timing: BUY when RSI not overbought (<70); SELL when not oversold (>30)
  const ltfReady = isBuy ? ltfRsi < 70 : ltfRsi > 30;

  const htfAgrees = isBuy ? htfBullish : !htfBullish;
  // V7.0.4.2 [FIX D2]: htfTrendStrong — slope > 15% of recent EMA range = decisive trend on 5m
  const htfSlopeAbs  = Math.abs(htfSlope);
  const ema20slice   = ema20_5m.slice(-Math.min(10, ema20_5m.length));
  const htfEmaRange  = Math.max(...ema20slice) - Math.min(...ema20slice);
  const htfTrendStrong = htfEmaRange > 0 && (htfSlopeAbs / htfEmaRange) > 0.15;
  return {
    htfBullish,
    ltfReady,
    confirmed:     htfAgrees && ltfReady,
    htfTrendStrong,
    htfSource:     "resampled_5m",
    htfEma:        parseFloat(htfEma.toFixed(5)),
    htfSlope:      parseFloat(htfSlope.toFixed(6)),
    ltfRsi:        parseFloat(ltfRsi.toFixed(2)),
    bars5mCount:   bars5m.length,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENTRY PRECISION CHECK  [PROTECTED]
// ═══════════════════════════════════════════════════════════════════════════════

function checkEntryPrecision(prices, direction) {
  const n = prices.length;
  if (n < 3) return { valid: true, reason: "insufficient data" };

  const curr   = prices[n - 1];
  const isBuy  = direction === "BUY";

  const bodyBull  = curr.close > curr.open;
  const bodyBear  = curr.close < curr.open;
  const closedOk  = isBuy ? bodyBull : bodyBear;

  const body      = Math.abs(curr.close - curr.open);
  const range     = curr.high - curr.low;
  const bodyRatio = range > 0 ? body / range : 1;
  const notSpike  = bodyRatio >= 0.30;

  const pricePos = range > 0 ? (curr.close - curr.low) / range : 0.5;
  const goodPos  = isBuy ? pricePos > 0.35 : pricePos < 0.65;

  if (!closedOk)  return { valid: false, reason: `Last candle closed against ${direction} direction` };
  if (!notSpike)  return { valid: false, reason: "Spike candle — body < 30% of range, wait for confirmation" };
  if (!goodPos)   return { valid: false, reason: "Price at unfavourable wick position — wait for pullback" };
  return { valid: true, reason: "Entry precision confirmed" };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SIGNAL QUALITY TIER CLASSIFIER  [PROTECTED]
// ═══════════════════════════════════════════════════════════════════════════════

function classifySignalTier(confidence, marketQualityScore, volStability, mtfConfirmed, entryPrecision) {
  const highConf    = confidence >= 80;
  const highQuality = marketQualityScore >= 80;
  const stable      = volStability.stable;
  const mtfOk       = mtfConfirmed;
  const entryOk     = entryPrecision.valid;

  const score = [highConf, highQuality, stable, mtfOk, entryOk].filter(Boolean).length;
  if (score >= 4) return "A+";
  if (score >= 2) return "B";
  return "SKIP";
}

// ═══════════════════════════════════════════════════════════════════════════════
// PAIR QUALITY PRE-SCORER  [PROTECTED]
// ═══════════════════════════════════════════════════════════════════════════════

function scorePairForPreSelection(prices) {
  if (!prices || prices.length < 30) return 0;

  const closes = prices.map((p) => p.close);
  const highs  = prices.map((p) => p.high);
  const lows   = prices.map((p) => p.low);
  const opens  = prices.map((p) => p.open);
  const n      = prices.length;
  const recent = Math.min(20, n);

  const trues = [];
  for (let i = Math.max(1, n - recent); i < n; i++) {
    trues.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i]  - closes[i - 1])
    ));
  }
  const atrMean  = trues.length > 0 ? trues.reduce((a, b) => a + b) / trues.length : 0;
  const atrStd   = stdDev(trues);
  const atrCv    = atrMean > 0 ? atrStd / atrMean : 1;
  const atrScore = Math.round(Math.max(0, (1 - Math.min(atrCv, 1))) * 25);

  const e20  = ema(closes, Math.min(20, n - 1));
  const e50  = ema(closes, Math.min(50, n - 1));
  const bull = last(e20) > last(e50);
  let trendCount = 0;
  for (let i = n - recent; i < n; i++) {
    const eVal = e50[Math.min(i, e50.length - 1)];
    if (bull  && closes[i] > eVal) trendCount++;
    if (!bull && closes[i] < eVal) trendCount++;
  }
  const trendScore = Math.round((trendCount / recent) * 25);

  let totalWick = 0, totalRange = 0;
  for (let i = n - recent; i < n; i++) {
    const body  = Math.abs(closes[i] - opens[i]);
    const range = highs[i] - lows[i];
    totalWick  += range - body;
    totalRange += range;
  }
  const wickRatio  = totalRange > 0 ? totalWick / totalRange : 1;
  const cleanScore = Math.round(Math.max(0, (1 - wickRatio)) * 25);

  const resistance = Math.max(...highs.slice(-recent));
  const support    = Math.min(...lows.slice(-recent));
  let respectCount = 0;
  for (let i = n - recent; i < n; i++) {
    if (closes[i] >= support * 0.999 && closes[i] <= resistance * 1.001) respectCount++;
  }
  const structScore = Math.round((respectCount / recent) * 25);

  return atrScore + trendScore + cleanScore + structScore;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DIRECTIONAL BIAS CALCULATOR  [PROTECTED]
// ═══════════════════════════════════════════════════════════════════════════════

function calcDirectionalBias(prices) {
  const closes = prices.map((p) => p.close);
  const n      = closes.length;
  if (n < 26) return "neutral";

  const ema20    = ema(closes, Math.min(20, n - 1));
  const e20Now   = last(ema20);
  const e20Prev  = ema20.length > 5 ? ema20[ema20.length - 6] : ema20[0];
  const emaSlope = e20Now - e20Prev;

  const ema12    = ema(closes, 12);
  const ema26e   = ema(closes, 26);
  const mLen     = Math.min(ema12.length, ema26e.length);
  const macdLine = ema12.slice(-mLen).map((v, i) => v - ema26e[ema26e.length - mLen + i]);
  const sigLine  = ema(macdLine, 9);
  const histLast5 = macdLine.slice(-5).map((v, i) => v - (sigLine[sigLine.length - 5 + i] || 0));
  const avgHist   = histLast5.reduce((a, b) => a + b, 0) / histLast5.length;

  const lastClose = last(closes);
  const threshold = lastClose * 0.00005;

  if (emaSlope > threshold  && avgHist > 0) return "bullish";
  if (emaSlope < -threshold && avgHist < 0) return "bearish";
  return "neutral";
}

// ═══════════════════════════════════════════════════════════════════════════════
// V6.5.3 — DYNAMIC QUALITY THRESHOLD RESOLVER
// Returns the minimum acceptable quality score based on current volatility.
// ═══════════════════════════════════════════════════════════════════════════════

function getDynamicQualityThreshold(volatilityTier) {
  if (volatilityTier === "HIGH")         return QUALITY_THRESHOLDS.high;
  if (volatilityTier === "MEDIUM")       return QUALITY_THRESHOLDS.medium;
  if (volatilityTier === "LOW" || volatilityTier === "LOW_EVENING") return QUALITY_THRESHOLDS.low;
  return QUALITY_THRESHOLDS.medium;
}

// ═══════════════════════════════════════════════════════════════════════════════
// V6.5.3 — WEIGHTED SCORING MODEL (5 components)
// Components: trend_strength(25%), structure_quality(20%), entry_precision(20%),
//             volume_confirmation(15%), volatility_alignment(20%)
// ═══════════════════════════════════════════════════════════════════════════════

function calcWeightedScore(structure, confluence, volSession, entryPrecision, prices) {
  const closes = prices.map((p) => p.close);
  const highs  = prices.map((p) => p.high);
  const lows   = prices.map((p) => p.low);
  const opens  = prices.map((p) => p.open);
  const n      = closes.length;
  const recent = Math.min(20, n);

  // trend_strength (25%)
  const trendRaw       = structure.trendStrength * 12.5;
  const scoreDiff      = Math.abs(confluence.bullScore - confluence.bearScore);
  const conflRaw       = Math.min(scoreDiff * 5, 15);
  const trendComponent = Math.min(25, trendRaw * 0.7 + conflRaw * 0.3);

  // structure_quality (20%)
  let totalWick = 0, totalRange = 0;
  for (let i = n - recent; i < n; i++) {
    const body  = Math.abs(closes[i] - opens[i]);
    const range = highs[i] - lows[i];
    totalWick  += range - body;
    totalRange += range;
  }
  const wickRatio       = totalRange > 0 ? totalWick / totalRange : 1;
  const structComponent = Math.round(Math.max(0, (1 - wickRatio)) * 20);

  // entry_precision (10%) — V7.0.4.2 [FIX C]: was 20pt binary swing; one wicky candle wiped 20/100 pts
  // pushing borderline pairs below quality floor. Halved so a bad candle is a penalty, not a veto.
  const entryComponent = entryPrecision && entryPrecision.valid ? 10 : 0;

  // volume_confirmation (15%) — ATR acceleration proxy
  const recentTRs = [], priorTRs = [];
  for (let i = n - 5; i < n; i++) {
    if (i > 0) recentTRs.push(Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1])));
  }
  for (let i = n - 10; i < n - 5; i++) {
    if (i > 0) priorTRs.push(Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1])));
  }
  const avgRecent       = recentTRs.length > 0 ? recentTRs.reduce((a,b)=>a+b)/recentTRs.length : 0;
  const avgPrior        = priorTRs.length  > 0 ? priorTRs.reduce((a,b)=>a+b)/priorTRs.length  : avgRecent;
  const accel           = avgPrior > 0 ? avgRecent / avgPrior : 1;
  const volConfComponent = Math.min(15, Math.round(Math.min(accel, 1.5) * 10));

  // volatility_alignment (20%)
  const volAlignComponent = volSession.volatility === "moderate" ? 20
                           : volSession.volatility === "high"    ? 12 : 6;

  const total = Math.round(trendComponent + structComponent + entryComponent + volConfComponent + volAlignComponent);
  return {
    weightedScore: Math.min(100, Math.max(0, total)),
    components: {
      trend_strength:       Math.round(trendComponent),
      structure_quality:    structComponent,
      entry_precision:      entryComponent,
      volume_confirmation:  volConfComponent,
      volatility_alignment: volAlignComponent,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// V6.5.3 — EXPECTED VALUE MODEL
// Estimates trade win probability and EV. Only positive-EV trades proceed.
// ═══════════════════════════════════════════════════════════════════════════════

// ── V7.0.4.1 EXPECTED VALUE MODEL — CIRCULAR DEPENDENCY FIX ──────────────────
// BUG: The old EV model computed win probability from weightedScore + confidence,
// which are themselves derived from the same RSI/MACD/BB values. The EV number
// looked mathematical but added no independent evidence — it was circular.
//
// FIX: When real historical data exists in SQLite (>=5 trades for the tier),
// we use the actual observed win rate as a Bayesian prior and blend it with the
// indicator-derived estimate. This means after ~2 weeks of trading, the EV model
// becomes genuinely data-driven and self-improving.
//
// Blending formula:
//   historicalWeight = min(1.0, tierUses / 20)   — full weight at 20+ trades
//   indicatorWeight  = 1 - historicalWeight
//   rawProb = historicalRate * historicalWeight + indicatorEstimate * indicatorWeight
// ──────────────────────────────────────────────────────────────────────────────
function calcExpectedValue(weightedScore, confluence, marketPhase, confidence, volatilityTier, signalTierHint) {
  // ── Indicator-derived estimate (same as before, but now only one input) ────
  const scoreBoost   = Math.max(0, (weightedScore - 60) / 250);
  const scoreDiff    = Math.abs(confluence.bullScore - confluence.bearScore);
  const totalScore   = confluence.bullScore + confluence.bearScore;
  const conflRaw     = totalScore > 0 ? scoreDiff / totalScore : 0;
  const confBoost    = conflRaw * 0.12;
  const confLvl      = Math.max(0, (confidence - 60) / 330);
  const phaseMulti   = marketPhase === "TRENDING" ? 1.05 : marketPhase === "RANGING" ? 1.02 : 0.90;
  const volAdjust    = volatilityTier === "HIGH" ? -0.01 : volatilityTier === "LOW" ? -0.02 : 0;

  const indicatorEst = Math.min(0.82, Math.max(0.42,
    // [BUG4-FIX] was 0.53 — RANGING pairs with low confluence produced indicatorEst < 0.50
    // causing ev.positive=false and silent exclusion from all candidate lists.
    // Lowered to 0.50 so the base is neutral; boosts still lift high-confluence setups.
    (0.50 + scoreBoost + confBoost + confLvl + volAdjust) * phaseMulti
  ));

  // ── Historical win rate prior from SQLite tier performance ─────────────────
  let rawProb = indicatorEst;
  let historicalBlend = false;
  let historicalRate  = null;

  if (signalTierHint) {
    const tierKey  = signalTierHint === "A" ? "A" : signalTierHint === "B" ? "B" : "C";
    const perfData = tierPerformance[tierKey];
    if (perfData && perfData.uses >= 5) {
      // Enough real trades to use as a meaningful prior
      const realWinRate = perfData.wins / (perfData.wins + perfData.losses);
      // Blend: ramp historical weight from 0→1 as uses grows from 5→25
      const historicalWeight = Math.min(1.0, (perfData.uses - 5) / 20);
      const indicatorWeight  = 1 - historicalWeight;
      rawProb = Math.min(0.85, Math.max(0.38,
        realWinRate * historicalWeight + indicatorEst * indicatorWeight
      ));
      historicalBlend = true;
      historicalRate  = parseFloat(realWinRate.toFixed(3));
    }
  }

  const ev       = 2 * rawProb - 1;
  const positive = ev > 0;

  return {
    ev:             parseFloat(ev.toFixed(3)),
    winProbability: parseFloat(rawProb.toFixed(3)),
    positive,
    historicalBlend,
    historicalRate,
    reason: positive
      ? `EV positive (${(ev*100).toFixed(1)}%) — win prob ${(rawProb*100).toFixed(0)}%` +
        (historicalBlend ? ` [blended w/ ${(historicalRate*100).toFixed(0)}% real win rate]` : " [indicator-only]")
      : `EV negative (${(ev*100).toFixed(1)}%) — win prob ${(rawProb*100).toFixed(0)}% insufficient`,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// V6.5.3 — TRADE TIER CLASSIFIER  (A / B / C)
// A = elite setup. B = solid. C = marginal but positive EV. SKIP = reject.
// Tier C restricted to safe conditions only, never auto-rejected.
// ═══════════════════════════════════════════════════════════════════════════════

function classifyTradeTier(confidence, weightedScore, ev, marketQualityScore, volStability, mtfConfirmed, entryPrecision, marketPhase) {
  const highConf    = confidence >= 80;
  const highWScore  = weightedScore >= 72;
  const strongEV    = ev.winProbability >= 0.65;
  const goodQuality = marketQualityScore >= 62;   // FIX: was 78 — external threshold lowered but this was never updated, pushing pairs to SKIP
  const stable      = volStability?.stable ?? true;
  const mtfOk       = mtfConfirmed;
  const entryOk     = entryPrecision?.valid ?? true;
  const goodPhase   = marketPhase === "TRENDING" || marketPhase === "RANGING";

  const topCount = [highConf, highWScore, strongEV, goodQuality, stable, mtfOk, entryOk].filter(Boolean).length;

  if (topCount >= 4 && goodPhase)                return "A";   // FIX: was 5 — too strict for real forex
  if (topCount >= 2 && ev.positive && goodPhase) return "B";   // FIX: was 3 — 3/7 criteria was blocking most valid setups
  if (ev.positive && goodPhase && stable)        return "C";
  return "SKIP";
}

// ═══════════════════════════════════════════════════════════════════════════════
// V6.5.3 — CONTEXTUAL THRESHOLD ADJUSTER
// In favorable conditions → relax threshold. In uncertain → tighten.
// ═══════════════════════════════════════════════════════════════════════════════

function getContextualThreshold(baseThreshold, marketPhase, volSession, silenceDuration) {
  let threshold = baseThreshold;
  if (volSession.inSession)         threshold -= 3;
  if (marketPhase === "TRENDING")   threshold -= 2;
  if (silenceDuration >= SILENCE_TIER_B_MS) threshold -= 4;
  if (silenceDuration >= SILENCE_TIER_C_MS) threshold -= 6;
  if (volSession.volatility === "high")     threshold += 3;
  // V8.0: Extra relief for low-vol sessions — evening/Asian naturally produce
  // lower quality scores due to tighter spreads and lower ATR.
  // Without this, the effective threshold blocks most valid evening setups.
  const sessKey = (activeSessionKey || "").replace("PRE_", "");
  if (sessKey === "EVENING" || sessKey === "ASIAN") threshold -= 5;
  return Math.max(SIGNAL_QUALITY_FLOOR, threshold);
}

// ═══════════════════════════════════════════════════════════════════════════════
// V6.5.3 — ADAPTIVE TIER WEIGHT
// Adjusts preference for tiers based on recent win rates.
// ═══════════════════════════════════════════════════════════════════════════════

function getTierAdaptiveWeight(tier) {
  const key  = tier === "A" ? "A" : tier === "B" ? "B" : "C";
  const perf = tierPerformance[key];
  if (!perf || perf.uses < 3) return 1.0;
  const winRate = perf.wins / (perf.wins + perf.losses);
  if (winRate >= 0.60) return 1.20;
  if (winRate <= 0.40) return 0.75;
  return 1.0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// V6.5.3 — ANTI-SILENCE STATE
// ═══════════════════════════════════════════════════════════════════════════════

function getAntiSilenceState() {
  const now     = Date.now();
  const elapsed = lastSignalEmittedAt > 0 ? now - lastSignalEmittedAt : 0;
  return {
    silenceDurationMs: elapsed,
    tierBUnlocked:     elapsed >= SILENCE_TIER_B_MS,
    tierCUnlocked:     elapsed >= SILENCE_TIER_C_MS,
    silenceLabel:      elapsed >= SILENCE_TIER_C_MS ? "EXTENDED_SILENCE"
                     : elapsed >= SILENCE_TIER_B_MS ? "MODERATE_SILENCE" : "NORMAL",
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// V6.5.3 — SMARTER REVALIDATION GATE
// Only cancels on MAJOR structural change; minor fluctuations pass through.
// ═══════════════════════════════════════════════════════════════════════════════

function isRevalidationCriticalBlock(originalAnalysis, freshAnalysis) {
  if (originalAnalysis.direction !== freshAnalysis.direction)       return true;
  if (freshAnalysis.marketPhase  === "CHAOTIC")                    return true;
  if (freshAnalysis.marketPhase  === "LOW_VOLATILITY")             return true;
  if (freshAnalysis.expiryNull)                                    return true;
  const confDrop = originalAnalysis.confidence - freshAnalysis.confidence;
  if (confDrop > 12)                                               return true;
  if ((freshAnalysis.weightedScore ?? 100) < SIGNAL_QUALITY_FLOOR) return true;
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════════
// V6.5.3 — ADAPTIVE LEARNING: UPDATE TIER PERFORMANCE
// ═══════════════════════════════════════════════════════════════════════════════

function updateTierPerformance(tier, result) {
  const key = tier === "A+" || tier === "A" ? "A" : tier === "B" ? "B" : "C";
  if (!tierPerformance[key]) return;
  tierPerformance[key].uses++;
  if (result === "WIN")  tierPerformance[key].wins++;
  if (result === "LOSS") tierPerformance[key].losses++;
  // V6.5.6: persist immediately so restarts pick up latest state
  try { saveTierPerformance(tierPerformance); } catch {}
}


// ═══════════════════════════════════════════════════════════════════════════════
// SESSION STATE MACHINE  [PROTECTED]
// ═══════════════════════════════════════════════════════════════════════════════

function resolveActivePairs(allPricePairs, currentKey) {
  const now = Date.now();

  // [BUG7-FIX] Weekend OTC guard — runs at entry on every call so it catches stale
  // sessionPairs populated during a Friday pre-scan (Forex pairs) that persist into
  // Saturday/Sunday. When isWeekend() is true, strip all non-OTC pairs from both
  // sessionPairs and backupPairs so filteredAnalyses (OTC-only) always intersects correctly.
  if (isWeekend()) {
    const hadForex = sessionPairs.some((p) => FOREX_PAIR_IDS.has(p));
    if (hadForex) {
      console.log(`[BUG7-FIX] Weekend detected — purging Forex pairs from sessionPairs: [${sessionPairs.filter(p => FOREX_PAIR_IDS.has(p)).join(", ")}]`);
      sessionPairs = sessionPairs.filter((p) => OTC_PAIR_IDS.has(p));
      backupPairs  = backupPairs.filter((p) => OTC_PAIR_IDS.has(p));
      activePairs  = sessionPairs.length > 0 ? [...sessionPairs] : null;
      // If we wiped sessionPairs entirely, force a full re-score next call
      if (sessionPairs.length === 0) {
        preSessionExecuted   = false;
        lastRefreshTimestamp = null;
        console.log(`[BUG7-FIX] sessionPairs now empty after Forex purge — forcing re-score from OTC pairs`);
      }
    }
  }

  if (currentKey === "OFF_HOURS") {
    if (activeSessionKey !== "OFF_HOURS") {
      activePairs          = null;
      activeSessionKey     = "OFF_HOURS";
      lastRefreshTimestamp = now;
      preSessionExecuted   = false;
      usedPairs            = {};
      console.log(`[V9.0] SESSION→PAIRS | session=OFF_HOURS | activePairs=ALL | preSessionExecuted=false`);
    }
    return allPricePairs;
  }

  if (!sameSessionGroup(currentKey, activeSessionKey)) {
    preSessionExecuted = false;
    usedPairs          = {};
    console.log(`[V8.0] SESSION CHANGE | ${activeSessionKey || "none"} → ${currentKey} | resetting pair state`);

    // V8.0 FIX: Auto-clear sessionStopped when a NEW session starts.
    // Previously, 2 consecutive losses in LONDON would block ALL subsequent
    // sessions (NEWYORK, EVENING) until the user manually clicked Reset.
    // Now it auto-resets when the session key changes — each session gets a
    // fresh slate. Manual Reset still works for within-session resets.
    if (_sessionStopped && activeSessionKey && activeSessionKey !== "OFF_HOURS") {
      _sessionStopped = false;
      _sessionLog.consecutiveLosses = 0;
      console.log(`[V8.0] SESSION STOPPED flag auto-cleared — new session ${currentKey} starts fresh`);
    }
  }

  const sameGroup    = sameSessionGroup(currentKey, activeSessionKey);
  const needsRefresh = lastRefreshTimestamp !== null &&
                       (now - lastRefreshTimestamp) > REFRESH_INTERVAL_MS;

  if (sameGroup && activePairs !== null && preSessionExecuted && !needsRefresh) {
    console.log(`[V9.0] SESSION→PAIRS | session=${currentKey} | activePairs=[${activePairs.join(", ")}] | source=locked_cache`);
    return allPricePairs.filter((p) => activePairs.includes(p.pair));
  }

  const sessionGroupKey = currentKey.replace("PRE_", "");
  const preSelected = getPreSelectedPairs(sessionGroupKey);

  if (preSelected && preSelected.selectedPairs.length > 0 && !needsRefresh) {
    sessionPairs = preSelected.selectedPairs;
    backupPairs  = preSelected.backupPairs;
    pairBias     = {};
    activePairs          = [...sessionPairs];
    sessionTradeCount    = 0;
    activeSessionKey     = currentKey;
    lastRefreshTimestamp = now;
    preSessionExecuted   = true;
    allPricePairs
      .filter((p) => p.prices && p.prices.length >= 30)
      .forEach((p) => { pairBias[p.pair] = calcDirectionalBias(p.prices); });
    // ── SECTION 1 DEBUG LOG: session → selectedPairs → activePairs ──
    console.log(`[V9.0] SESSION→PAIRS | session=${currentKey} | source=pre_session_scan | trigger=${preSelected.triggerType} | at=${preSelected.triggeredAt}`);
    console.log(`[V9.0] selectedPairs=[${preSelected.selectedPairs.join(", ")}]`);
    console.log(`[V9.0] backupPairs  =[${preSelected.backupPairs.join(", ")}]`);
    console.log(`[V9.0] activePairs  =[${activePairs.join(", ")}] (used in scan)`);
    return allPricePairs.filter((p) => activePairs.includes(p.pair));
  }

  // No pre-scan available → real-time scoring
  const reason = needsRefresh ? "refresh_required" : "no_prescan";
  console.log(`[V8.0] SESSION→PAIRS | session=${currentKey} | source=realtime_score | reason=${reason}`);

  const allScored = allPricePairs
    .filter((p) => p.prices && p.prices.length >= 30)
    .map((p) => ({
      pair:  p.pair,
      score: scorePairForPreSelection(p.prices),
      bias:  calcDirectionalBias(p.prices),
    }))
    .sort((a, b) => b.score - a.score);

  // V8.0 FIX: Session-aware qualification threshold.
  // AUDIT FINDING: Evening/Asian sessions have naturally lower volatility.
  // A blanket score >= 60 threshold rejected ALL pairs during these sessions,
  // causing complete silence. Fix: lower threshold for low-vol sessions,
  // and ALWAYS guarantee a minimum of 6 pairs regardless of score.
  const isLowVolSession = currentKey === "EVENING" || currentKey === "ASIAN" ||
                          currentKey === "PRE_EVENING" || currentKey === "PRE_ASIAN";
  const PRESCAN_THRESHOLD = isLowVolSession ? 40 : 55;   // was hardcoded 60

  const qualified = allScored.filter((p) => p.score >= PRESCAN_THRESHOLD);
  console.log(`[V8.0] Pre-selection: ${allScored.length} pairs scored | threshold=${PRESCAN_THRESHOLD} | qualified=${qualified.length} | session=${currentKey}`);

  if (qualified.length >= 8) {
    sessionPairs = qualified.slice(0, 8).map((p) => p.pair);
    backupPairs  = qualified.slice(8, 11).map((p) => p.pair);
  } else if (qualified.length >= 6) {
    sessionPairs = qualified.slice(0, 6).map((p) => p.pair);
    backupPairs  = qualified.slice(6, 9).map((p) => p.pair);
  } else if (qualified.length >= 3) {
    sessionPairs = qualified.slice(0, qualified.length).map((p) => p.pair);
    backupPairs  = allScored.filter((p) => p.score < PRESCAN_THRESHOLD).slice(0, 3).map((p) => p.pair);
  } else {
    // V8.0 GUARANTEE: Always use top 6 pairs even if none meet threshold.
    // Silent engine is worse than trading on the best available pairs.
    console.log(`[V8.0] No pairs met threshold ${PRESCAN_THRESHOLD} — falling back to top 6 by score`);
    sessionPairs = allScored.slice(0, 6).map((p) => p.pair);
    backupPairs  = allScored.slice(6, 9).map((p) => p.pair);
  }

  pairBias = {};
  allScored.forEach((p) => { pairBias[p.pair] = p.bias; });

  if (sessionGroupKey && sessionGroupKey !== "OFF_HOURS") {
    storePreScan(
      sessionGroupKey,
      sessionPairs,
      backupPairs,
      allScored.map((p) => ({ pair: p.pair, score: p.score })),
      "realtime"
    );
  }

  activePairs          = [...sessionPairs];
  sessionTradeCount    = 0;
  activeSessionKey     = currentKey;
  lastRefreshTimestamp = now;
  preSessionExecuted   = true;

  // ── SECTION 1 DEBUG LOG: session → selectedPairs → activePairs ──
  console.log(`[V9.0] selectedPairs=[${sessionPairs.join(", ")}] (scored realtime)`);
  console.log(`[V9.0] backupPairs  =[${backupPairs.join(", ")}]`);
  console.log(`[V9.0] activePairs  =[${activePairs.join(", ")}] (used in scan) | session=${currentKey}`);
  console.log(`[V9.0] No silent fallback — reason logged above`);
  return allPricePairs.filter((p) => activePairs.includes(p.pair));
}

// ═══════════════════════════════════════════════════════════════════════════════
// SIGNAL BUILDER — V6.5.6: adds positionSize + entryInstruction to output
// ═══════════════════════════════════════════════════════════════════════════════

function buildSignal(analysis) {
  const {
    pair, structure, confluence, volSession,
    marketPhase, marketQualityScore,
    strategyUsed, rangeData, rangeEntry,
    signalTier, mtfConfirmation, entryPrecision,
    direction, confidence, timeframe, expiry, expirySecs, entryWindow,
    volatilityTier, strength, expiryReason,
    ev,   // V6.5.6: needed for position sizing
  } = analysis;
  const isBuy = direction === "BUY";

  // V6.5.6: dynamic position sizing and entry instruction
  const positionSize     = calcPositionSize(signalTier, confidence, ev);
  const entryInstruction = buildEntryInstruction(entryWindow, expiry, expirySecs);

  const trendReason = structure.trend === "sideways"
    ? `Sideways consolidation — EMA50 (${structure.ema50}) and EMA200 (${structure.ema200}) converging`
    : `${structure.trend === "uptrend" ? "Uptrend" : "Downtrend"} — EMA50 (${structure.ema50}) ${structure.ema50 > structure.ema200 ? "above" : "below"} EMA200 (${structure.ema200})`;

  const parts = [];
  if (isBuy) {
    if (confluence.rsiOversold)      parts.push(`RSI oversold (${confluence.rsi})`);
    else if (confluence.rsiBullish)  parts.push(`RSI bullish (${confluence.rsi})`);
    if (confluence.macdCrossUp)      parts.push("MACD bullish crossover");
    else if (confluence.macdBullish) parts.push("MACD histogram rising");
    if (confluence.bbBullish)        parts.push("price at lower Bollinger Band");
    if (confluence.maCrossUp)        parts.push("EMA9 crossed above EMA21");
    else if (confluence.maBullish)   parts.push("EMA9 above EMA21");
  } else {
    if (confluence.rsiOverbought)    parts.push(`RSI overbought (${confluence.rsi})`);
    else if (confluence.rsiBearish)  parts.push(`RSI bearish (${confluence.rsi})`);
    if (confluence.macdCrossDown)    parts.push("MACD bearish crossover");
    else if (confluence.macdBearish) parts.push("MACD histogram falling");
    if (confluence.bbBearish)        parts.push("price at upper Bollinger Band");
    if (confluence.maCrossDown)      parts.push("EMA9 crossed below EMA21");
    else if (confluence.maBearish)   parts.push("EMA9 below EMA21");
  }
  const indicatorReason = parts.length > 0
    ? parts.join(", ")
    : `Confluence score — Bull: ${confluence.bullScore}, Bear: ${confluence.bearScore}`;

  // Zone reason — aware of strategy
  let zoneReason;
  if (strategyUsed === STRATEGY_RANGE && rangeData) {
    zoneReason = isBuy
      ? `RANGE strategy — BUY at support (${rangeData.support}), ${rangeEntry?.reason || ""}`
      : `RANGE strategy — SELL at resistance (${rangeData.resistance}), ${rangeEntry?.reason || ""}`;
  } else if (isBuy && structure.nearSupport) {
    zoneReason = `Near support zone (${structure.support}) — bullish bounce setup`;
  } else if (!isBuy && structure.nearResistance) {
    zoneReason = `Near resistance zone (${structure.resistance}) — bearish rejection setup`;
  } else if (isBuy && structure.breakoutUp) {
    zoneReason = `Bullish breakout above ${structure.resistance}`;
  } else if (!isBuy && structure.breakoutDown) {
    zoneReason = `Bearish breakout below ${structure.support}`;
  } else {
    zoneReason = `Price at ${(structure.pricePos * 100).toFixed(0)}% of S/R range`;
  }

  const sessionReason = volSession.inSession
    ? `${volSession.sessionName} — ${volSession.volatility} volatility`
    : `Off-hours (${volSession.gmt1Time} GMT+1) — ${volSession.volatility} volatility`;

  const warnings = [];
  if (!volSession.inSession)     warnings.push("Outside London/NY/Evening session windows — reduce position size");
  if (volSession.volatility === "high") warnings.push("High volatility — wider spreads expected");
  if (strength === "WEAK")       warnings.push("Weak setup — consider skipping or halving trade size");
  if (marketQualityScore < 80)   warnings.push(`Market quality borderline (${marketQualityScore}/100) — trade with caution`);

  return {
    pair,
    direction,
    confidence,
    timeframe,
    expiry,
    expirySecs,        // V6.3
    strength,
    entryWindow,
    entryInstruction,  // V6.5.6: dynamic instruction replacing "second candle"
    positionSize,      // V6.5.6: dynamic risk sizing
    volatilityTier,
    expiryReason,      // V6.3
    marketPhase,
    marketQualityScore,
    strategyUsed,      // V6.3: "TREND" | "RANGE" | "NONE"
    signalTier,
    bias:              pairBias[pair] || "neutral",
    mtfConfirmed:      analysis.mtfConfirmation?.confirmed ?? true,
    entryPrecision:    analysis.entryPrecision,
    noTrade:           false,
    marketType:        getMarketType(pair),
    rangeData:         rangeData || null,   // V6.3: range zone details
    reasons: { trend: trendReason, indicators: indicatorReason, zone: zoneReason, session: sessionReason },
    warnings,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// V6.3 — FOREX PRIORITY SIGNAL ASSEMBLER  (Task 3 — true priority, not just sort)
// Execution flow:
//   1. Collect valid Forex candidates
//   2. If Forex count >= FOREX_MIN_THRESHOLD → use Forex only
//   3. If Forex insufficient → supplement with OTC (still must pass all filters)
//   4. Select single best candidate (sequential engine preserved)
// ═══════════════════════════════════════════════════════════════════════════════

function assembleSignals(analyses, mode) {
  const now      = Date.now();
  const noTrades = [];

  // FIX [3]: OTC/Forex tab filter — mode was received but NEVER applied.
  // Result: clicking OTC or Forex tab had zero effect. Now properly filters.
  let filteredAnalyses = analyses;
  if (mode === "forex") {
    filteredAnalyses = analyses.filter((a) => FOREX_PAIR_IDS.has(a.pair));
    if (filteredAnalyses.length === 0) {
      // Restore all if filter empties the pool (e.g., weekend)
      filteredAnalyses = analyses;
      console.log("[V9.0] Forex filter: no forex pairs available — using all pairs");
    }
  } else if (mode === "otc") {
    filteredAnalyses = analyses.filter((a) => OTC_PAIR_IDS.has(a.pair));
    if (filteredAnalyses.length === 0) {
      filteredAnalyses = analyses;
      console.log("[V9.0] OTC filter: no OTC pairs available — using all pairs");
    }
  }

  const sessionAnalyses = filteredAnalyses.filter((a) => sessionPairs.includes(a.pair));
  const backupAnalyses  = filteredAnalyses.filter((a) => backupPairs.includes(a.pair));

  const candidates   = [];
  const stillCooling = [];

  for (const analysis of sessionAnalyses) {
    const lastUsed   = usedPairs[analysis.pair] || 0;
    const cooledDown = (now - lastUsed) >= PAIR_COOLDOWN_MS(activeSessionKey);
    const neverUsed  = lastUsed === 0;

    if (analysis.filter.shouldSkip) {
      noTrades.push({
        pair:           analysis.pair,
        noTrade:        true,
        noTradeReasons: analysis.filter.reasons,
        strength:       "BLOCKED",
        marketType:     getMarketType(analysis.pair),
        strategyUsed:   analysis.strategyUsed || STRATEGY_NONE,
        marketPhase:    analysis.marketPhase,
      });
      continue;
    }

    const bias  = pairBias[analysis.pair] || "neutral";
    const isBuy = analysis.direction === "BUY";

    // FIX [2]: Bias filter was a HARD block — valid counter-trend retracement
    // entries were silently killed. Bias is computed once at pre-selection and
    // frozen for the entire session. Real markets reverse mid-session constantly.
    // Fix: downgrade confidence instead of blocking outright. Only hard-block
    // when bias is extreme AND market phase is confirmed trending (double condition).
    const biasConflict = (bias === "bullish" && !isBuy) || (bias === "bearish" && isBuy);
    if (biasConflict) {
      // V7.0.4.2 [FIX G]: was blocking any TRENDING phase with bias conflict.
      // Pre-selection bias is frozen at session start — market can reverse mid-session.
      // Only hard-skip if trendStrength is maximum (2) AND phase is TRENDING.
      const isConfirmedTrend = analysis.marketPhase === "TRENDING" && (analysis.trendStrength ?? 0) >= 2;
      if (isConfirmedTrend) {
        // Strong confirmed trend + bias conflict → soft block only
        noTrades.push({
          pair:           analysis.pair,
          noTrade:        true,
          noTradeReasons: [`Bias warning: pair bias is ${bias.toUpperCase()} — ${analysis.direction} direction is counter-trend. Skipping in confirmed TRENDING phase.`],
          strength:       "BIAS_WARNING",
          marketType:     getMarketType(analysis.pair),
        });
        continue;
      }
      // In RANGING/CHAOTIC: bias conflict is acceptable — just reduce confidence
      analysis.confidence = Math.max(50, (analysis.confidence || 70) - 10);
      analysis.warnings   = [...(analysis.warnings || []), `Counter-bias trade (${bias}) — confidence reduced`];
    }

    if (neverUsed || cooledDown) {
      candidates.push(analysis);
    } else {
      const minsLeft = Math.ceil((PAIR_COOLDOWN_MS(activeSessionKey) - (now - lastUsed)) / 60000);
      stillCooling.push({ pair: analysis.pair, minsLeft });
    }
  }

  // V6.5.5 FIX — Dynamic eviction of weak session pairs.
  // Old rule: evict if score < 65 OR isChoppy — fired too aggressively on a single-cycle dip,
  // could empty sessionPairs entirely. New rule:
  //   • Evict only if score < 50 (absolute floor — pair is genuinely unusable)
  //   • AND isChoppy is only a supporting signal, not a standalone eviction trigger
  //   • GUARD: never evict a pair if it would leave sessionPairs with 0 entries
  for (const analysis of sessionAnalyses) {
    const isAbsolutelyWeak = analysis.marketQualityScore < 50;
    if (isAbsolutelyWeak) {
      // Guard: don't evict if this is the last pair left
      if (sessionPairs.length <= 1) {
        console.log(`[V6.5.5] Eviction skipped for ${analysis.pair} (score: ${analysis.marketQualityScore}) — last remaining session pair, keeping to avoid full silence`);
        continue;
      }
      const idx = sessionPairs.indexOf(analysis.pair);
      if (idx !== -1) {
        sessionPairs.splice(idx, 1);
        if (!backupPairs.includes(analysis.pair) && backupPairs.length < 4) {
          backupPairs.push(analysis.pair);
        }
        console.log(`[V6.5.5] Evicted weak pair: ${analysis.pair} (quality: ${analysis.marketQualityScore} < 50)`);
      }
    }
  }

  // V6.3 TASK 3 — True Forex Priority: separate forex and otc candidates
  const forexCandidates = candidates.filter((c) => FOREX_PAIR_IDS.has(c.pair));
  const otcCandidates   = candidates.filter((c) => OTC_PAIR_IDS.has(c.pair));

  // Weekend guard — reject all Forex on weekends
  if (isWeekend() && forexCandidates.length > 0) {
    forexCandidates.forEach((c) => {
      noTrades.push({
        pair:           c.pair,
        noTrade:        true,
        noTradeReasons: ["Weekend mode — Forex markets closed, OTC only"],
        strength:       "WEEKEND_BLOCKED",
        marketType:     "forex",
      });
    });
    forexCandidates.length = 0;
  }

  // V6.5.3/4: Dynamic threshold + anti-silence + adaptive tier weights
  const antiSilence      = getAntiSilenceState();
  const firstCandVol     = candidates[0]?.volatilityTier ?? "MEDIUM";
  const baseThreshold    = getDynamicQualityThreshold(firstCandVol);
  const firstCandPhase   = candidates[0]?.marketPhase ?? "TRENDING";
  const firstCandVS      = candidates[0]?.volSession  ?? { inSession: false, volatility: "moderate" };
  const effectiveThresh  = getContextualThreshold(baseThreshold, firstCandPhase, firstCandVS, antiSilence.silenceDurationMs);

  if (antiSilence.tierBUnlocked) {
    console.log(`[V6.5.4] Anti-silence: ${antiSilence.silenceLabel} — threshold relaxed to ${effectiveThresh} (base: ${baseThreshold})`);
  }

  // V6.5.3: Scoring uses weighted score + EV + adaptive tier weights (A/B/C aware)
  const scoreFn = (a) => {
    const tierMap   = { "A": 40, "B": 25, "C": 12, "SKIP": 0 };
    const tierScore = (tierMap[a.signalTier] ?? 0) * getTierAdaptiveWeight(a.signalTier);
    const evBonus   = a.ev?.positive ? Math.round(a.ev.winProbability * 15) : 0;
    const wBonus    = (a.weightedScore ?? 0) * 0.3;
    const marketBonus = FOREX_PAIR_IDS.has(a.pair) ? 10 : 0;
    return tierScore + evBonus + wBonus + a.confidence + marketBonus;
  };

  const sortByCombinedScore = (arr) => [...arr].sort((a, b) => scoreFn(b) - scoreFn(a));

  // Tier C is only admitted under anti-silence or strong EV conditions
  const admitTierC = (c) => {
    if (c.signalTier === "C") {
      if (!antiSilence.tierCUnlocked && !(c.ev?.winProbability >= 0.60)) return false;
      if (lossPrevention.active) return false;   // never force Tier C during loss prevention
    }
    return true;
  };

  // V6.5.4: EV-positive filter with anti-silence fallback
  // FIX: previously pairs failing ev.positive were silently excluded with no fallback — they disappeared entirely
  const evPositiveForex = forexCandidates.filter((c) => c.marketQualityScore >= effectiveThresh && c.ev?.positive && admitTierC(c));
  const evPositiveOtc   = otcCandidates.filter((c) => c.marketQualityScore >= effectiveThresh && c.ev?.positive && admitTierC(c));

  // If ev.positive candidates exist — use them (normal flow)
  // If none exist but anti-silence is active — fallback to best available with ev >= 0.45
  let qualifiedForex, qualifiedOtc;
  if (evPositiveForex.length > 0 || evPositiveOtc.length > 0) {
    qualifiedForex = sortByCombinedScore(evPositiveForex);
    qualifiedOtc   = sortByCombinedScore(evPositiveOtc);
  } else if (antiSilence.tierBUnlocked) {
    // Anti-silence fallback: admit best near-positive EV candidates
    // V8.0: lowered from 0.40 → 0.38 for evening/Asian sessions where EV
    // naturally sits slightly lower due to lower volatility.
    const sessKey = (activeSessionKey || "").replace("PRE_", "");
    const evFloor = (sessKey === "EVENING" || sessKey === "ASIAN") ? 0.38 : 0.40;
    console.log(`[V8.0] EV fallback activated (anti-silence: ${antiSilence.silenceLabel}, evFloor: ${evFloor})`);
    qualifiedForex = sortByCombinedScore(
      forexCandidates.filter((c) => c.marketQualityScore >= effectiveThresh && (c.ev?.winProbability ?? 0) >= evFloor && admitTierC(c))
    );
    qualifiedOtc = sortByCombinedScore(
      otcCandidates.filter((c) => c.marketQualityScore >= effectiveThresh && (c.ev?.winProbability ?? 0) >= evFloor && admitTierC(c))
    );
  } else {
    qualifiedForex = [];
    qualifiedOtc   = [];
  }

  let orderedCandidates;
  if (qualifiedForex.length >= FOREX_MIN_THRESHOLD) {
    // Forex threshold met → Forex first, then OTC as secondary
    orderedCandidates = [...qualifiedForex, ...qualifiedOtc];
    console.log(`[V6.5] Forex priority active: ${qualifiedForex.length} forex, ${qualifiedOtc.length} OTC as backup`);
  } else {
    // Insufficient Forex → use OTC as supplement
    orderedCandidates = [...qualifiedForex, ...qualifiedOtc];
    if (qualifiedForex.length === 0 && qualifiedOtc.length > 0) {
      console.log(`[V6.5] No qualifying Forex signals — using OTC (${qualifiedOtc.length} available)`);
      noTrades.push({
        pair:           "SYSTEM",
        noTrade:        true,
        noTradeReasons: [`No qualifying Forex signals (threshold: ${FOREX_MIN_THRESHOLD}) — OTC signals active`],
        strength:       "INFO",
      });
    }
  }

  // V7.0.5: Emit TOP 3 tradeable signals (not just 1).
  // The best signal (#1) goes to Telegram. #2 and #3 are visible in the UI
  // so the VIP group can see context. Only ONE is ever sent to Telegram.
  const TOP_N = 3;
  const topCandidates = orderedCandidates.slice(0, TOP_N);
  let selectedAnalysis = topCandidates[0] || null;

  // Backup pairs fallback
  if (!selectedAnalysis && backupAnalyses.length > 0) {
    console.log("[V6.5] All sessionPairs failed — activating backupPairs");
    noTrades.push({
      pair:           "SYSTEM",
      noTrade:        true,
      noTradeReasons: ["All session pairs blocked — switching to backup pairs"],
      strength:       "INFO",
    });

    for (const analysis of backupAnalyses) {
      if (analysis.filter.shouldSkip) continue;
      // [BUG6-FIX] was SIGNAL_QUALITY_THRESHOLD (52) — backup pairs hit the same double-gate as primary.
      // Use absolute floor only; the upstream filter already enforced 52.
      if (analysis.marketQualityScore < SIGNAL_QUALITY_FLOOR) continue;
      const lastUsed   = usedPairs[analysis.pair] || 0;
      const cooledDown = (now - lastUsed) >= PAIR_COOLDOWN_MS(activeSessionKey);
      const neverUsed  = lastUsed === 0;
      if (!neverUsed && !cooledDown) continue;

      const bias  = pairBias[analysis.pair] || "neutral";
      const isBuy = analysis.direction === "BUY";
      if (bias === "bullish" && !isBuy) continue;
      if (bias === "bearish" && isBuy)  continue;

      selectedAnalysis = analysis;
      break;
    }

    if (!selectedAnalysis) {
      noTrades.push({
        pair:           "SYSTEM",
        noTrade:        true,
        noTradeReasons: ["Backup pairs also failed — NO TRADE this cycle"],
        strength:       "INFO",
      });
    }
  }

  const result = [];
  // V7.0.5: Emit up to TOP_N=3 tradeable signals.
  // Signal #1 is the one sent to Telegram. #2 and #3 are visible in the UI
  // so the VIP group can see the context — only #1 is ever dispatched.
  if (topCandidates.length > 0) {
    topCandidates.forEach((analysis) => result.push(buildSignal(analysis)));
  } else if (selectedAnalysis) {
    result.push(buildSignal(selectedAnalysis));
  }
  result.push(...noTrades);

  for (const cp of stillCooling) {
    result.push({
      pair:           cp.pair,
      noTrade:        true,
      noTradeReasons: [`Pair in cooldown — available in ~${cp.minsLeft} min`],
      strength:       "COOLDOWN",
    });
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TRADE LOG  [PROTECTED — extended with V6.3 fields]
// ═══════════════════════════════════════════════════════════════════════════════

function logTrade(signal) {
  const entryTimestamp  = Date.now();
  const expiryMinutes   = parseInt(signal.expiry) || 1;
  const expiryTimestamp = entryTimestamp + expiryMinutes * 60 * 1000;

  const record = {
    id:                 `${signal.pair}_${entryTimestamp}`,
    pair:               signal.pair,
    direction:          signal.direction,
    timeframe:          signal.timeframe,
    expiry:             signal.expiry,
    expirySecs:         signal.expirySecs,
    expiryReason:       signal.expiryReason,
    entryTimestamp,
    expiryTimestamp,
    marketPhase:        signal.marketPhase,
    strategyUsed:       signal.strategyUsed,
    marketType:         signal.marketType || getMarketType(signal.pair),
    confidence:         signal.confidence,
    marketQualityScore: signal.marketQualityScore,
    volatilityTier:     signal.volatilityTier,
    signalTier:         signal.signalTier,
    positionSize:       signal.positionSize ?? null,   // V6.5.6
    entryPrice:         signal.entryPrice   ?? null,   // V6.5.6
    result:             null,
  };

  tradeLog.push(record);
  if (tradeLog.length > 100) tradeLog = tradeLog.slice(-100);
  usedPairs[signal.pair] = entryTimestamp;

  // V6.5.6: persist to SQLite immediately
  try {
    saveTrade({
      ...record,
      session: activeSessionKey ?? null,
    });
  } catch (err) {
    console.warn("[V6.5.6] saveTrade failed:", err.message);
  }
}

function updateTradeResult(id, result, exitPrice = null) {
  const entry = tradeLog.find((t) => t.id === id);
  if (entry) {
    entry.result    = result;
    entry.exitPrice = exitPrice;
    console.log(`[V6.5.6] Trade result updated: ${id} → ${result}${exitPrice ? ` (exit: ${exitPrice})` : ""}`);
    // V6.5.6: persist to SQLite
    try { updateTradeResultDb(id, result, exitPrice); } catch {}
    return true;
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SYNTHETIC PRICE GENERATORS PERMANENTLY REMOVED
// Per specification Section 6.2: If real data is missing, the answer is "no signal".
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// V6.5.6 [1] — DYNAMIC POSITION SIZING
// Driven by tier (A/B/C), confidence, and EV win probability.
// Hard cap: 2.5% per trade. Hard floor: 0.5%. Base: 1.0% of balance.
// ═══════════════════════════════════════════════════════════════════════════════

function calcPositionSize(signalTier, confidence, ev, baseRiskPct = 1.0) {
  let size = baseRiskPct;

  // Tier multiplier — A trades get more, C trades get less
  const tierMulti = { "A": 1.5, "B": 1.0, "C": 0.5, "SKIP": 0 };
  size *= (tierMulti[signalTier] ?? 1.0);

  // Confidence adjustment
  if (confidence >= 85)     size *= 1.2;
  else if (confidence < 65) size *= 0.7;

  // EV adjustment — only boost on high-probability setups
  if (ev?.winProbability >= 0.68)      size *= 1.1;
  else if (ev?.winProbability < 0.55)  size *= 0.8;

  // Hard cap and floor — never exceed 2.5%, never drop below 0.5%
  return parseFloat(Math.min(2.5, Math.max(0.5, size)).toFixed(1));
}

// ═══════════════════════════════════════════════════════════════════════════════
// V6.5.6 [3] — DYNAMIC ENTRY INSTRUCTION BUILDER
// Replaces the static "enter on the second candle" message.
// Derived from signal.entryWindow (engine-computed) + expiry + expirySecs.
// ═══════════════════════════════════════════════════════════════════════════════

function buildEntryInstruction(entryWindow, expiry, expirySecs) {
  // entryWindow is already computed by the expiry engine (e.g. "15s", "25s", "40s")
  if (entryWindow) {
    return `Enter within the first ${entryWindow} of next candle open. Expiry: ${expiry || "—"}.`;
  }
  // Fallback: derive from raw expirySecs when entryWindow is absent
  if (!expirySecs) return `Enter at next candle open. Expiry: ${expiry || "—"}.`;
  if (expirySecs <= 60)  return `Enter immediately at candle open — no delay (${expiry} expiry, tight window).`;
  if (expirySecs <= 120) return `Enter within the first 20s of next candle open. Expiry: ${expiry}.`;
  if (expirySecs <= 180) return `Enter within the first 30s of next candle open. Expiry: ${expiry}.`;
  return `Enter within the first 40s of next candle open. Expiry: ${expiry}.`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// V6.5.6 [2] — AUTO WIN/LOSS OUTCOME DETECTION
// Fires automatically after each signal emission for forex pairs.
// At expirySecs + 5s: fetches exit price from Python /price/:pair,
// computes WIN/LOSS, updates tradeLog + tierPerformance + SQLite.
// OTC pairs have no reliable post-expiry price — they use manual PATCH fallback.
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE A (A6): SHADOW OUTCOME EVALUATION ONLY (MODEL TRAINING LABEL)
// Does NOT touch _sessionLog, tier_performance, or user win rate.
// Computes shadow_result strictly from Deriv CLOSED candles:
//   entry = open of the first candle starting at/after the signal's intended entry time
//   exit  = close of the candle ending at expiry
//   tie   = entry === exit
// Persisted in journal.shadow_result ONLY.
// ═══════════════════════════════════════════════════════════════════════════════

function scheduleOutcomeCheck(signal) {
  const expirySecs = signal.expirySecs ?? 60;
  // Check after expiry + 65s so the exit candle is guaranteed fully closed
  const checkAt = (expirySecs + 65) * 1000;

  setTimeout(async () => {
    try {
      const pairClean = signal.pair.replace(/ OTC$/i, "").trim();
      const internalToken = process.env.INTERNAL_API_TOKEN || "dev_internal_token_signalex_2026";
      const res = await fetch(`${PYTHON_BACKEND}/candles/${encodeURIComponent(pairClean)}?n=15`, {
        headers: { "X-Internal-Token": internalToken },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return;
      const data = await res.json();
      const candles = data.candles || [];
      if (candles.length < 2) return;

      const signalEpoch = Math.floor((signal.timestamp || Date.now()) / 1000);
      const expiryEpoch = signalEpoch + expirySecs;

      // Entry = open of the first candle starting at/after intended entry time
      const entryCandle = candles.find((c) => c.epoch >= signalEpoch) || candles[0];
      // Exit = close of the candle ending at expiry
      const exitCandle = [...candles].reverse().find((c) => c.epoch <= expiryEpoch) || candles[candles.length - 1];

      const entryPrice = entryCandle?.open;
      const exitPrice  = exitCandle?.close;
      if (entryPrice == null || exitPrice == null) return;

      let shadowResult = "TIE";
      if (signal.direction === "BUY") {
        shadowResult = exitPrice > entryPrice ? "WIN" : (exitPrice < entryPrice ? "LOSS" : "TIE");
      } else {
        shadowResult = exitPrice < entryPrice ? "WIN" : (exitPrice > entryPrice ? "LOSS" : "TIE");
      }

      // Store in journal.shadow_result (model training only — NEVER in _sessionLog)
      updateJournalShadowResult(signal.id, shadowResult);

      console.log(
        `[Phase A SHADOW] ${signal.pair} ${signal.direction} → ${shadowResult}` +
        ` | entry(O): ${entryPrice} | exit(C): ${exitPrice} | signalId: ${signal.id}`
      );
    } catch (err) {
      console.warn(`[Phase A] Shadow outcome check failed for ${signal.pair}:`, err.message);
    }
  }, checkAt);
}

// ═══════════════════════════════════════════════════════════════════════════════
// V6.5.6 [5] — BACKEND HEALTH CHECK
// Called before fetchRealPrices. If Python is down, no signals are issued.
// No silent demo fallback. Explicit blocked response to caller.
// ═══════════════════════════════════════════════════════════════════════════════

async function checkBackendHealth() {
  try {
    const internalToken = process.env.INTERNAL_API_TOKEN || "dev_internal_token_signalex_2026";
    const res = await fetch(`${PYTHON_BACKEND}/health`, {
      headers: { "X-Internal-Token": internalToken },
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// V6.5.6: Direct JS Yahoo Finance fallback — used if Python is down.
// Only checks EUR/USD and GBP/USD as a lightweight signal that live data
// is reachable at all. Returns { pairs, source } or null.
async function fetchDirectFallback() {
  const DIRECT_PAIRS = [
    { id: "EUR/USD", yf: "EURUSD=X" },
    { id: "GBP/USD", yf: "GBPUSD=X" },
    { id: "USD/JPY", yf: "USDJPY=X" },
  ];
  const results = [];
  for (const p of DIRECT_PAIRS) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${p.yf}?interval=1m&range=2d&includePrePost=false`;
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; SIGNALEX/6.5.6)" },
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) continue;
      const data   = await res.json();
      const block  = data?.chart?.result?.[0];
      if (!block) continue;
      const ts      = block.timestamp ?? [];
      const q       = block.indicators?.quote?.[0] ?? {};
      const candles = [];
      for (let i = 0; i < ts.length; i++) {
        const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
        if (o == null || h == null || l == null || c == null || c === 0) continue;
        candles.push({ open: o, high: h, low: l, close: c, volume: q.volume?.[i] ?? 100, time: ts[i] });
      }
      if (candles.length >= 30) {
        results.push({ pair: p.id, market: "forex", candles, lastPrice: candles[candles.length - 1].close });
      }
    } catch { /* skip this pair */ }
  }
  if (results.length === 0) return null;
  return { pairs: results, source: "direct_yahoo_fallback" };
}

// ═══════════════════════════════════════════════════════════════════════════════
// FETCH REAL PRICES  [PROTECTED]
// ═══════════════════════════════════════════════════════════════════════════════

async function fetchRealPrices() {
  try {
    const data = await resolveAllMarketData(80);
    if (!data?.pairs?.length) return null;
    return { pairs: data.pairs, source: data.source };
  } catch (err) {
    console.warn(`[analyze] Price resolver error: ${err.message}`);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE HANDLER — V6.3
// ═══════════════════════════════════════════════════════════════════════════════


// ═══════════════════════════════════════════════════════════════════════════════
// V6.5 — DYNAMIC NEXT-SIGNAL DELAY CALCULATOR
// Computes when the next signal check should happen, based on:
//   expirySecs   — duration of the active trade
//   volatilityTier — HIGH / MEDIUM / LOW (from getDynamicExpiry)
//
// Buffer formula (dynamic, not fixed):
//   HIGH   → buffer = 15s  (fast market, check sooner)
//   MEDIUM → buffer = 25s  (standard)
//   LOW/other → buffer = 35s (slow/evening, more margin)
//
// nextCheckDelaySecs = expirySecs - buffer
// Hard floor: never less than 10s.
// Hard ceiling: never more than expirySecs (check before expiry, not after).
// Fail-safe: if anything is invalid, default = 60s.
// ═══════════════════════════════════════════════════════════════════════════════

const TIMING_BUFFERS = {
  HIGH:        15,   // fast market — check 15s before expiry
  MEDIUM:      25,   // standard — check 25s before expiry
  LOW:         35,   // slow / thin — check 35s before expiry
  LOW_EVENING: 35,
  DEFAULT:     25,   // fail-safe default buffer
};
const TIMING_FLOOR   = 10;   // never schedule check in less than 10s
const TIMING_FAILSAFE = 60;  // default when calculation is impossible

function computeNextSignalTiming(expirySecs, volatilityTier) {
  try {
    const secs = Number(expirySecs);
    if (!Number.isFinite(secs) || secs <= 0) {
      console.warn("[V6.5] computeNextSignalTiming: invalid expirySecs, using fail-safe");
      return { nextSignalCheckDelaySecs: TIMING_FAILSAFE, buffer: TIMING_BUFFERS.DEFAULT, failsafe: true };
    }

    const buffer = TIMING_BUFFERS[volatilityTier] ?? TIMING_BUFFERS.DEFAULT;
    const raw    = secs - buffer;

    // Clamp: floor at TIMING_FLOOR, ceiling at expirySecs (always check before expiry)
    const nextSignalCheckDelaySecs = Math.max(TIMING_FLOOR, Math.min(raw, secs));

    return { nextSignalCheckDelaySecs, buffer, failsafe: false };
  } catch (err) {
    console.error("[V6.5] computeNextSignalTiming error:", err.message);
    return { nextSignalCheckDelaySecs: TIMING_FAILSAFE, buffer: TIMING_BUFFERS.DEFAULT, failsafe: true };
  }
}

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const mode = body.mode || "all";

    // ── Trade result report ───────────────────────────────────────────────────
    if (body.reportResult) {
      const r = body.reportResult;
      if (r === "win") {
        _sessionLog.wins++;
        // FIX [17]: Win resets consecutive loss streak
        _sessionLog.consecutiveLosses = 0;
        _sessionStopped = false;
      }
      if (r === "loss") {
        _sessionLog.losses++;
        // FIX [17]: Track consecutive losses — stop trading after 2 in a row
        _sessionLog.consecutiveLosses = (_sessionLog.consecutiveLosses || 0) + 1;
        if (_sessionLog.consecutiveLosses >= 2) {
          _sessionStopped = true;
          console.warn(`[V9.0] SESSION STOPPED — ${_sessionLog.consecutiveLosses} consecutive losses. Resume via Reset Session.`);
        }
      }
      _sessionLog.total++;
      _sessionLog.trades = [
        { pair: body.pair, direction: body.direction, result: r, confidence: body.confidence, at: new Date().toISOString() },
        ..._sessionLog.trades,
      ].slice(0, 100);
      _sessionLog.sessionKey = activeSessionKey ?? null;
      _activeTrade = false;
      _activeTradeExpiry = null;

      // FIX [4]: Persist session log to SQLite so it survives server restarts
      try { saveSessionLog(_sessionLog); } catch (err) { console.warn("[V9.0] saveSessionLog failed:", err.message); }

      // V9.0 P2: Update PRIMARY signal result in signals table
      // SECONDARY signals are NOT touched here — only user-initiated via /api/manual-execute
      try {
        if (body.signalId) {
          updateSignalResult(body.signalId, r === "win" ? "WIN" : "LOSS");
          updateSignalStatus(body.signalId, "SENT", { sentAt: Date.now() });
          console.log(`[V9.0 P2] PRIMARY signal result persisted: id=${body.signalId} result=${r.toUpperCase()}`);
        }
      } catch (sigResErr) {
        console.warn("[V9.0] Signal result persist error (non-fatal):", sigResErr.message);
      }

      // V7.0.5 FINAL — Idempotent WIN/LOSS Telegram dispatch (backend-driven, no UI dependency)
      // Build a unique key from pair + direction + timestamp (floored to 30s to absorb retries).
      // Once dispatched, the key is stored in _resultSentIds — duplicate sends are silently dropped.
      const tgToken  = process.env.TELEGRAM_BOT_TOKEN;
      const tgChatId = process.env.TELEGRAM_CHAT_ID;
      if (tgToken && tgChatId && tgToken !== "your-bot-token-here" && body.pair) {
        const dedupeKey = `${body.pair}|${body.direction}|${r}|${Math.floor(Date.now() / 30000)}`;
        if (_resultSentIds.has(dedupeKey)) {
          console.log(`[V9.0] Result Telegram SKIPPED (duplicate) | key=${dedupeKey}`);
        } else {
          _resultSentIds.add(dedupeKey);
          // Prune old keys to avoid memory growth (keep last 100)
          if (_resultSentIds.size > 100) {
            const oldest = [..._resultSentIds][0];
            _resultSentIds.delete(oldest);
          }
          const isWin = r === "win";
          const resultHtml = [
            `${isWin ? "✅" : "❌"} <b>RESULT UPDATE</b>`,
            `━━━━━━━━━━━━━━━━━━━━━━`,
            `📌 <b>PAIR:</b> <code>${body.pair ?? "—"}</code>`,
            `📌 <b>DIRECTION:</b> <code>${body.direction === "BUY" ? "CALL ▲" : "PUT ▼"}</code>`,
            `📊 <b>CONFIDENCE:</b> <code>${body.confidence ?? "—"}%</code>`,
            ``,
            `<b>RESULT: ${isWin ? "WIN ✅" : "LOSS ❌"}</b>`,
            `📈 Session: W:<b>${_sessionLog.wins}</b> L:<b>${_sessionLog.losses}</b>`,
            `━━━━━━━━━━━━━━━━━━━━━━`,
            `🤖 <i>SIGNALEX V8.0 FINAL — Auto Result Dispatch</i>`,
          ].join("\n");
          // Fire-and-forget — backend-triggered, not UI-dependent
          fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: tgChatId, text: resultHtml, parse_mode: "HTML" }),
          })
            .then((res) => res.json())
            .then((data) => {
              if (data.ok) {
                console.log(`[V9.0] Result Telegram SENT | ${r.toUpperCase()} | ${body.pair} | key=${dedupeKey} | timestamp=${new Date().toISOString()}`);
              } else {
                console.warn(`[V9.0] Result Telegram FAILED | ${data.description}`);
              }
            })
            .catch((err) => console.warn(`[V9.0] Result Telegram ERROR | ${err.message}`));
        }
      }

      console.log(`[V9.0] Result recorded: ${r.toUpperCase()} for ${body.pair} | W:${_sessionLog.wins} L:${_sessionLog.losses} | ConsecLoss:${_sessionLog.consecutiveLosses} | Stopped:${_sessionStopped}`);
      return NextResponse.json({ ok: true, sessionLog: _sessionLog, controllerState: _controllerState(), sessionStopped: _sessionStopped });
    }

    // ── BETA: Manual trade lock (called after user confirms Telegram send) ────
    if (body.lockTrade) {
      if (!_isTradeActive()) {
        const expiryMs     = _parseExpiryMs(body.expiry || "5 min");
        _activeTrade       = true;
        _activeTradeExpiry = new Date(Date.now() + expiryMs);
        if (body.pair) {
          usedPairs[body.pair] = Date.now();
          sessionTradeCount++;
          lastSignalEmittedAt = Date.now();
        }
        console.log(`[BETA] Trade locked: ${body.pair} ${body.direction} | expires in ${expiryMs / 1000}s`);
      }
      return NextResponse.json({ ok: true, controllerState: _controllerState() });
    }

    // ── Reset session log ─────────────────────────────────────────────────────
    if (body.resetSession) {
      _sessionLog = { wins: 0, losses: 0, total: 0, startedAt: new Date().toISOString(), trades: [], consecutiveLosses: 0, sessionKey: null };
      _sessionStopped     = false;   // FIX [17]: clear stop-trade flag on manual reset
      sessionTradeCount   = 0;
      usedPairs           = {};
      sessionPairs        = [];
      backupPairs         = [];
      activePairs         = null;
      lossPrevention      = { active: false, until: null, reason: "" };
      lastSignalEmittedAt = 0;
      tierPerformance     = { A: { wins: 0, losses: 0, uses: 0 }, B: { wins: 0, losses: 0, uses: 0 }, C: { wins: 0, losses: 0, uses: 0 } };
      // FIX [4]: Persist the clean slate to DB
      try { saveSessionLog(_sessionLog); } catch {}
      if (body.clearHistory) {
        // Optional: clear full history when user clicks "Clear All" on frontend
        try { clearSessionHistory(); } catch {}
      }
      console.log("[V9.0] Session reset — stop-trade flag cleared, consecutive losses reset");
      return NextResponse.json({ ok: true, message: "Session reset", controllerState: _controllerState() });
    }

    // ── Block new analysis if trade is actively locked ────────────────────────
    if (_isTradeActive()) {
      const secsLeft = Math.max(0, Math.round((_activeTradeExpiry.getTime() - Date.now()) / 1000));
      return NextResponse.json({
        blocked:         true,
        reason:          "activeTrade",
        message:         `Trade in progress — rescan in ${secsLeft}s`,
        secondsLeft:     secsLeft,
        signals:         [],
        controllerState: _controllerState(),
      });
    }

    // FIX [17]: Stop trading after 2 consecutive losses per session
    if (_sessionStopped) {
      return NextResponse.json({
        blocked:        true,
        reason:         "sessionStopped",
        message:        `Trading halted — ${_sessionLog.consecutiveLosses} consecutive losses this session. Click "Reset Session" to resume.`,
        signals:        [],
        sessionStopped: true,
        controllerState: _controllerState(),
      });
    }

    // ── V7.0.5: Pre-session scan request ────────────────────────────────────
    // Called by preSessionScheduler.js when auto-trigger fires or manual override.
    // Scores all pairs and stores result WITHOUT emitting a trade signal.
    if (body.prescan) {
      const sessionKey = typeof body.prescan === "string" ? body.prescan : (getCurrentSessionKey() || "LONDON");
      console.log(`[V9.0] Pre-scan requested for session: ${sessionKey}`);

      const backendAliveForPrescan = await checkBackendHealth();
      if (!backendAliveForPrescan) {
        return NextResponse.json({
          ok: false, prescanResult: null,
          error: "Python backend unreachable — pre-scan cannot score pairs",
        });
      }

      const pricesForPrescan = await fetchRealPrices();
      if (!pricesForPrescan) {
        return NextResponse.json({
          ok: false, prescanResult: null,
          error: "No market data available for pre-scan",
        });
      }

      // Score all pairs
      const allPairsForPrescan = pricesForPrescan.pairs.map((p) => ({
        pair:   p.pair,
        prices: p.candles ?? p.prices ?? [],
      }));

      const scored = allPairsForPrescan
        .filter((p) => p.prices && p.prices.length >= 30)
        .map((p) => ({
          pair:  p.pair,
          score: scorePairForPreSelection(p.prices),
          bias:  calcDirectionalBias(p.prices),
        }))
        .sort((a, b) => b.score - a.score);

      const qualifiedPS = scored.filter((p) => p.score >= 60);
      const selectedPS  = (qualifiedPS.length >= 8 ? qualifiedPS.slice(0, 8) : qualifiedPS.length >= 3 ? qualifiedPS : scored.slice(0, 5)).map((p) => p.pair);
      const backupPS    = scored.filter((p) => !selectedPS.includes(p.pair)).slice(0, 3).map((p) => p.pair);

      // Store in DB via scheduler
      storePreScan(sessionKey, selectedPS, backupPS, scored.map((p) => ({ pair: p.pair, score: p.score })), "auto");

      console.log(`[V9.0] Pre-scan done: ${selectedPS.length} pairs for ${sessionKey}: [${selectedPS.join(", ")}]`);

      return NextResponse.json({
        ok: true,
        prescanResult: {
          sessionKey,
          selectedPairs: selectedPS,
          backupPairs:   backupPS,
          scores:        scored.map((p) => ({ pair: p.pair, score: p.score })),
          timestamp:     new Date().toISOString(),
        },
      });
    }

    // ── V7.0.5: Telegram result auto-report ─────────────────────────────────
    // After user confirms WIN/LOSS in the UI, we auto-send a result message
    // to the Telegram group. Called right after reportResult is processed.
    if (body.telegramResult) {
      const { pair, direction, expiry, result, confidence } = body.telegramResult;
      const token  = process.env.TELEGRAM_BOT_TOKEN;
      const chatId = process.env.TELEGRAM_CHAT_ID;
      if (token && chatId && token !== "your-bot-token-here") {
        const isWin   = result === "win";
        const html = [
          `${isWin ? "✅" : "❌"} <b>RESULT UPDATE</b>`,
          `━━━━━━━━━━━━━━━━━━━━━━`,
          `📌 <b>PAIR:</b> <code>${pair ?? "—"}</code>`,
          `📌 <b>DIRECTION:</b> <code>${direction === "BUY" ? "CALL ▲" : "PUT ▼"}</code>`,
          `📌 <b>EXPIRY:</b> <code>${expiry ?? "—"}</code>`,
          `📊 <b>CONFIDENCE:</b> <code>${confidence ?? "—"}%</code>`,
          ``,
          `<b>RESULT: ${isWin ? "WIN ✅" : "LOSS ❌"}</b>`,
          `━━━━━━━━━━━━━━━━━━━━━━`,
          `🤖 <i>SIGNALEX V8.0</i>`,
        ].join("\n");

        fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: "HTML" }),
        }).catch(() => {});  // fire-and-forget — don't block the result recording
      }
      return NextResponse.json({ ok: true, reported: true });
    }
    // Section 7.1: Check Orchestrator Mode (OFF: analysis paused, no scans, no signals)
    const orchState = orchestrator.getState();
    if (orchState.mode === "OFF") {
      return NextResponse.json({
        blocked:         true,
        reason:          "engine_off",
        message:         "Trading engine is in OFF mode. Scans and signals are paused.",
        signals:         [],
        controllerState: _controllerState(),
      });
    }

    // Must run BEFORE backend fetch so we never waste a data call during news.
    // isNewsBlackout() is cached for 30 min — negligible overhead per scan.
    if (body.forceNewsRefresh) {
      await forceNewsRefresh();
    }
    const newsCheck = await isNewsBlackout();
    if (newsCheck.blocked) {
      console.warn(`[V9.0] NEWS BLACKOUT: ${newsCheck.reason}`);
      return NextResponse.json({
        blocked:         true,
        reason:          "newsBlackout",
        message:         newsCheck.reason,
        signals:         [],
        newsBlackout:    true,
        activeNewsEvent: newsCheck.activeEvent,
        nextClearAt:     newsCheck.nextClearAt,
        minutesLeft:     newsCheck.minutesLeft,
        upcomingEvents:  getUpcomingEvents(),
        controllerState: _controllerState(),
      });
    }

    // ── V10: Real Price Resolver (Pocket Option Primary + Deriv Cross-check) ───
    let realData = await fetchRealPrices();
    let dataSource = realData?.source ?? "none";
    let isRealData = Boolean(realData?.pairs?.length);

    if (!isRealData) {
      console.error("[V10] Real market data unavailable — blocking signal generation");
      return NextResponse.json({
        blocked:         true,
        reason:          "no_market_data",
        message:         "Live market data from Pocket Option / Deriv is currently unavailable or stale. No signals issued.",
        signals:         [],
        isRealData:      false,
        dataSource:      "none",
        version:         "10.0.0",
        controllerState: _controllerState(),
      });
    }

    // V7.0.4.1 FIX: Strip Stooq-sourced pairs from analysis entirely.
    // Stooq is last-resort and interpolates 60 synthetic 1m candles from one hourly bar.
    // Signals generated on fabricated price action are unreliable and must never fire.
    const stooqPairs = new Set(
      (realData.pairs || [])
        .filter((p) => p.source === "stooq")
        .map((p) => p.pair)
    );
    if (stooqPairs.size > 0) {
      console.warn(`[V9.0] Stooq-source pairs excluded from analysis (synthetic candles): ${[...stooqPairs].join(", ")}`);
    }

    const allPricePairs = realData.pairs
      .filter((p) => p.source !== "stooq")
      .map((p) => ({
        pair:       p.pair,
        prices:     p.candles ?? p.prices ?? [],
        source:     p.source,
        payout_pct: p.payout_pct || 85,
        break_even: p.break_even || calcBreakEven(p.payout_pct || 85),
        market:     p.market || (p.pair.includes("OTC") ? "otc" : "forex"),
      }));

    const { t }       = getGMT1Time();
    const currentKey  = deriveSessionKey(t);
    const pricePairs  = resolveActivePairs(allPricePairs, currentKey);

    const backupPricePairs = backupPairs.length > 0
      ? allPricePairs.filter((p) => backupPairs.includes(p.pair) && !activePairs?.includes(p.pair))
      : [];
    const allToAnalyse = [...pricePairs, ...backupPricePairs];

    const analyses = allToAnalyse
      .filter((p) => p.prices && p.prices.length >= 30)
      .map((p)    => buildFullAnalysis(p.prices, p.pair));

    const tradeableCount = analyses.filter((a) => !a.filter.shouldSkip).length;
    const blockedCount   = analyses.filter((a) =>  a.filter.shouldSkip).length;

    // V6.3 enhanced logging per analysis
    for (const a of analyses) {
      const status = a.filter.shouldSkip ? "BLOCKED" : "TRADEABLE";
      const reason = a.filter.shouldSkip ? ` | ${a.filter.reasons[0]}` : "";
      console.log(`[V6.5] ${a.pair} | Phase: ${a.marketPhase} | Strategy: ${a.strategyUsed} | Market: ${getMarketType(a.pair).toUpperCase()} | Score: ${a.marketQualityScore} | Expiry: ${a.expiry} | ${status}${reason}`);
    }

    if (tradeableCount === 0) {
      const dominantPhase = analyses[0]?.marketPhase || "CHAOTIC";
      const uxMessage     = UX_MESSAGES[dominantPhase] || UX_MESSAGES.CHAOTIC;
      return NextResponse.json({
        message:        "No valid trading setups available",
        uxMessage,
        signals:        analyses.map((a) => ({
          pair:           a.pair,
          noTrade:        true,
          noTradeReasons: a.filter.reasons,
          strength:       "BLOCKED",
          marketType:     getMarketType(a.pair),
          strategyUsed:   a.strategyUsed || STRATEGY_NONE,
          marketPhase:    a.marketPhase,
        })),
        demo:            false,
        dataSource,      isRealData,
        tradeableCount:  0, blockedCount,
        pairsAnalyzed:   analyses.length,
        sessionKey:      currentKey,
        activePairs:     activePairs || [],
        marketMode:      isWeekend() ? "otc_only" : "forex_otc",
        version:         "7.0.4.1",
        controllerState: _controllerState(),
      });
    }

    const signals = assembleSignals(analyses, mode);

    // V6.5.3: Smarter real-time re-validation — only cancel on MAJOR structural change
    const rawSignal = signals.find((s) => !s.noTrade);
    if (rawSignal) {
      const freshPriceEntry = allPricePairs.find((p) => p.pair === rawSignal.pair);
      if (freshPriceEntry && freshPriceEntry.prices && freshPriceEntry.prices.length >= 30) {
        const freshAnalysis = buildFullAnalysis(freshPriceEntry.prices, rawSignal.pair);
        // V6.5.3: Use critical-block check instead of blind shouldSkip
        const originalAnalysis = analyses.find((a) => a.pair === rawSignal.pair);
        const criticalBlock = originalAnalysis
          ? isRevalidationCriticalBlock(originalAnalysis, freshAnalysis)
          : freshAnalysis.filter.shouldSkip;
        if (criticalBlock) {
          const blockReason = freshAnalysis.filter.reasons?.[0] ?? "Major structural change detected";
          console.log(`[V6.5.3] Revalidation CRITICAL BLOCK ${rawSignal.pair}: ${blockReason}`);
          const idx = signals.findIndex((s) => s.pair === rawSignal.pair && !s.noTrade);
          if (idx !== -1) {
            signals[idx] = {
              pair:           rawSignal.pair,
              noTrade:        true,
              noTradeReasons: ["Revalidation: critical structural change — " + blockReason],
              strength:       "REVALIDATION_FAILED",
            };
          }
        } else {
          console.log(`[V6.5.3] Revalidation PASSED ${rawSignal.pair} — minor fluctuation, signal stands`);
        }
      }
    }

    // V6.5.5 — FINAL QUALITY ASSERTION (absolute floor only — no double-gate)
    // FIX: v6.5.3/4 used getDynamicQualityThreshold() here, which re-applied the same
    // threshold that assembleSignals() already filtered by — creating a redundant double-block.
    // Now we only enforce SIGNAL_QUALITY_FLOOR (absolute minimum = 50). The dynamic
    // threshold was already applied upstream in assembleSignals; applying it again here
    // was silently killing signals that legitimately passed the first gate.
    for (let i = 0; i < signals.length; i++) {
      const s = signals[i];
      if (s.noTrade) continue;

      const absoluteFloor = SIGNAL_QUALITY_FLOOR;  // 50 — never below this, ever
      if ((s.marketQualityScore ?? 0) < absoluteFloor) {
        console.log(`[V6.5.5] FINAL QUALITY GATE blocked ${s.pair} — score ${s.marketQualityScore} < absolute floor ${absoluteFloor}`);
        signals[i] = {
          pair:           s.pair,
          noTrade:        true,
          noTradeReasons: [`Final quality floor failed: score ${s.marketQualityScore} < ${absoluteFloor} (absolute minimum)`],
          strength:       "QUALITY_BLOCKED",
          marketType:     s.marketType,
          strategyUsed:   s.strategyUsed,
        };
        continue;
      }

      // Null-expiry fail-safe (catches any edge-case that bypassed TASK 3)
      if (s.expiry === null || s.expirySecs === null) {
        console.log(`[V6.5.5] FINAL EXPIRY GATE blocked ${s.pair} — null expiry`);
        signals[i] = {
          pair:           s.pair,
          noTrade:        true,
          noTradeReasons: ["Final expiry assertion failed: expiry is null (LOW volatility)"],
          strength:       "EXPIRY_BLOCKED",
          marketType:     s.marketType,
          strategyUsed:   s.strategyUsed,
        };
      }
    }

    const emittedSignals = signals.filter((s) => !s.noTrade);

    // ── V9.0 P6/P8: Market condition pre-filter + kill switch ────────────────
    // Run AFTER existing signal engine — acts as post-filter guard only.
    // CHAOTIC classification or active kill-switch pause blocks emission.
    // This does NOT modify signal direction/confidence — pure gate.
    // [BUG1-FIX] evaluateAndPause is throttled to once per 60s (KILL_SWITCH_EVAL_INTERVAL_MS).
    // Previously it ran on every scan — pause state accumulated across scans, silencing
    // all pairs with no UI feedback. Now it evaluates once per minute regardless of scan rate.
    let killSwitchActive = false;
    let killSwitchReason = "";
    try {
      const nowKs = Date.now();
      const shouldEvaluate = (nowKs - _lastKillSwitchEvalAt) >= KILL_SWITCH_EVAL_INTERVAL_MS;
      if (shouldEvaluate) {
        const pairCandleMap = allPricePairs.map((p) => ({
          pair:    p.pair,
          candles: p.candles ?? p.prices ?? [],
        }));

        // ── Scheduled market condition classifier (kill-switch) ──────────────
        const conditionMap = classifyAll(pairCandleMap);
        evaluateAndPause(conditionMap, _activeTrade);

        // ── Unscheduled spike detector (real-time news guard) ────────────────
        // Runs on the same candle data, same 60s throttle — zero extra cost.
        // Fires addDynamicBlackout() per-currency if ≥2 correlated pairs show
        // a ≥3x ATR spike simultaneously. Catches surprise events the calendar
        // will never know about. Works on weekends (OTC) too.
        try {
          const spikeResult = detectVolatilitySpike(pairCandleMap);
          if (spikeResult.triggered) {
            spikeResult.events.forEach((ev) => {
              console.warn(`[V10.5 SpikeDetector] Blackout registered: ${ev.currency} ${ev.ratio.toFixed(1)}x ATR — pairs: ${ev.pairs.join(", ")}`);
            });
          }
        } catch (spikeErr) {
          console.warn("[V10.5 SpikeDetector] Error (non-fatal):", spikeErr.message);
        }

        _lastKillSwitchEvalAt = nowKs;
        console.log(`[V9.0 killSwitch] Condition eval ran at ${new Date(nowKs).toISOString()} (throttled 60s)`);
      }

      // Check if any emitted signal's pair is currently paused (always checked, even if eval was skipped)
      for (const sig of emittedSignals) {
        if (isPaused(sig.pair)) {
          const remaining = Math.ceil(pauseRemainingMs ? pauseRemainingMs(sig.pair) / 60000 : 5);
          console.log(`[V9.0 killSwitch] ${sig.pair} is PAUSED — blocking emission (${remaining}min remaining)`);
          const idx = signals.findIndex((s) => s.pair === sig.pair && !s.noTrade);
          if (idx !== -1) {
            signals[idx] = {
              ...signals[idx],
              noTrade:        true,
              noTradeReasons: [`Market CHAOTIC — trading paused ${remaining}min`],
              strength:       "KILL_SWITCH",
            };
          }
          killSwitchActive = true;
          killSwitchReason = `${sig.pair} paused: CHAOTIC market`;
        }
      }
    } catch (ksErr) {
      console.warn("[V9.0] Kill switch error (non-fatal):", ksErr.message);
    }

    // Re-derive after kill switch may have demoted signals
    const finalEmittedSignals = signals.filter((s) => !s.noTrade);

    finalEmittedSignals.slice(0, 1).forEach((sig) => {
      // V6.5.6: attach entryPrice (last close of the pair) before logging
      const pairEntry = allPricePairs.find((p) => p.pair === sig.pair);
      const prices    = pairEntry?.prices ?? pairEntry?.candles ?? [];
      sig.entryPrice  = prices.length > 0 ? prices[prices.length - 1].close : null;
      sig.id          = `${sig.pair}_${Date.now()}`;
      sig.payout_pct  = pairEntry?.payout_pct || 85;
      sig.break_even  = pairEntry?.break_even || calcBreakEven(sig.payout_pct);
      sig.market      = pairEntry?.market || (sig.pair.includes("OTC") ? "otc" : "forex");
      sig.price_source = pairEntry?.source || "po";

      logTrade(sig);
      sessionTradeCount++;
      lastSignalEmittedAt = Date.now();   // V6.5.3: reset anti-silence timer

      // V9.0 P2: Save PRIMARY signal independently to signals table
      try {
        saveSignal({
          id:           sig.id,
          pair:         sig.pair,
          direction:    sig.direction,
          confidence:   sig.confidence,
          type:         "PRIMARY",
          status:       "PENDING",
          session:      currentKey ?? "UNKNOWN_SESSION",
          signalTier:   sig.signalTier,
          marketPhase:  sig.marketPhase,
          qualityScore: sig.marketQualityScore,
          expiry:       sig.expiry,
          expirySecs:   sig.expirySecs,
          strategy:     sig.strategyUsed,
          createdAt:    Date.now(),
          payout_pct:   sig.payout_pct,
          break_even:   sig.break_even,
          market:       sig.market,
          price_source: sig.price_source,
        });
        console.log(`[V9.0 P2] PRIMARY signal saved: ${sig.pair} ${sig.direction} conf=${sig.confidence} payout=${sig.payout_pct}%`);
      } catch (sigErr) {
        console.warn("[V9.0] saveSignal error (non-fatal):", sigErr.message);
      }

      // V6.5 TASK 3: compute dynamic next-signal timing and attach to signal object
      const timing = computeNextSignalTiming(sig.expirySecs, sig.volatilityTier);
      sig.nextSignalCheckDelaySecs = timing.nextSignalCheckDelaySecs;
      sig.nextSignalCheckTime      = new Date(Date.now() + timing.nextSignalCheckDelaySecs * 1000).toISOString();
      sig.timingBuffer             = timing.buffer;
      sig.timingFailsafe           = timing.failsafe;

      // V6.5.6: schedule automatic win/loss detection for forex pairs
      scheduleOutcomeCheck(sig);

      // Section 6.8: Honest shadow evaluation on closed PO candles for every signal
      scheduleShadowEvaluation(sig);

      // Section 7: Auto / Semi Execution Flow via Orchestrator
      if (orchState.mode === "AUTO") {
        orchestrator.dispatchOrder(sig, "auto").then((res) => {
          if (res.success) {
            console.log(`[analyze] Auto trade executed: ${res.tradeId} (Deal ${res.dealId})`);
          } else {
            console.warn(`[analyze] Auto trade skipped: ${res.reason}`);
          }
        }).catch((err) => {
          console.error(`[analyze] Auto trade error:`, err.message);
        });
      } else if (orchState.mode === "SEMI") {
        const pendingConf = orchestrator.createPendingTrade(sig);
        if (pendingConf) {
          sig.pendingConfirmationId = pendingConf.id;
          sig.pendingExpiresAt = pendingConf.expires_at;
          console.log(`[analyze] SEMI pending trade queued: ${pendingConf.id} (20s countdown)`);
        }
      }

      console.log(`[V6.5.6] SIGNAL EMITTED | ${sig.pair} | ${sig.direction} | Strategy: ${sig.strategyUsed} | Market: ${sig.marketType?.toUpperCase()} | Score: ${sig.marketQualityScore} | Tier: ${sig.signalTier} | Size: ${sig.positionSize}% | Expiry: ${sig.expiry} | Entry: ${sig.entryPrice} | Next check: ${sig.nextSignalCheckDelaySecs}s`);
    });

    // V6.5.5 — Loss prevention
    // FIX: "blockedThisCycle >= 5" trigger removed entirely — blocking pairs during a scan
    // cycle is NORMAL engine behavior (pairs get filtered by quality/phase). This trigger
    // was locking the engine every single cycle in real market conditions.
    if (!lossPrevention.active) {
      const recentLogs       = tradeLog.slice(-5);
      const consecutiveWeak  = recentLogs.filter((t) => t.confidence < 60).length;  // FIX: was 65 — 60 is more realistic floor
      const avgQuality       = recentLogs.length > 0
        ? recentLogs.reduce((sum, t) => sum + (t.marketQualityScore || 0), 0) / recentLogs.length
        : 100;

      // Only trigger loss prevention on genuinely bad EMITTED trades, not blocked pairs
      if (consecutiveWeak >= 4) {   // FIX: was 3 — require 4 consecutive weak emissions
        lossPrevention = { active: true, until: Date.now() + 5 * 60 * 1000,
          reason: `${consecutiveWeak} consecutive weak signals (conf<60)` };
      } else if (recentLogs.length >= 4 && avgQuality < 50) {   // FIX: was 55 — only lock on very poor quality
        lossPrevention = { active: true, until: Date.now() + 8 * 60 * 1000,
          reason: `Sustained very low market quality (avg ${Math.round(avgQuality)}/100)` };
      }
    }

    // V9.0 P2: Save SECONDARY signals (ranks 2+) — never auto-assigned result
    try {
      finalEmittedSignals.slice(1).forEach((sig, i) => {
        const pairEntry = allPricePairs.find((p) => p.pair === sig.pair);
        const prices    = pairEntry?.prices ?? pairEntry?.candles ?? [];
        sig.entryPrice  = prices.length > 0 ? prices[prices.length - 1].close : null;
        sig.id          = sig.id ?? `${sig.pair}_SEC_${Date.now()}_${i}`;
        sig.signalType  = "SECONDARY";
        saveSignal({
          id:           sig.id,
          pair:         sig.pair,
          direction:    sig.direction,
          confidence:   sig.confidence,
          type:         "SECONDARY",
          status:       "PENDING",
          session:      currentKey ?? "UNKNOWN_SESSION",
          signalTier:   sig.signalTier,
          marketPhase:  sig.marketPhase,
          qualityScore: sig.marketQualityScore,
          expiry:       sig.expiry,
          expirySecs:   sig.expirySecs,
          strategy:     sig.strategyUsed,
          createdAt:    Date.now(),
        });
        console.log(`[V9.0 P2] SECONDARY signal saved: ${sig.pair} ${sig.direction} (rank ${i + 2}) — not auto-tracked`);
      });
    } catch (secErr) {
      console.warn("[V9.0] SECONDARY saveSignal error (non-fatal):", secErr.message);
    }

    const dominantPhaseAll = analyses[0]?.marketPhase || "TRENDING";
    const uxMessageAll     = UX_MESSAGES[dominantPhaseAll] || "Monitoring market conditions";

    // BUG FIX: Re-derive counts from the FINAL signals array — the quality gate loop above
    // (lines 3056–3086) can demote signals to noTrade AFTER the original tradeableCount/
    // blockedCount were calculated at line 2982. Without this fix the frontend receives
    // tradeableCount=2 but signals[].filter(!noTrade) returns 0, causing missing cards and
    // confidence showing "—".
    const finalTradeableCount = signals.filter((s) => !s.noTrade).length;
    const finalBlockedCount   = signals.filter((s) =>  s.noTrade).length;

    return NextResponse.json({
      signals,
      demo: false, dataSource, isRealData,
      tradeableCount: finalTradeableCount,
      blockedCount:   finalBlockedCount,
      pairsAnalyzed:       analyses.length,
      sessionKey:          currentKey,
      activePairs:         activePairs  || [],
      sessionPairs:        sessionPairs || [],
      backupPairs:         backupPairs  || [],
      sessionTradeCount,
      maxTradesPerSession: MAX_TRADES_PER_SESSION,
      uxMessage:           uxMessageAll,
      marketMode:          isWeekend() ? "otc_only" : "forex_otc",
      version:             "9.0.0",
      antiSilenceState:    getAntiSilenceState(),
      tierPerformanceSummary: tierPerformance,
      controllerState:     _controllerState(),
      newsStatus:          { blocked: false, upcomingEvents: getUpcomingEvents() },
      killSwitchActive,
      killSwitchReason,
      killSwitchPauses:    getPauseStatus(),
      activeSignalTiming:  finalEmittedSignals[0]
        ? {
            nextSignalCheckDelaySecs: emittedSignals[0].nextSignalCheckDelaySecs,
            nextSignalCheckTime:      emittedSignals[0].nextSignalCheckTime,
            timingBuffer:             emittedSignals[0].timingBuffer,
            timingFailsafe:           emittedSignals[0].timingFailsafe,
          }
        : null,
    });

  } catch (err) {
    console.error("[analyze] fatal:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);

  // FIX [4]: Session history from SQLite
  if (searchParams.get("history") === "1") {
    try {
      const history = loadSessionHistory(100);
      return NextResponse.json({ ok: true, history });
    } catch (err) {
      return NextResponse.json({ ok: false, error: err.message, history: [] });
    }
  }

  // V7.0.3: News calendar endpoint — used by dashboard news widget
  if (searchParams.get("news") === "1") {
    try {
      if (searchParams.get("refresh") === "1") await forceNewsRefresh();
      const newsCheck = await isNewsBlackout();
      return NextResponse.json({
        ok:             true,
        blocked:        newsCheck.blocked,
        reason:         newsCheck.reason,
        activeEvent:    newsCheck.activeEvent,
        nextClearAt:    newsCheck.nextClearAt,
        minutesLeft:    newsCheck.minutesLeft,
        upcomingEvents: getUpcomingEvents(),
        blackoutMinutes: parseInt(process.env.NEWS_BLACKOUT_MINUTES || "15", 10),
      });
    } catch (err) {
      return NextResponse.json({ ok: false, error: err.message });
    }
  }

  return NextResponse.json({
    tradeLog,
    count:          tradeLog.length,
    tierPerformance,
    sessionLog:     _sessionLog,
    sessionStopped: _sessionStopped,
    timestamp:      new Date().toISOString(),
  });
}

export async function PATCH(request) {
  try {
    const { id, result } = await request.json().catch(() => ({}));
    if (!id || !["WIN", "LOSS"].includes(result)) {
      return NextResponse.json(
        { ok: false, error: "Provide id (string) and result ('WIN' or 'LOSS')" },
        { status: 400 }
      );
    }
    const updated = updateTradeResult(id, result);
    // V6.5.3: Update adaptive learning tier performance
    if (updated) {
      const tradeEntry = tradeLog.find((t) => t.id === id);
      if (tradeEntry?.signalTier) {
        updateTierPerformance(tradeEntry.signalTier, result);
        console.log(`[V6.5.3] Adaptive learning updated: tier ${tradeEntry.signalTier} → ${result}`);
      }
    }
    return NextResponse.json({
      ok: updated, id, result,
      tierPerformance,  // V6.5.3: return current tier stats for transparency
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
