// ═══════════════════════════════════════════════════════════════════════════════
// SIGNALEX V10.0 — Market Forecasting Engine
// lib/marketForecast.js
// ═══════════════════════════════════════════════════════════════════════════════
//
// THREE ANALYSIS LAYERS per pair:
//   Layer 1 — Candle anomaly detection (expansion, ATR acceleration)
//   Layer 2 — Structural instability   (whipsaws, fake breakouts, trend failure)
//   Layer 3 — News correlation         (live fetch + dynamic blackout)
//
// DAILY OUTLOOK ENGINE (V10.0):
//   After each 30-min cycle, produces a full-day session prediction:
//   ASIAN / LONDON / NEWYORK / EVENING → each with state + confidence
//   Based on: live ATR levels, upcoming scheduled news, historical time-of-day
//   patterns from trade database, and current structural analysis.
//
// LIVE NEWS FETCH:
//   Every 30-min cycle actively re-fetches news from Finnhub + ForexFactory.
//   Falls back to hardcoded schedule if APIs fail.
//   Both scheduled and unscheduled risk (anomaly-detected) are classified.
//
// SAFETY: Never modifies signal direction or confidence.
// ═══════════════════════════════════════════════════════════════════════════════

import { classifyMarketCondition } from "./marketCondition.js";
import { isNewsBlackout, forceNewsRefresh } from "./newsFilter.js";

// ── Cache ──────────────────────────────────────────────────────────────────────
const _cache     = new Map();   // pair → { result, cachedAt }
const CACHE_TTL  = 30 * 60 * 1000;
let _lastFullRun = 0;
let _lastNewsRefresh = 0;
const NEWS_REFRESH_INTERVAL = 30 * 60 * 1000;

// ── Daily outlook cache ────────────────────────────────────────────────────────
let _dailyOutlook = null;
let _dailyOutlookAt = 0;
const OUTLOOK_TTL = 30 * 60 * 1000;

// ── Global risk mode ──────────────────────────────────────────────────────────
let _globalRiskMode = false;
export function setGlobalRiskMode(v) { _globalRiskMode = v; console.log(`[marketForecast] GLOBAL_RISK_MODE → ${v}`); }
export function getGlobalRiskMode() { return _globalRiskMode; }

// ── Session hours (UTC) ───────────────────────────────────────────────────────
const SESSIONS = [
  { key: "ASIAN",   startH: 2,  endH: 5,  label: "🌏 Asian",    pairs: ["JPY","AUD","NZD"] },
  { key: "LONDON",  startH: 8,  endH: 12, label: "🇬🇧 London",   pairs: ["GBP","EUR","CHF"] },
  { key: "NEWYORK", startH: 13, endH: 17, label: "🇺🇸 New York", pairs: ["USD","CAD"] },
  { key: "EVENING", startH: 19, endH: 23, label: "🌙 Evening",   pairs: ["OTC"] },
];

// ── Anomaly detection (Layer 1) ───────────────────────────────────────────────
function detectAnomalies(candles) {
  if (!candles || candles.length < 15) return { hasAnomaly: false };
  const recent = candles.slice(-20);
  const ranges = recent.map((c) => c.high - c.low);
  const avg    = ranges.slice(0,-1).reduce((a,b)=>a+b,0) / (ranges.length-1);
  const last   = ranges[ranges.length-1];
  const expansionRatio = avg > 0 ? last/avg : 1;
  const earlyATR = ranges.slice(0,7).reduce((a,b)=>a+b,0)/7;
  const lateATR  = ranges.slice(-7).reduce((a,b)=>a+b,0)/7;
  const atrAccel = earlyATR > 0 ? lateATR/earlyATR : 1;
  return {
    hasAnomaly: expansionRatio > 2.0 || atrAccel > 1.8,
    expansionRatio: +expansionRatio.toFixed(3),
    atrAcceleration: +atrAccel.toFixed(3),
  };
}

