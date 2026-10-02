// ═══════════════════════════════════════════════════════════════════════════════
// SIGNALEX V9.0 — Market Condition Classifier  (P6 + P7)
// lib/marketCondition.js
// ═══════════════════════════════════════════════════════════════════════════════
//
// PURPOSE (PRE-FILTER only — never modifies signal logic):
//   Classifies each pair as NORMAL | VOLATILE | CHAOTIC using live candle data.
//   Result feeds the kill switch (P8) and marketForecast (P10).
//   CHAOTIC  → signal blocked entirely
//   VOLATILE → stronger confirmation required (handled by existing engine)
//   NORMAL   → signal engine proceeds normally
//
// METRICS USED:
//   1. Candle body ratio      — body / (high-low) < 0.25 = choppy/indecisive
//   2. ATR spike ratio        — current ATR vs rolling ATR average
//   3. Whipsaw detection      — consecutive direction reversals
//   4. Wick dominance         — large wicks = rejection / uncertainty
//   5. Volume anomaly proxy   — candle-size as volume proxy (no tick data)
// ═══════════════════════════════════════════════════════════════════════════════

import { logMarketCondition } from "./db.js";

// ── Thresholds ─────────────────────────────────────────────────────────────────
const ATR_SPIKE_CHAOTIC  = 2.5;   // ATR > 2.5x rolling avg → CHAOTIC (live Forex)
const ATR_SPIKE_VOLATILE = 1.8;   // [BUG3-FIX] was 1.6 — normal active sessions exceed 1.6x; raised to 1.8
const WHIPSAW_THRESHOLD  = 4;     // [BUG2-FIX] was 3 — live Forex: 4 reversals in 8 candles
const WHIPSAW_LOOKBACK   = 8;     // [BUG2-FIX] was 5 candles — wider 8-candle window reduces false CHAOTIC
const BODY_RATIO_MIN     = 0.20;  // body/range < 20% = doji/indecision dominated
const WICK_RATIO_MAX     = 0.70;  // wick > 70% of candle = rejection dominated
const ATR_PERIOD         = 14;    // rolling ATR window
const LOOKBACK           = 20;    // candles used for context
const REPEAT_SPIKE_COUNT = 3;     // [BUG3-FIX] was 2 — two consecutive spikes is normal volatility; raised to 3

// ── OTC / Weekend adjusted thresholds ─────────────────────────────────────────
// OTC weekend pairs (Sat/Sun) trade on synthetic broker prices with thin
// liquidity. Price naturally oscillates between bid/ask more frequently,
// producing more direction reversals per candle than live Forex — this is
// structural, not chaos. Applying live-Forex thresholds to OTC weekend data
// causes the kill-switch to fire on every scan and block all signals.
//
// These relaxed thresholds only apply when BOTH conditions are true:
//   1. The pair name contains "OTC"
//   2. Current UTC day is Saturday (6) or Sunday (0)
const OTC_WHIPSAW_THRESHOLD  = 6;    // was 4 — OTC weekend needs 6 reversals to be genuinely chaotic
const OTC_ATR_SPIKE_CHAOTIC  = 3.5;  // was 2.5 — OTC weekend ATR must be extreme to signal real danger
const OTC_REPEAT_SPIKE_COUNT = 4;    // was 3 — need 4 consecutive spikes on OTC weekend

function isOTCWeekend(pair) {
  const isOTC     = /OTC/i.test(pair);
  const dayUTC    = new Date().getUTCDay();
  const isWeekend = dayUTC === 0 || dayUTC === 6;
  return isOTC && isWeekend;
}

/**
 * Classify a single pair's market condition from its candle array.
 *
 * @param {string} pair   — e.g. "EUR/USD OTC"
 * @param {Array}  candles — [{open,high,low,close,volume,time}, ...]  (newest last)
 * @returns {{ pair, state, riskType, confidence, recommendation, reason, details }}
 */
