// ═══════════════════════════════════════════════════════════════════════════════
// SIGNALEX V9.0 — Mid-Session Kill Switch  (P8)
// lib/killSwitch.js
// ═══════════════════════════════════════════════════════════════════════════════
//
// PURPOSE: Continuously monitor market conditions during a session.
//   If a pair (or all pairs) becomes CHAOTIC → pause trading for X minutes.
//   Does NOT interrupt active signal lifecycle — only prevents NEW signals.
//   All pauses are logged to SQLite kill_switch_log table.
//
// PAUSE DURATIONS:
//   CHAOTIC pair:    5 minutes  (pair-specific pause)
//   CHAOTIC 3+ pairs: 15 minutes (session-wide pause)
//   Consecutive triggers: 2x duration each time
// ═══════════════════════════════════════════════════════════════════════════════

import { logKillSwitch } from "./db.js";

const PAIR_PAUSE_MS    = 5  * 60 * 1000;   // 5 min per-pair pause (both weekday and weekend)
const SESSION_PAUSE_MS = 7  * 60 * 1000;   // [UPDATED] was 15 min — 15 min blocked London/NY opens routinely;
                                            // 7 min is sufficient to clear a genuine spike without
                                            // sacrificing the entire high-volume open window
const CHAOTIC_THRESHOLD = 5;               // [UPDATED] was 3 — 3 pairs firing at London open is NORMAL
                                            // volatility (EUR/USD, GBP/USD, USD/JPY all spike together).
                                            // Raised to 5 so routine session-open volatility never
                                            // triggers a session-wide block.

// OTC weekend adjustments — OTC pairs on Sat/Sun trade on synthetic thin-liquidity
// prices. More pairs showing "CHAOTIC" simultaneously is expected and does NOT
// indicate genuine session-level risk.
const OTC_CHAOTIC_THRESHOLD = 8;           // need 8+ pairs CHAOTIC on weekend to trigger session pause
const OTC_SESSION_PAUSE_MS  = 5 * 60 * 1000;  // 5 min if weekend session pause fires

function isWeekendNow() {
  const d = new Date().getUTCDay();
  return d === 0 || d === 6;
}

// In-memory pause registry
// key: pair name (or "SESSION") → { resumeAt, reason, pausedAt }
const _pauses = new Map();
let _consecutivePairTriggers = new Map();   // pair → { count, lastNormalAt }

// How long a pair must stay NORMAL before its consecutive trigger count resets.
// Previously reset on the very first NORMAL scan — one calm candle after chaos
// would reset the escalation counter, meaning the 2nd chaos trigger got the same
// 5-min pause as the 1st. Now requires 30 min of sustained calm to reset.
const TRIGGER_RESET_AFTER_MS = 30 * 60 * 1000;

/**
 * Check whether a pair is currently paused.
 * @param {string} pair  — specific pair OR "SESSION" for session-wide check
 * @returns {boolean}
 */
export function isPaused(pair) {
  const now = Date.now();
  // Session-wide pause always checked first
  const session = _pauses.get("SESSION");
  if (session && now < session.resumeAt) return true;
  const pairPause = _pauses.get(pair);
  return !!(pairPause && now < pairPause.resumeAt);
}

/**
 * Returns remaining pause duration in seconds, or 0 if not paused.
 */
export function pauseRemainingMs(pair) {
  const now = Date.now();
  const session = _pauses.get("SESSION");
  if (session && now < session.resumeAt) return session.resumeAt - now;
  const pairPause = _pauses.get(pair);
  if (pairPause && now < pairPause.resumeAt) return pairPause.resumeAt - now;
  return 0;
}

/**
 * Evaluate market conditions and trigger pauses if needed.
 * Called after every forecast/condition check.
 *
 * @param {Map<string, {state: string}>} conditionMap — pair → condition result
 * @param {boolean} hasActiveTrade — do NOT session-pause if a trade is live
 */
