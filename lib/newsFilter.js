// ═══════════════════════════════════════════════════════════════════════════════
// SIGNALEX V7.0.3 — ECONOMIC NEWS BLACKOUT ENGINE
// lib/newsFilter.js
//
// PURPOSE:
//   Proactively block signal generation ±15 minutes around high-impact
//   economic news events (NFP, FOMC, CPI, interest rate decisions, etc.)
//   for the currency pairs the engine trades.
//
// WHY THIS MATTERS:
//   The 5-layer analysis engine is reactive — it reads completed candles.
//   During a news spike, price moves 30–80 pips in seconds. By the time
//   the first distorted candle closes, a signal may already have fired.
//   This module is the ONLY way to protect against that.
//
// HOW IT WORKS:
//   1. Fetches today's high-impact events from Finnhub (free tier, no key
//      needed for economic calendar) as the primary source.
//   2. Falls back to a hardcoded weekly schedule for the most predictable
//      recurring events (NFP = first Friday, FOMC = 8 times/year, etc.)
//      so protection still works when the API is unreachable.
//   3. Caches results for 30 minutes — no hammer on external APIs.
//   4. Exposes isNewsBlackout() → { blocked, reason, nextClearAt, events }
//
// COVERED CURRENCIES (matches the engine's pair list):
//   USD, EUR, GBP, JPY, AUD, CAD, CHF, NZD
//
// BLACKOUT WINDOW:
//   15 minutes BEFORE the event + 15 minutes AFTER = 30 min total blackout.
//   Configurable via NEWS_BLACKOUT_MINUTES env var.
//
// DATA SOURCES (in order of preference):
//   1. Finnhub economic calendar  (free, no key, 60 calls/min limit)
//   2. ForexFactory RSS feed      (free, no key, scrape-friendly)
//   3. Hardcoded fallback schedule (always available, covers major events)
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Config ───────────────────────────────────────────────────────────────────

// How many minutes before AND after an event to block signals
const BLACKOUT_MINUTES = parseInt(process.env.NEWS_BLACKOUT_MINUTES || "15", 10);
const BLACKOUT_MS      = BLACKOUT_MINUTES * 60 * 1000;

// Cache TTL — re-fetch at most once every 30 minutes
const CACHE_TTL_MS = 30 * 60 * 1000;

// Only block for these impact levels (Finnhub uses "high" | "medium" | "low")
const BLOCK_IMPACTS = new Set(["high"]);

// Currencies we care about — matches all pairs in the engine
const WATCHED_CURRENCIES = new Set(["USD","EUR","GBP","JPY","AUD","CAD","CHF","NZD"]);

// ─── In-memory cache ──────────────────────────────────────────────────────────
let _cachedEvents   = [];   // { timestamp: number, currency: string, event: string, impact: string }
let _cacheExpiresAt = 0;
let _lastFetchError = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function todayDateStrUTC() {
  return new Date().toISOString().slice(0, 10);   // "YYYY-MM-DD"
}

function nowMs() { return Date.now(); }

// ─── SOURCE 1: Finnhub Economic Calendar ──────────────────────────────────────
// Free endpoint — no API key required for basic calendar data.
// Returns events for today.

async function fetchFinnhub() {
  const today = todayDateStrUTC();
  const url   = `https://finnhub.io/api/v1/calendar/economic?from=${today}&to=${today}`;

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "SIGNALEX/7.0 news-filter" },
      signal:  AbortSignal.timeout(6000),
    });
    if (!res.ok) throw new Error(`Finnhub HTTP ${res.status}`);
    const data = await res.json();

    const today = todayDateStrUTC();
    const events = (data?.economicCalendar ?? [])
      .filter((e) => {
        const impact   = (e.impact ?? "").toLowerCase();
        const currency = (e.country ?? e.currency ?? "").toUpperCase().slice(0, 3);
        return BLOCK_IMPACTS.has(impact) && WATCHED_CURRENCIES.has(currency);
      })
      .map((e) => {
        // Finnhub time field: "YYYY-MM-DD HH:MM:SS" UTC
        const ts = new Date(e.time?.replace(" ", "T") + "Z").getTime();
        return {
          timestamp: ts,
          currency:  (e.country ?? e.currency ?? "").toUpperCase().slice(0, 3),
          event:     e.event ?? "High-impact event",
          impact:    "high",
          source:    "finnhub",
        };
      })
      .filter((e) => {
        if (isNaN(e.timestamp)) return false;
        // [FIX2] Reject events that don't belong to today UTC.
        // Finnhub sometimes returns adjacent-day entries when the calendar is
        // sparse — these are stale and cause phantom blackouts on wrong days.
        const eventDateUTC = new Date(e.timestamp).toISOString().slice(0, 10);
        if (eventDateUTC !== today) {
          console.warn(`[NewsFilter] Finnhub: rejected out-of-date event "${e.event}" dated ${eventDateUTC} (today is ${today})`);
          return false;
        }
        return true;
      });

    console.log(`[NewsFilter] Finnhub: ${events.length} high-impact events today`);
    return events;
  } catch (err) {
    console.warn(`[NewsFilter] Finnhub unavailable: ${err.message}`);
    return null;   // null = failed, not empty
  }
}