// ── Structural instability (Layer 2) ──────────────────────────────────────────
function detectStructuralInstability(candles) {
  if (!candles || candles.length < 10) return { isUnstable: false };
  const closes = candles.slice(-10).map((c) => c.close);
  const highs  = candles.slice(-10).map((c) => c.high);
  const lows   = candles.slice(-10).map((c) => c.low);
  let whipsaws = 0;
  for (let i=1; i<closes.length-1; i++) {
    const p = closes[i]-closes[i-1], c = closes[i+1]-closes[i];
    if (p!==0 && c!==0 && Math.sign(p)!==Math.sign(c)) whipsaws++;
  }
  let fakeBreakouts = 0;
  for (let i=2; i<10; i++) {
    const pH = Math.max(...highs.slice(i-2,i)), pL = Math.min(...lows.slice(i-2,i));
    const bar = candles.slice(-10)[i];
    if (bar.high > pH && bar.close < pH) fakeBreakouts++;
    if (bar.low  < pL && bar.close > pL) fakeBreakouts++;
  }
  const ema3 = _ema(closes,3), ema8 = _ema(closes,8);
  const trendFail = ema3.length>=2 && ema8.length>=2 &&
    ((ema3.at(-2)>ema8.at(-2)) !== (ema3.at(-1)>ema8.at(-1)));
  return { isUnstable: whipsaws>=3||fakeBreakouts>=2||trendFail, whipsaws, fakeBreakouts, trendFail };
}

// ── Live news fetch (Layer 3 — V10.0) ─────────────────────────────────────────
async function refreshLiveNews() {
  const now = Date.now();
  if (now - _lastNewsRefresh < NEWS_REFRESH_INTERVAL) return;
  try {
    await forceNewsRefresh();
    _lastNewsRefresh = now;
    console.log("[marketForecast] Live news refreshed from APIs");
  } catch (err) {
    console.warn("[marketForecast] News refresh failed (using cache):", err.message);
  }
}

async function analyzeNewsRisk(pair, anomalyDetected) {
  try {
    const check = await isNewsBlackout(pair);
    const isBlocked = check?.blocked ?? false;
    return {
      isBlocked,
      riskType: isBlocked ? "SCHEDULED_NEWS" : anomalyDetected ? "UNSCHEDULED_RISK" : "NONE",
      reason:   check?.reason ?? "",
      nextClear: check?.nextClearAt ?? null,
    };
  } catch {
    return { isBlocked: false, riskType: anomalyDetected ? "UNSCHEDULED_RISK" : "NONE", reason: "", nextClear: null };
  }
}

// ── Per-pair forecast ──────────────────────────────────────────────────────────
export async function forecastPair(pair, candles) {
  const cached = _cache.get(pair);
  if (cached && Date.now()-cached.cachedAt < CACHE_TTL) return cached.result;

  const anomaly    = detectAnomalies(candles);
  const structural = detectStructuralInstability(candles);
  const newsRisk   = await analyzeNewsRisk(pair, anomaly.hasAnomaly);
  const condition  = classifyMarketCondition(pair, candles);

  let market_state = condition.state;
  let confidence   = condition.confidence;
  const reasons    = [];

  if (newsRisk.isBlocked) {
    market_state = "VOLATILE"; confidence = Math.min(confidence, 0.60);
    reasons.push(`Scheduled news: ${newsRisk.reason}`);
  }
  if (anomaly.hasAnomaly) {
    if (market_state === "NORMAL") market_state = "VOLATILE";
    confidence = Math.min(confidence, 0.55);
    reasons.push(`Candle anomaly: ${anomaly.expansionRatio}x expansion`);
  }
  if (structural.isUnstable) {
    market_state = "CHAOTIC"; confidence = Math.min(confidence, 0.50);
    reasons.push(`Structural: ${structural.whipsaws} whipsaws, ${structural.fakeBreakouts} fake breakouts`);
  }
  if (newsRisk.riskType === "UNSCHEDULED_RISK") {
    market_state = "CHAOTIC"; confidence = Math.min(confidence, 0.45);
    reasons.push("Unscheduled risk event detected");
  }
  if (_globalRiskMode && market_state === "NORMAL") {
    market_state = "VOLATILE"; reasons.push("GLOBAL_RISK_MODE active");
  }
  if (reasons.length === 0) reasons.push(condition.reason || "Normal conditions");

  const recommendation = market_state==="CHAOTIC" ? "STOP" : market_state==="VOLATILE" ? "REDUCE" : "TRADE";

  const result = {
    pair, market_state, risk_type: newsRisk.riskType,
    confidence: +confidence.toFixed(3), recommendation,
    reason: reasons.join(" | "),
    layers: {
      anomaly:    { hasAnomaly: anomaly.hasAnomaly, expansionRatio: anomaly.expansionRatio },
      structural: { isUnstable: structural.isUnstable, whipsaws: structural.whipsaws },
      news:       { isBlocked: newsRisk.isBlocked, riskType: newsRisk.riskType },
      condition:  { state: condition.state, atrRatio: condition.details?.atrRatio },
    },
    forecastedAt: new Date().toISOString(),
  };

  _cache.set(pair, { result, cachedAt: Date.now() });
  return result;
}

