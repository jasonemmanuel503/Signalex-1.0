// ═══════════════════════════════════════════════════════════════════════════════
// SIGNALEX V10 — Shadow Evaluator
// Computes honest outcome evidence on closed candles for EVERY signal generated,
// including signals that were never traded.
// Strictly isolated: shadow results NEVER count toward real stats or loss streak.
// ═══════════════════════════════════════════════════════════════════════════════

import { getCandles } from "./priceResolver.js";
import { updateJournalShadowResult } from "../store/index.js";
import outbox from "../store/outbox.js";

/**
 * Schedules shadow evaluation after trade expiry plus 15 seconds margin.
 */
export function scheduleShadowEvaluation(signal) {
  if (!signal || !signal.id || !signal.pair || !signal.direction) return;

  const expirySecs = Number(signal.expirySecs || signal.expiry || 60);
  const entryPrice = Number(signal.entryPrice || signal.signal_price || signal.price);
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    console.debug(`[ShadowEvaluator] Signal ${signal.id} has no entry price; skipping shadow check.`);
    return;
  }

  const delayMs = (expirySecs + 15) * 1000;

  const timer = setTimeout(async () => {
    try {
      await evaluateShadowOutcome(signal, entryPrice, expirySecs);
    } catch (err) {
      console.warn(`[ShadowEvaluator] Error evaluating shadow outcome for ${signal.id}:`, err.message);
    }
  }, delayMs);

  if (timer && timer.unref) {
    timer.unref();
  }
}

async function evaluateShadowOutcome(signal, entryPrice, expirySecs) {
  const candleRes = await getCandles(signal.pair, 20);
  if (!candleRes.candles || candleRes.candles.length === 0) {
    console.debug(`[ShadowEvaluator] No candles found to evaluate shadow outcome for ${signal.id}`);
    return;
  }

  // Find the candle closing nearest to expiry timestamp
  const targetEpochSec = Math.floor((signal.createdAt || Date.now()) / 1000) + expirySecs;
  const sorted = [...candleRes.candles].sort((a, b) => Math.abs(a.timestamp - targetEpochSec) - Math.abs(b.timestamp - targetEpochSec));
  const closingCandle = sorted[0];

  if (!closingCandle) return;

  const exitPrice = closingCandle.close;
  let shadowResult = "TIE";

  if (signal.direction === "CALL") {
    if (exitPrice > entryPrice) shadowResult = "WIN";
    else if (exitPrice < entryPrice) shadowResult = "LOSS";
  } else if (signal.direction === "PUT") {
    if (exitPrice < entryPrice) shadowResult = "WIN";
    else if (exitPrice > entryPrice) shadowResult = "LOSS";
  }

  console.log(
    `[ShadowEvaluator] Signal ${signal.id} (${signal.pair} ${signal.direction}) | Entry: ${entryPrice} | Exit: ${exitPrice} | Shadow: ${shadowResult}`
  );

  // 1. Update in Journal
  updateJournalShadowResult(signal.id, shadowResult);

  // 2. Queue shadow result update in Supabase signals & trades tables
  outbox.enqueue("signals:update", {
    id: signal.id,
    shadow_result: shadowResult,
  });

  outbox.enqueue("trades:update", {
    id: signal.id,
    shadow_result: shadowResult,
  });
}