// ─── SOURCE 2: ForexFactory RSS ───────────────────────────────────────────────
// Public RSS feed — high-impact events listed as <category>High Impact</category>

async function fetchForexFactory() {
  try {
    const res = await fetch("https://www.forexfactory.com/rss.php?week=this", {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; SIGNALEX/7.0)",
        "Accept":     "application/rss+xml, application/xml, text/xml",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`ForexFactory HTTP ${res.status}`);
    const xml = await res.text();

    const items   = xml.match(/<item>([\s\S]*?)<\/item>/g) ?? [];
    const today   = todayDateStrUTC();
    const events  = [];

    for (const item of items) {
      const impact = (item.match(/<category>(.*?)<\/category>/)?.[1] ?? "").trim();
      if (!impact.toLowerCase().includes("high")) continue;

      const title    = item.match(/<title>(.*?)<\/title>/)?.[1] ?? "";
      const dateStr  = item.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] ?? "";
      const ts       = dateStr ? new Date(dateStr).getTime() : NaN;

      if (isNaN(ts)) continue;

      // Filter to today UTC
      if (new Date(ts).toISOString().slice(0, 10) !== today) continue;

      // Guess currency from title (FF titles start with currency code)
      const currency = title.match(/^([A-Z]{3})\s/)?.[1] ?? "USD";
      if (!WATCHED_CURRENCIES.has(currency)) continue;

      events.push({ timestamp: ts, currency, event: title, impact: "high", source: "forexfactory" });
    }

    console.log(`[NewsFilter] ForexFactory: ${events.length} high-impact events today`);
    return events;
  } catch (err) {
    console.warn(`[NewsFilter] ForexFactory unavailable: ${err.message}`);
    return null;
  }
}

// ─── SOURCE 3: Hardcoded Recurring High-Impact Schedule ───────────────────────
// V8.0 AUDIT FIX: Previous version blocked ALL Wednesdays at 13:30 UTC (CPI)
// AND 19:00 UTC (FOMC) — meaning every Wednesday evening was silenced even when
// there was no actual news event. Same problem on Thursdays (ECB/BOE blocked
// every week regardless). This was the primary cause of "no signals" on
// Wednesday and Thursday evenings.
//
// FIX: Hardcoded fallback ONLY fires when:
//   1. The event is CONFIRMED recurring on a fixed schedule (NFP = always 1st Friday)
//   2. OR we are within a tight ±45 minute window of the scheduled time
//      (was ±2 hours — far too wide, blocking 4h of trading for a 30m event)
//
// "Potential" events (CPI alternates weeks, FOMC is 8x/year not weekly) are
// REMOVED from hardcoded schedule. Live Finnhub / ForexFactory catches those.
// If both APIs fail, we only protect genuinely predictable events.

