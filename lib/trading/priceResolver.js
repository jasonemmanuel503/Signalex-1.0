// ═══════════════════════════════════════════════════════════════════════════════
// SIGNALEX V10 — Price Source Resolver & Asset Metadata
// Rule: Signals must be computed on the same price series the trade settles on.
// - OTC pairs: Pocket Option candles only. Zero fallback to forex twin.
// - Forex pairs: Pocket Option candles primary, Deriv as cross-check.
// - Zero synthetic price fallbacks anywhere.
// ═══════════════════════════════════════════════════════════════════════════════

const PO_GATEWAY_URL = process.env.PO_GATEWAY_URL || "http://127.0.0.1:8002";
const PYTHON_BACKEND_URL = process.env.PYTHON_BACKEND_URL || "http://127.0.0.1:8001";
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN || "dev_internal_token_signalex_2026";

const CROSS_CHECK_MAX_DIFF_PCT = 0.25; // 0.25% max divergence allowed between PO and Deriv forex

/**
 * Calculates honest break-even win-rate percentage for a given payout.
 * Formula: 100 / (100 + payout_pct) * 100
 * Example: 85% payout -> 100 / 185 = 54.05%
 */
export function calcBreakEven(payout_pct) {
  const p = Number(payout_pct);
  if (!Number.isFinite(p) || p <= 0) return 100.0;
  return Number(((100 / (100 + p)) * 100).toFixed(2));
}

/**
 * Normalizes pair names into Pocket Option asset and Deriv formats.
 * e.g., "EUR/USD OTC" -> { poAsset: "EURUSD_otc", isOtc: true, derivPair: "EUR/USD" }
 */
export function normalizePair(pairName) {
  const raw = String(pairName || "").trim();
  const isOtc = raw.toLowerCase().includes("otc") || raw.endsWith("_otc");

  let base = raw
    .replace(/_otc/gi, "")
    .replace(/\s*OTC\s*/gi, "")
    .replace(/[^a-zA-Z]/g, "")
    .toUpperCase()
    .trim();

  const poAsset = isOtc ? `${base}_otc` : base;

  // Deriv format: "EUR/USD"
  let derivPair = base;
  if (base.length === 6) {
    derivPair = `${base.slice(0, 3)}/${base.slice(3)}`;
  }

  return { raw, base, poAsset, derivPair, isOtc };
}

/**
 * Fetches all available assets and real payouts from Pocket Option Gateway.
 */