// ── Daily outlook engine (V10.0) ──────────────────────────────────────────────
// Produces per-session predictions for the full day using:
//   1. Live ATR from current candle data (what the market is doing NOW)
//   2. Upcoming scheduled news events from the news calendar
//   3. Historical time-of-day patterns (encoded as base volatility expectations)
//   4. Structural analysis of current pair data extrapolated to session windows

function computeSessionOutlook(sessionDef, allPairResults, avgATR, scheduledNewsHours) {
  const { key, startH, endH, label, pairs: relevantCurrencies } = sessionDef;
  const nowH = new Date().getUTCHours() + new Date().getUTCMinutes()/60;
  const isActive = nowH >= startH && nowH < endH;
  const isPast   = nowH >= endH;
  const isFuture = nowH < startH;

  // Historical base volatility expectations by session (from market research)
  const BASE_VOLATILITY = { ASIAN: 0.35, LONDON: 0.75, NEWYORK: 0.80, EVENING: 0.45 };
  const baseVol = BASE_VOLATILITY[key] ?? 0.5;

  // Check if scheduled news falls within this session window
  const newsInSession = scheduledNewsHours.some(h => h >= startH && h < endH);

  // Count how many pairs relevant to this session are currently CHAOTIC/VOLATILE
  const relevantPairs = allPairResults.filter(r =>
    relevantCurrencies.some(cur =>
      r.pair.includes(cur) || (cur === "OTC" && r.pair.includes("OTC"))
    )
  );
  const chaoticCount  = relevantPairs.filter(r => r.market_state === "CHAOTIC").length;
  const volatileCount = relevantPairs.filter(r => r.market_state === "VOLATILE").length;
  const normalCount   = relevantPairs.filter(r => r.market_state === "NORMAL").length;
  const totalRelevant = relevantPairs.length || 1;

  // Compute session health score (0-100)
  let score = Math.round(
    (normalCount / totalRelevant) * 60        // 60% weight: current pair states
    + (baseVol) * 25                           // 25% weight: historical volatility
    + (newsInSession ? 0 : 15)                 // 15% weight: no news = bonus
  );
  if (chaoticCount >= 2) score = Math.min(score, 40);
  if (newsInSession)      score = Math.min(score, 55);
  score = Math.max(0, Math.min(100, score));

  // Derive state from score
  let state = score >= 65 ? "NORMAL" : score >= 40 ? "VOLATILE" : "CHAOTIC";

  // ATR context: if current ATR is elevated, flag for session
  const atrFlag = avgATR > 0.05 ? " | Elevated ATR" : "";

  // Build prediction text
  const newsNote   = newsInSession ? " ⚠️ News risk" : "";
  const statusIcon = state === "NORMAL" ? "🟢" : state === "VOLATILE" ? "🟡" : "🔴";
  const timeStatus = isActive ? "LIVE NOW" : isPast ? "COMPLETED" : `Starts ${String(startH).padStart(2,"0")}:00 UTC`;

  const recommendation = state === "NORMAL"
    ? "Good conditions for trading"
    : state === "VOLATILE"
    ? "Trade with caution, reduce size"
    : "Avoid — high risk conditions";

  return {
    key, label, startH, endH,
    state, score, confidence: +(score/100).toFixed(2),
    isActive, isPast, isFuture,
    statusIcon, timeStatus, recommendation,
    newsRisk: newsInSession,
    notes: `${relevantPairs.length} pairs | ${normalCount} normal, ${volatileCount} volatile, ${chaoticCount} chaotic${newsNote}${atrFlag}`,
  };
}