function getHardcodedEventsForToday() {
  const now   = new Date();
  const dow   = now.getUTCDay();   // 0=Sun, 1=Mon ... 5=Fri, 6=Sat
  const dom   = now.getUTCDate();
  const month = now.getUTCMonth();
  const year  = now.getUTCFullYear();
  const events = [];

  function makeEvent(hourUTC, minuteUTC, currency, label) {
    const ts = Date.UTC(year, month, now.getUTCDate(), hourUTC, minuteUTC, 0);
    events.push({ timestamp: ts, currency, event: label, impact: "high", source: "hardcoded" });
  }

  // ── NFP — CONFIRMED: always 1st Friday of every month, 13:30 UTC ──────────
  if (dow === 5 && dom <= 7) {
    makeEvent(13, 30, "USD", "Non-Farm Payrolls (NFP)");
    makeEvent(13, 30, "USD", "Unemployment Rate");
  }

  // ── US Jobless Claims — CONFIRMED: every Thursday 13:30 UTC ─────────────
  // This is genuinely weekly and predictable — keep it.
  if (dow === 4) {
    makeEvent(13, 30, "USD", "Initial Jobless Claims");
  }

  // ── RBA (AUD) — CONFIRMED: 11x/year on Tuesday ~03:30 UTC ───────────────
  // Happens most Tuesdays — worth protecting.
  if (dow === 2) {
    makeEvent(3, 30, "AUD", "RBA Cash Rate Decision");
  }

  // REMOVED (were blocking every week with no actual event):
  //   ❌ US CPI every Wednesday 13:30 — CPI is monthly, not weekly
  //   ❌ FOMC every Wednesday 19:00  — FOMC is 8x/year, not weekly
  //   ❌ ECB every Thursday          — ECB meets ~6x/year
  //   ❌ BOE every Thursday          — BOE meets ~8x/year
  //   ❌ US Retail Sales mid-month   — monthly event, not mid-month range
  //   ❌ BOJ every Friday            — BOJ meets ~8x/year
  // These are now handled ONLY by live Finnhub / ForexFactory feeds.

  // V8.0: Tight ±45min window instead of ±2 hours.
  // A 2-hour window around a 13:30 event blocks 11:30–15:30 UTC — 4 hours of trading!
  // 45 minutes is sufficient: 15min blackout + 30min cushion = 45min total.
  const WINDOW_MS = 45 * 60 * 1000;
  const filtered = events.filter((e) => Math.abs(e.timestamp - nowMs()) <= WINDOW_MS + BLACKOUT_MS);

  if (filtered.length > 0) {
    console.log(`[NewsFilter] Hardcoded: ${filtered.length} confirmed recurring events near now`);
  }
  return filtered;
}

// ─── MAIN CACHE REFRESH ───────────────────────────────────────────────────────

async function refreshCache() {
  // [FIX1] WEEKEND GUARD — Forex markets are closed Sat/Sun. There are no
  // scheduled high-impact events on weekends. Skip ALL external API calls and
  // return an empty list immediately. This prevents Finnhub from returning
  // stale Friday events (or phantom weekend entries) that linger in the cache
  // and silently block OTC signals all weekend.
  const dowNow = new Date().getUTCDay(); // 0=Sun, 6=Sat
  if (dowNow === 0 || dowNow === 6) {
    _cachedEvents   = [];
    _cacheExpiresAt = nowMs() + CACHE_TTL_MS;
    _lastFetchError = null;
    console.log(`[NewsFilter] Weekend detected — skipping API fetch, no events scheduled. Cache clear for 30 min.`);
    return [];
  }

  // Try live sources in order
  let events = await fetchFinnhub();
  if (events === null) {
    events = await fetchForexFactory();
  }

  // Merge with hardcoded recurring events (belt-and-suspenders)
  const hardcoded = getHardcodedEventsForToday();
  if (events === null) {
    // Both APIs failed — use only hardcoded
    events = hardcoded;
    _lastFetchError = "Both Finnhub and ForexFactory unavailable — using hardcoded schedule";
    console.warn(`[NewsFilter] ${_lastFetchError}`);
  } else {
    // Merge: combine live events + hardcoded, de-duplicate by ~5-min timestamp proximity
    const merged = [...events];
    for (const h of hardcoded) {
      const duplicate = events.some(
        (e) => e.currency === h.currency && Math.abs(e.timestamp - h.timestamp) < 5 * 60 * 1000
      );
      if (!duplicate) merged.push(h);
    }
    events = merged;
    _lastFetchError = null;
  }

  _cachedEvents   = events;

  // [FIX3] Cap cache expiry at the next UTC midnight so yesterday's events
  // can NEVER bleed across the day boundary. Without this, a cache populated
  // at 23:45 UTC on a weekday lives until 00:15 the next day — carrying
  // real (or phantom) events into a session where they don't apply.
  const now          = nowMs();
  const todayStr     = new Date(now).toISOString().slice(0, 10);
  const midnightUTC  = new Date(todayStr + "T00:00:00Z").getTime() + 24 * 60 * 60 * 1000;
  const normalExpiry = now + CACHE_TTL_MS;
  _cacheExpiresAt    = Math.min(normalExpiry, midnightUTC - 1000); // 1s before midnight

  console.log(`[NewsFilter] Cache refreshed: ${events.length} total events, expires ${new Date(_cacheExpiresAt).toISOString()}`);
  return events;
}