export function evaluateAndPause(conditionMap, hasActiveTrade = false) {
  const now      = Date.now();
  const weekend  = isWeekendNow();
  const chaoticPairs = [];

  for (const [pair, cond] of conditionMap.entries()) {
    if (cond.state !== "CHAOTIC") {
      // Time-based reset: only clear escalation counter after 30 min of sustained NORMAL
      const entry = _consecutivePairTriggers.get(pair);
      if (entry) {
        if (!entry.lastNormalAt) {
          _consecutivePairTriggers.set(pair, { ...entry, lastNormalAt: now });
        } else if ((now - entry.lastNormalAt) >= TRIGGER_RESET_AFTER_MS) {
          _consecutivePairTriggers.delete(pair);
          console.log(`[killSwitch] ✅ ${pair} consecutive trigger count reset after 30min NORMAL`);
        }
      }
      continue;
    }
    chaoticPairs.push(pair);

    // Skip if already paused
    if (isPaused(pair)) continue;

    // Escalate duration on repeated triggers
    // Weekend OTC: cap at 2x (10 min max) — thin liquidity causes repeated false triggers
    // Live Forex:  cap at 3x (15 min max) — was 4x (20 min), reduced to be less punishing
    const prevEntry    = _consecutivePairTriggers.get(pair);
    const count        = (prevEntry?.count ?? 0) + 1;
    _consecutivePairTriggers.set(pair, { count, lastNormalAt: null });
    const capMultiplier = weekend ? Math.min(count, 2) : Math.min(count, 3);
    const pauseMs      = PAIR_PAUSE_MS * capMultiplier;

    _pauses.set(pair, {
      resumeAt: now + pauseMs,
      reason:   cond.reason ?? "CHAOTIC market",
      pausedAt: now,
    });

    logKillSwitch(pair, cond.reason ?? "CHAOTIC", pauseMs);
    console.log(`[killSwitch] ⛔ PAUSED ${pair} for ${pauseMs / 60000}min (trigger #${count}${weekend ? " OTC-weekend" : ""}) — ${cond.reason}`);
  }

  // Session-wide pause — relaxed on OTC weekends
  const activeChaoticThreshold = weekend ? OTC_CHAOTIC_THRESHOLD : CHAOTIC_THRESHOLD;
  const activeSessionPauseMs   = weekend ? OTC_SESSION_PAUSE_MS  : SESSION_PAUSE_MS;

  if (!hasActiveTrade && chaoticPairs.length >= activeChaoticThreshold && !isPaused("SESSION")) {
    _pauses.set("SESSION", {
      resumeAt: now + activeSessionPauseMs,
      reason:   `${chaoticPairs.length} pairs CHAOTIC: ${chaoticPairs.join(", ")}`,
      pausedAt: now,
    });
    logKillSwitch(null, `Session-wide pause: ${chaoticPairs.length} CHAOTIC pairs${weekend ? " (OTC weekend)" : ""}`, activeSessionPauseMs);
    console.log(`[killSwitch] 🚨 SESSION PAUSED ${activeSessionPauseMs / 60000}min${weekend ? " (OTC weekend mode)" : ""} — ${chaoticPairs.length} CHAOTIC pairs`);
  }
}

/**
 * Get all current pauses (for status endpoint).
 */
export function getPauseStatus() {
  const now = Date.now();
  const active = [];
  for (const [key, p] of _pauses.entries()) {
    if (now < p.resumeAt) {
      active.push({
        target:        key,
        reason:        p.reason,
        pausedAt:      new Date(p.pausedAt).toISOString(),
        resumeAt:      new Date(p.resumeAt).toISOString(),
        remainingSecs: Math.ceil((p.resumeAt - now) / 1000),
      });
    }
  }
  return active;
}

/**
 * Manually clear all pauses (admin override).
 */
export function clearAllPauses() {
  _pauses.clear();
  _consecutivePairTriggers.clear();
  console.log("[killSwitch] All pauses cleared manually");
}