export async function getAssetsFromGateway() {
  try {
    const res = await fetch(`${PO_GATEWAY_URL}/assets`, {
      headers: { "X-Internal-Token": INTERNAL_API_TOKEN },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`PO Gateway returned ${res.status}`);
    const assets = await res.json();
    const map = new Map();
    for (const a of assets) {
      map.set(a.pair, {
        ...a,
        break_even: calcBreakEven(a.payout_pct),
      });
    }
    return map;
  } catch (err) {
    console.warn("[PriceResolver] getAssetsFromGateway error:", err.message);
    return new Map();
  }
}

/**
 * Resolves closed 1-minute candles for a pair.
 * Strictly adheres to rule: signals compute on the price series the trade settles on.
 */
export async function getCandles(pair, n = 100) {
  const { poAsset, derivPair, isOtc } = normalizePair(pair);

  // 1. OTC PAIRS: Pocket Option candles ONLY. Never fall back to forex twin.
  if (isOtc) {
    try {
      const res = await fetch(`${PO_GATEWAY_URL}/candles/${encodeURIComponent(poAsset)}?n=${n}`, {
        headers: { "X-Internal-Token": INTERNAL_API_TOKEN },
        signal: AbortSignal.timeout(6000),
      });

      if (!res.ok) throw new Error(`PO Gateway returned ${res.status}`);
      const candles = await res.json();

      if (!Array.isArray(candles) || candles.length === 0) {
        return {
          source: "po_otc",
          candles: [],
          ageSeconds: 999999,
          stale: true,
          error: "No OTC candles returned by Pocket Option gateway",
        };
      }

      const latestTs = candles[candles.length - 1].timestamp;
      const nowSec = Math.floor(Date.now() / 1000);
      const ageSeconds = Math.max(0, nowSec - (latestTs + 60));

      return {
        source: "po_otc",
        candles,
        ageSeconds,
        stale: ageSeconds > 180,
      };
    } catch (err) {
      console.warn(`[PriceResolver] OTC candles fetch failed for ${pair}:`, err.message);
      return {
        source: "po_otc",
        candles: [],
        ageSeconds: 999999,
        stale: true,
        error: err.message,
      };
    }
  }

  // 2. FOREX PAIRS: Pocket Option primary, Deriv cross-check
  let poCandles = [];
  let poAge = 999999;
  let derivCandles = [];
  let derivAge = 999999;

  // Fetch PO candles
  try {
    const res = await fetch(`${PO_GATEWAY_URL}/candles/${encodeURIComponent(poAsset)}?n=${n}`, {
      headers: { "X-Internal-Token": INTERNAL_API_TOKEN },
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok) {
      poCandles = await res.json();
      if (poCandles.length > 0) {
        const latestTs = poCandles[poCandles.length - 1].timestamp;
        poAge = Math.max(0, Math.floor(Date.now() / 1000) - (latestTs + 60));
      }
    }
  } catch (err) {
    console.debug(`[PriceResolver] PO forex candles unavailable for ${poAsset}:`, err.message);
  }

  // Fetch Deriv candles
  try {
    const res = await fetch(`${PYTHON_BACKEND_URL}/candles/${encodeURIComponent(derivPair)}?n=${n}`, {
      headers: { "X-Internal-Token": INTERNAL_API_TOKEN },
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok) {
      const data = await res.json();
      derivCandles = data.candles || [];
      if (derivCandles.length > 0) {
        const latestTs = derivCandles[derivCandles.length - 1].timestamp;
        derivAge = Math.max(0, Math.floor(Date.now() / 1000) - (latestTs + 60));
      }
    }
  } catch (err) {
    console.debug(`[PriceResolver] Deriv forex candles unavailable for ${derivPair}:`, err.message);
  }

  // Cross-check when both feeds are present
  if (poCandles.length > 0 && derivCandles.length > 0) {
    const poClose = poCandles[poCandles.length - 1].close;
    const derivClose = derivCandles[derivCandles.length - 1].close;
    const diffPct = Math.abs(poClose - derivClose) / derivClose * 100;

    if (diffPct > CROSS_CHECK_MAX_DIFF_PCT) {
      console.warn(
        `[PriceResolver] Cross-check divergence on ${pair}: PO=${poClose} vs Deriv=${derivClose} (diff: ${diffPct.toFixed(3)}% > ${CROSS_CHECK_MAX_DIFF_PCT}%)`
      );
      return {
        source: "po_forex",
        candles: poCandles,
        ageSeconds: poAge,
        stale: poAge > 180,
        crossCheckFailed: true,
        divergencePct: diffPct,
      };
    }
  }

  // Prefer Pocket Option candles as primary since orders settle on Pocket Option
  if (poCandles.length >= 30 && poAge <= 180) {
    return {
      source: "po_forex",
      candles: poCandles,
      ageSeconds: poAge,
      stale: false,
      crossCheckFailed: false,
    };
  }

  // Fallback to Deriv for historical backfill if PO has not collected enough closed candles yet
  if (derivCandles.length > 0) {
    return {
      source: "deriv",
      candles: derivCandles,
      ageSeconds: derivAge,
      stale: derivAge > 180,
      crossCheckFailed: false,
    };
  }

  return {
    source: "none",
    candles: [],
    ageSeconds: 999999,
    stale: true,
    error: "No candle data from PO or Deriv",
  };
}

/**
 * Resolves all active market pairs for the analyze route.
 * Replaces fetchRealPrices and completely removes synthetic generators.
 */
export async function resolveAllMarketData(minPayoutPct = 80) {
  const assetsMap = await getAssetsFromGateway();
  const pairsList = [];

  // 1. Gather Pocket Option assets (both OTC and Forex)
  for (const [assetKey, meta] of assetsMap.entries()) {
    if (!meta.open) continue; // Skip assets marked closed by broker
    if (meta.payout_pct < minPayoutPct) continue; // Payout floor

    const candleRes = await getCandles(assetKey, 120);
    if (!candleRes.candles || candleRes.candles.length < 30 || candleRes.stale || candleRes.crossCheckFailed) {
      continue;
    }

    pairsList.push({
      pair: meta.is_otc ? `${meta.pair.replace("_otc", "").toUpperCase()} OTC` : meta.pair,
      symbol: meta.pair,
      market: meta.is_otc ? "otc" : "forex",
      source: candleRes.source,
      payout_pct: meta.payout_pct,
      break_even: meta.break_even,
      open: meta.open,
      prices: candleRes.candles,
      candles: candleRes.candles,
      candleCount: candleRes.candles.length,
      lastPrice: candleRes.candles[candleRes.candles.length - 1].close,
      ageSeconds: candleRes.ageSeconds,
      stale: candleRes.stale,
    });
  }

  // 2. If PO gateway has no forex pairs open, check Deriv forex pairs
  if (!pairsList.some((p) => p.market === "forex")) {
    try {
      const res = await fetch(`${PYTHON_BACKEND_URL}/prices`, {
        headers: { "X-Internal-Token": INTERNAL_API_TOKEN },
        signal: AbortSignal.timeout(6000),
      });
      if (res.ok) {
        const data = await res.json();
        for (const p of data.pairs || []) {
          if (p.candles && p.candles.length >= 30 && !p.stale) {
            pairsList.push({
              pair: p.pair,
              symbol: p.symbol || p.pair,
              market: "forex",
              source: "deriv",
              payout_pct: 85,
              break_even: calcBreakEven(85),
              open: p.marketOpen ?? true,
              prices: p.candles,
              candles: p.candles,
              candleCount: p.candles.length,
              lastPrice: p.lastPrice,
              ageSeconds: p.ageSeconds || 0,
              stale: Boolean(p.stale),
            });
          }
        }
      }
    } catch (err) {
      console.debug("[PriceResolver] Deriv fallback prices check:", err.message);
    }
  }

  return {
    pairs: pairsList,
    source: pairsList.length > 0 ? "live_market_data" : "empty",
    count: pairsList.length,
  };
}