// ─── PUBLIC API ───────────────────────────────────────────────────────────────

/**
 * isNewsBlackout()
 *
 * Returns whether the current moment is within a news blackout window.
 * Safe to call on every scan cycle — results are cached for 30 minutes.
 *
 * @returns {Promise<{
 *   blocked:     boolean,
 *   reason:      string,
 *   events:      Array<{timestamp,currency,event,impact,source}>,
 *   activeEvent: object|null,
 *   nextClearAt: string|null,   // ISO timestamp when blackout ends
 *   minutesLeft: number,
 *   source:      string,
 * }>}
 */
export async function isNewsBlackout() {
  const now = nowMs();

  // Refresh cache if stale
  if (now >= _cacheExpiresAt) {
    await refreshCache();
  }

  // Check if any cached event is within the blackout window of now
  const todayUTC = new Date(now).toISOString().slice(0, 10);
  for (const evt of _cachedEvents) {
    // [FIX4] Date-sanity guard — reject any cached event that doesn't belong
    // to today UTC. Stale events from the previous day can slip through if the
    // cache was not properly invalidated at midnight. Never block on a phantom.
    const evtDateUTC = new Date(evt.timestamp).toISOString().slice(0, 10);
    if (evtDateUTC !== todayUTC) {
      console.warn(`[NewsFilter] isNewsBlackout: skipping stale event "${evt.event}" from ${evtDateUTC} (today=${todayUTC})`);
      continue;
    }

    const distanceMs = evt.timestamp - now;           // negative = event already passed
    const withinPre  = distanceMs > 0 && distanceMs <= BLACKOUT_MS;         // within 15 min BEFORE
    const withinPost = distanceMs < 0 && Math.abs(distanceMs) <= BLACKOUT_MS; // within 15 min AFTER

    if (withinPre || withinPost) {
      const label      = withinPre ? "starts" : "released";
      const absMinutes = Math.round(Math.abs(distanceMs) / 60000);
      const nextClear  = new Date(evt.timestamp + BLACKOUT_MS).toISOString();
      const minsLeft   = Math.ceil((evt.timestamp + BLACKOUT_MS - now) / 60000);

      return {
        blocked:     true,
        reason:      `News blackout — ${evt.currency} ${evt.event} ${label} in ${withinPre ? absMinutes : `${absMinutes} min ago`}. Signals resume at ${new Date(nextClear).toLocaleTimeString("en-US", { hour12: false })} GMT.`,
        events:      _cachedEvents,
        activeEvent: evt,
        nextClearAt: nextClear,
        minutesLeft: Math.max(0, minsLeft),
        source:      evt.source,
      };
    }
  }

  return {
    blocked:     false,
    reason:      "",
    events:      _cachedEvents,
    activeEvent: null,
    nextClearAt: null,
    minutesLeft: 0,
    source:      _lastFetchError ? "hardcoded_fallback" : "live",
  };
}

/**
 * getUpcomingEvents()
 *
 * Returns all cached high-impact events for today, sorted by time.
 * Used by the dashboard to display the news schedule.
 */