export async function buildDailyOutlook(allPairResults, allPairCandles) {
  const now = Date.now();
  if (_dailyOutlook && now - _dailyOutlookAt < OUTLOOK_TTL) return _dailyOutlook;

  // Compute average ATR across all pairs
  let atrSum = 0, atrCount = 0;
  for (const { candles } of allPairCandles) {
    if (!candles || candles.length < 14) continue;
    const ranges = candles.slice(-14).map(c => c.high - c.low);
    const atr    = ranges.reduce((a,b)=>a+b,0)/14;
    const last   = candles[candles.length-1].close;
    if (last > 0) { atrSum += (atr/last)*100; atrCount++; }
  }
  const avgATR = atrCount > 0 ? atrSum/atrCount : 0;

  // Get upcoming scheduled news hours (simplified from newsFilter cache)
  let scheduledNewsHours = [];
  try {
    const { getUpcomingEvents } = await import("./newsFilter.js");
    const events = getUpcomingEvents?.() ?? [];
    scheduledNewsHours = events.map(e => {
      const d = new Date(e.timestamp);
      return d.getUTCHours() + d.getUTCMinutes()/60;
    }).filter(h => !isNaN(h));
  } catch {}

  // Build per-session outlooks
  const sessionOutlooks = SESSIONS.map(s =>
    computeSessionOutlook(s, allPairResults, avgATR, scheduledNewsHours)
  );

  // Overall market score: weighted average of session scores
  const weights = { ASIAN: 0.15, LONDON: 0.30, NEWYORK: 0.30, EVENING: 0.25 };
  const overallScore = Math.round(
    sessionOutlooks.reduce((sum, s) => sum + s.score * (weights[s.key]??0.25), 0)
  );

  // Normal/volatile/chaotic counts for overall label
  const chaoticSessions  = sessionOutlooks.filter(s => s.state === "CHAOTIC").length;
  const volatileSessions = sessionOutlooks.filter(s => s.state === "VOLATILE").length;
  const overallState     = chaoticSessions >= 2 ? "CHAOTIC"
    : chaoticSessions >= 1 || volatileSessions >= 2 ? "VOLATILE"
    : "NORMAL";

  // Pair-level summary
  const totalPairs   = allPairResults.length;
  const chaoticPairs = allPairResults.filter(r => r.market_state === "CHAOTIC").length;
  const normalPairs  = allPairResults.filter(r => r.market_state === "NORMAL").length;

  const overallLabel = overallScore >= 70
    ? `Market is ${overallScore}% healthy — good trading conditions`
    : overallScore >= 45
    ? `Market is mixed — ${chaoticPairs} pairs risky, proceed with caution`
    : `High-risk market — ${chaoticPairs}/${totalPairs} pairs CHAOTIC, reduce exposure`;

  _dailyOutlook = {
    overallScore,
    overallState,
    overallLabel,
    avgATR: +avgATR.toFixed(4),
    pairSummary: { total: totalPairs, normal: normalPairs, chaotic: chaoticPairs, volatile: totalPairs-normalPairs-chaoticPairs },
    sessionOutlooks,
    scheduledNewsCount: scheduledNewsHours.length,
    generatedAt: new Date().toISOString(),
    nextUpdateAt: new Date(now + OUTLOOK_TTL).toISOString(),
  };
  _dailyOutlookAt = now;
  console.log(`[marketForecast] Daily outlook: score=${overallScore} state=${overallState} | ${normalPairs}N/${totalPairs-normalPairs-chaoticPairs}V/${chaoticPairs}C pairs`);
  return _dailyOutlook;
}

// ── Batch forecast ─────────────────────────────────────────────────────────────
export async function forecastAll(pricePairs) {
  // Refresh live news at start of each cycle
  await refreshLiveNews();

  _lastFullRun = Date.now();
  const results = new Map();
  await Promise.all(pricePairs.map(async ({ pair, candles }) => {
    results.set(pair, await forecastPair(pair, candles));
  }));

  // Build daily outlook from current cycle results
  const allResults = [...results.values()];
  await buildDailyOutlook(allResults, pricePairs).catch(e => console.warn("[forecast] Outlook error:", e.message));

  const chaotic  = allResults.filter(r => r.market_state === "CHAOTIC").length;
  const volatile = allResults.filter(r => r.market_state === "VOLATILE").length;
  console.log(`[marketForecast] Cycle: ${pricePairs.length} pairs | C=${chaotic} V=${volatile} N=${pricePairs.length-chaotic-volatile}`);
  return results;
}

export function getCachedForecast(pair) { return _cache.get(pair)?.result ?? null; }
export function getAllCachedForecasts() {
  return Object.fromEntries([..._cache.entries()].map(([k,v]) => [k, v.result]));
}
export function getDailyOutlook() { return _dailyOutlook; }
export function getLastFullRunAge() { return _lastFullRun ? Date.now()-_lastFullRun : null; }

function _ema(data, period) {
  if (!data||data.length<period) return [];
  const k = 2/(period+1);
  let e = data.slice(0,period).reduce((a,b)=>a+b,0)/period;
  const r = [e];
  for (let i=period; i<data.length; i++) { e = data[i]*k+e*(1-k); r.push(e); }
  return r;
}