export function classifyMarketCondition(pair, candles) {
  if (!candles || candles.length < ATR_PERIOD + 2) {
    return _result(pair, "NORMAL", "NONE", 0.5, "TRADE", "Insufficient candle data for classification");
  }

  // Select threshold set based on pair type and day
  const otcWeekend       = isOTCWeekend(pair);
  const activeWhipsaw    = otcWeekend ? OTC_WHIPSAW_THRESHOLD  : WHIPSAW_THRESHOLD;
  const activeATRChaotic = otcWeekend ? OTC_ATR_SPIKE_CHAOTIC  : ATR_SPIKE_CHAOTIC;
  const activeSpikeCount = otcWeekend ? OTC_REPEAT_SPIKE_COUNT : REPEAT_SPIKE_COUNT;
  if (otcWeekend) {
    console.log(`[marketCondition] ${pair}: using OTC-weekend thresholds (whipsaw≥${activeWhipsaw}, ATR≥${activeATRChaotic}x, spikes≥${activeSpikeCount})`);
  }

  const recent = candles.slice(-Math.max(LOOKBACK, ATR_PERIOD + 2));
  const opens  = recent.map((c) => c.open);
  const highs  = recent.map((c) => c.high);
  const lows   = recent.map((c) => c.low);
  const closes = recent.map((c) => c.close);

  // ── 1. Candle ATR (true range) ─────────────────────────────────────────────
  const trueRanges = [];
  for (let i = 1; i < recent.length; i++) {
    trueRanges.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i]  - closes[i - 1]),
    ));
  }
  const currentATR = trueRanges.slice(-ATR_PERIOD).reduce((a, b) => a + b, 0) / ATR_PERIOD;
  const baseATR    = trueRanges.slice(0, ATR_PERIOD).reduce((a, b) => a + b, 0) / ATR_PERIOD;
  const atrRatio   = baseATR > 0 ? currentATR / baseATR : 1.0;

  // ── 2. Volatility spike detection (P7) ────────────────────────────────────
  const lastCandle     = recent[recent.length - 1];
  const candleSize     = lastCandle.high - lastCandle.low;
  const avgCandleSize  = trueRanges.slice(-10).reduce((a, b) => a + b, 0) / 10;
  const spikeRatio     = avgCandleSize > 0 ? candleSize / avgCandleSize : 1.0;

  // Count consecutive ATR spikes (P7: "if repeated → trigger pause")
  let consecutiveSpikes = 0;
  for (let i = trueRanges.length - 1; i >= Math.max(0, trueRanges.length - 5); i--) {
    if (trueRanges[i] > baseATR * ATR_SPIKE_VOLATILE) consecutiveSpikes++;
    else break;
  }

  // ── 3. Whipsaw detection (direction reversals) ────────────────────────────
  // [BUG2-FIX] was last 5 candles — now uses WHIPSAW_LOOKBACK (8) for a fairer window
  let whipsaws = 0;
  const lastN = closes.slice(-(WHIPSAW_LOOKBACK + 1));
  for (let i = 1; i < lastN.length - 1; i++) {
    const prev = lastN[i] - lastN[i - 1];
    const curr = lastN[i + 1] - lastN[i];
    if (prev !== 0 && curr !== 0 && Math.sign(prev) !== Math.sign(curr)) whipsaws++;
  }

  // ── 4. Body ratio (indecision / doji analysis) ────────────────────────────
  const last4Bodies = recent.slice(-4).map((c) => {
    const range = c.high - c.low;
    return range > 0 ? Math.abs(c.close - c.open) / range : 1;
  });
  const avgBodyRatio = last4Bodies.reduce((a, b) => a + b, 0) / last4Bodies.length;

  // ── 5. Wick dominance ─────────────────────────────────────────────────────
  const lastWickRatio = (() => {
    const c     = lastCandle;
    const range = c.high - c.low;
    if (range === 0) return 0;
    const body  = Math.abs(c.close - c.open);
    return (range - body) / range;
  })();

  // ── Classification decision tree ──────────────────────────────────────────
  const reasons = [];
  let state      = "NORMAL";
  let riskType   = "NONE";
  let confidence = 0.75;

  // CHAOTIC conditions — uses OTC-weekend thresholds if applicable
  if (atrRatio >= activeATRChaotic) {
    reasons.push(`ATR spike ${atrRatio.toFixed(2)}x (threshold: ${activeATRChaotic}x)`);
    state = "CHAOTIC"; riskType = "UNSCHEDULED_RISK";
  }
  if (whipsaws >= activeWhipsaw) {
    reasons.push(`${whipsaws} whipsaws in last ${WHIPSAW_LOOKBACK} candles`);
    state = "CHAOTIC"; riskType = "UNSCHEDULED_RISK";
  }
  if (consecutiveSpikes >= activeSpikeCount && state !== "CHAOTIC") {
    reasons.push(`${consecutiveSpikes} consecutive volatility spikes`);
    state = "CHAOTIC"; riskType = "UNSCHEDULED_RISK";
  }

  // VOLATILE conditions (only if not already CHAOTIC)
  if (state === "NORMAL") {
    if (atrRatio >= ATR_SPIKE_VOLATILE) {
      reasons.push(`Elevated ATR ${atrRatio.toFixed(2)}x`);
      state = "VOLATILE"; confidence = 0.65;
    }
    if (spikeRatio >= 1.8) {
      reasons.push(`Candle spike ${spikeRatio.toFixed(2)}x avg size`);
      state = "VOLATILE"; confidence = 0.60;
    }
    if (avgBodyRatio < BODY_RATIO_MIN) {
      reasons.push(`Indecision candles (body ratio ${(avgBodyRatio * 100).toFixed(0)}%)`);
      state = "VOLATILE"; confidence = 0.60;
    }
    if (lastWickRatio > WICK_RATIO_MAX) {
      reasons.push(`Wick dominance ${(lastWickRatio * 100).toFixed(0)}% of last candle`);
      state = "VOLATILE"; confidence = 0.60;
    }
  }

  if (state === "NORMAL" && reasons.length === 0) {
    reasons.push("Price action within normal parameters");
  }
  if (state === "CHAOTIC") confidence = 0.85;

  const recommendation = state === "CHAOTIC" ? "STOP"
    : state === "VOLATILE" ? "REDUCE"
    : "TRADE";

  const reasonStr = reasons.join(" | ");

  // Log to SQLite (async — fire and forget)
  try { logMarketCondition(pair, state, riskType, confidence, reasonStr); } catch (_) {}

  console.log(`[marketCondition] ${pair}: ${state} | ${riskType} | conf=${confidence} | ${reasonStr}`);

  return _result(pair, state, riskType, confidence, recommendation, reasonStr, {
    atrRatio: +atrRatio.toFixed(3),
    spikeRatio: +spikeRatio.toFixed(3),
    whipsaws,
    avgBodyRatio: +avgBodyRatio.toFixed(3),
    wickRatio: +lastWickRatio.toFixed(3),
    consecutiveSpikes,
  });
}

/**
 * Classify multiple pairs in batch.
 * @param {Array} pricePairs — [{ pair, candles }]
 * @returns {Map<string, object>} pair → classification result
 */
export function classifyAll(pricePairs) {
  const results = new Map();
  for (const { pair, candles } of pricePairs) {
    results.set(pair, classifyMarketCondition(pair, candles));
  }
  return results;
}

/**
 * Check if a pair should be blocked from trading.
 * CHAOTIC → always block
 * VOLATILE → allow with stronger confirmation (handled in signal engine)
 */
export function shouldBlock(classification) {
  return classification?.state === "CHAOTIC";
}

function _result(pair, state, riskType, confidence, recommendation, reason, details = {}) {
  return { pair, state, riskType, confidence, recommendation, reason, details };
}