export function getUpcomingEvents() {
  return [..._cachedEvents].sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * forceRefresh()
 *
 * Manually trigger a cache refresh — called from the dashboard "Refresh"
 * button so the user can force an update mid-session.
 */
export async function forceNewsRefresh() {
  _cacheExpiresAt = 0;
  return refreshCache();
}

// ═══════════════════════════════════════════════════════════════════════════════
// V9.0 ADDITIONS — P9: Dynamic blackout windows + GLOBAL_RISK_MODE hook
// ═══════════════════════════════════════════════════════════════════════════════

// Dynamic blackout overrides — keyed by event type, duration in ms
const _dynamicBlackouts = new Map();   // "key" → { expiresAt, reason }

/**
 * Add a dynamic blackout window (e.g. for high-impact events).
 * @param {string} key      — identifier (e.g. "NFP_2025-05-02")
 * @param {number} durationMs — how long to block
 * @param {string} reason   — human-readable reason
 */
export function addDynamicBlackout(key, durationMs, reason = "") {
  const expiresAt = Date.now() + durationMs;
  _dynamicBlackouts.set(key, { expiresAt, reason, addedAt: Date.now() });
  console.log(`[newsFilter] Dynamic blackout added: ${key} for ${durationMs / 60000}min — ${reason}`);
}

/**
 * Returns all currently active dynamic blackouts.
 */
export function getActiveBlackouts() {
  const now = Date.now();
  const active = [];
  for (const [key, b] of _dynamicBlackouts.entries()) {
    if (now < b.expiresAt) {
      active.push({ key, reason: b.reason, expiresAt: new Date(b.expiresAt).toISOString(), remainingSecs: Math.ceil((b.expiresAt - now) / 1000) });
    } else {
      _dynamicBlackouts.delete(key);   // auto-clean expired
    }
  }
  return active;
}

/**
 * Check if any dynamic blackout is currently active.
 */
export function isDynamicBlackoutActive() {
  const now = Date.now();
  for (const [, b] of _dynamicBlackouts.entries()) {
    if (now < b.expiresAt) return true;
  }
  return false;
}

/**
 * Extended isNewsBlackout that also checks dynamic blackouts.
 * Drop-in replacement for isNewsBlackout — backward compatible.
 */
export async function isNewsBlackoutExtended(pair) {
  // Check dynamic blackouts first (faster, no async)
  if (isDynamicBlackoutActive()) {
    const active = getActiveBlackouts();
    return {
      blocked:     true,
      reason:      `Dynamic blackout: ${active[0]?.reason ?? "manual override"}`,
      events:      [],
      activeEvent: { event: active[0]?.key, impact: "high" },
      nextClearAt: active[0]?.expiresAt ?? null,
      minutesLeft: active[0] ? Math.ceil(active[0].remainingSecs / 60) : 0,
      source:      "dynamic_blackout",
    };
  }
  // Fall through to standard news blackout check
  return isNewsBlackout(pair);
}

// ═══════════════════════════════════════════════════════════════════════════════
// V10.5 — REAL-TIME VOLATILITY SPIKE DETECTOR
// ═══════════════════════════════════════════════════════════════════════════════
//
// PURPOSE:
//   Catch unscheduled market-moving events (surprise central bank statements,
//   geopolitical shocks, broker anomalies) that no economic calendar can predict.
//   Works on weekends (OTC) and weekdays alike — calendar-independent.
//
// HOW IT WORKS:
//   Called once per scan with the current candle data for all active pairs.
//   For each pair it computes the latest candle's true range vs the 14-candle
//   rolling ATR. If the spike ratio exceeds SPIKE_ATR_THRESHOLD AND at least
//   SPIKE_MIN_PAIRS pairs share the same base or quote currency spiking
//   simultaneously, a dynamic blackout is registered for SPIKE_BLACKOUT_MS.
//
// SAFETY DESIGN (prevents false positives / blind blocking):
//   • Single-pair spikes are ALWAYS ignored — lone spikes = low liquidity noise
//   • Requires correlated pairs (same currency) to spike together — confirms
//     the move is currency-driven, not a single broker feed glitch
//   • ATR threshold is 3.0x — above the 2.5x CHAOTIC threshold already in
//     marketCondition.js, so only genuinely extreme moves trigger it
//   • Blackout is per-currency, not global — GBP/JPY spike doesn't block AUD/USD
//   • Each blackout key is unique per currency+timestamp so it auto-expires
//     and never double-fires within the same window
//   • Cooldown: won't re-trigger the same currency within SPIKE_COOLDOWN_MS
//
// ─────────────────────────────────────────────────────────────────────────────

const SPIKE_ATR_PERIOD      = 14;          // candles for rolling ATR baseline
const SPIKE_ATR_THRESHOLD   = 3.0;         // latest candle must be ≥ 3x ATR to count
const SPIKE_MIN_PAIRS       = 2;           // min correlated pairs spiking simultaneously
const SPIKE_BLACKOUT_MS     = 10 * 60 * 1000;  // 10-minute blackout per spike event
const SPIKE_COOLDOWN_MS     = 12 * 60 * 1000;  // 12-min cooldown before same currency re-fires

// Track last trigger time per currency to enforce cooldown
const _spikeCooldowns = new Map();  // currency → lastTriggeredAt (ms)

/**
 * Compute true range for a single candle against previous close.
 * True Range = max(high-low, |high-prevClose|, |low-prevClose|)
 */
function trueRange(candle, prevClose) {
  const hl  = candle.high - candle.low;
  const hpc = Math.abs(candle.high - prevClose);
  const lpc = Math.abs(candle.low  - prevClose);
  return Math.max(hl, hpc, lpc);
}

/**
 * detectVolatilitySpike(pairCandleMap)
 *
 * Call this once per scan with live candle data. Automatically registers
 * dynamic blackouts via addDynamicBlackout() for any currency showing
 * a confirmed multi-pair ATR spike. Returns a summary of what fired (if anything).
 *
 * @param {Array<{ pair: string, candles: Array<{open,high,low,close}> }>} pairCandleMap
 * @returns {{ triggered: boolean, events: Array<{currency, pairs, ratio, blackoutKey}> }}
 */
export function detectVolatilitySpike(pairCandleMap) {
  const now      = Date.now();
  const fired    = [];

  // ── Step 1: Compute spike ratio for every pair ────────────────────────────
  // spike ratio = latest candle TR / rolling ATR(14)
  const pairRatios = [];   // { pair, currency1, currency2, ratio }

  for (const { pair, candles } of pairCandleMap) {
    if (!candles || candles.length < SPIKE_ATR_PERIOD + 2) continue;

    // Rolling ATR over last SPIKE_ATR_PERIOD candles (excluding the very last)
    const baseline = candles.slice(-(SPIKE_ATR_PERIOD + 2), -1);
    let atrSum = 0;
    for (let i = 1; i < baseline.length; i++) {
      atrSum += trueRange(baseline[i], baseline[i - 1].close);
    }
    const rollingATR = atrSum / (baseline.length - 1);
    if (rollingATR === 0) continue;

    // Latest completed candle
    const latest   = candles[candles.length - 1];
    const prevClose = candles[candles.length - 2].close;
    const latestTR  = trueRange(latest, prevClose);
    const ratio     = latestTR / rollingATR;

    if (ratio < SPIKE_ATR_THRESHOLD) continue;  // not a spike — skip

    // Parse the two currencies from the pair name
    // Handles "EUR/USD", "GBP/USD OTC", "USD/JPY" etc.
    const cleanPair = pair.replace(/\s*OTC\s*/i, "").trim();
    const parts     = cleanPair.split("/");
    if (parts.length !== 2) continue;
    const [ccy1, ccy2] = parts.map((c) => c.trim().toUpperCase().slice(0, 3));

    pairRatios.push({ pair, ccy1, ccy2, ratio });
  }

  if (pairRatios.length === 0) return { triggered: false, events: [] };

  // ── Step 2: Group spiking pairs by currency ───────────────────────────────
  // A currency is "confirmed spiking" if it appears in ≥ SPIKE_MIN_PAIRS pairs
  const ccyCount = new Map();   // currency → [{ pair, ratio }]
  for (const pr of pairRatios) {
    for (const ccy of [pr.ccy1, pr.ccy2]) {
      if (!ccyCount.has(ccy)) ccyCount.set(ccy, []);
      ccyCount.get(ccy).push({ pair: pr.pair, ratio: pr.ratio });
    }
  }

  // ── Step 3: Fire blackout for confirmed currencies ─────────────────────────
  for (const [currency, spikingPairs] of ccyCount.entries()) {
    if (spikingPairs.length < SPIKE_MIN_PAIRS) continue;  // not enough corroboration

    // Enforce cooldown — don't re-fire the same currency repeatedly
    const lastFired = _spikeCooldowns.get(currency) ?? 0;
    if ((now - lastFired) < SPIKE_COOLDOWN_MS) {
      console.log(`[SpikeDetector] ${currency} spike detected but in cooldown (${Math.ceil((SPIKE_COOLDOWN_MS - (now - lastFired)) / 60000)}min left) — skipping`);
      continue;
    }

    const avgRatio   = spikingPairs.reduce((s, p) => s + p.ratio, 0) / spikingPairs.length;
    const pairNames  = spikingPairs.map((p) => p.pair).join(", ");
    const blackoutKey = `SPIKE_${currency}_${now}`;
    const reason      = `Unscheduled volatility spike — ${currency} ${avgRatio.toFixed(1)}x ATR across [${pairNames}]`;

    addDynamicBlackout(blackoutKey, SPIKE_BLACKOUT_MS, reason);
    _spikeCooldowns.set(currency, now);

    fired.push({ currency, pairs: spikingPairs.map((p) => p.pair), ratio: avgRatio, blackoutKey });
    console.warn(`[SpikeDetector] 🔴 SPIKE BLACKOUT fired: ${reason} — ${SPIKE_BLACKOUT_MS / 60000}min block`);
  }

  return { triggered: fired.length > 0, events: fired };
}
