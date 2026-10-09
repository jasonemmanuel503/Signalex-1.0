// GET /api/forecast  — current forecasts + daily outlook
// POST /api/forecast — on-demand run or toggle GLOBAL_RISK_MODE
import { NextResponse } from "next/server";
import {
  getAllCachedForecasts, forecastAll, getLastFullRunAge,
  getDailyOutlook, getGlobalRiskMode, setGlobalRiskMode,
} from "../../../lib/marketForecast.js";

export async function GET() {
  try {
    const forecasts    = getAllCachedForecasts();
    const dailyOutlook = getDailyOutlook();
    const ageMs        = getLastFullRunAge();
    return NextResponse.json({
      ok:                 true,
      global_risk_mode:   getGlobalRiskMode(),
      last_run_age_secs:  ageMs !== null ? Math.round(ageMs / 1000) : null,
      forecasts,
      daily_outlook:      dailyOutlook,
      count:              Object.keys(forecasts).length,
      timestamp:          new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    if (typeof body.globalRiskMode === "boolean") {
      setGlobalRiskMode(body.globalRiskMode);
      return NextResponse.json({ ok: true, global_risk_mode: body.globalRiskMode });
    }
    const backendUrl = process.env.PYTHON_BACKEND_URL || "http://127.0.0.1:8001";
    const internalToken = process.env.INTERNAL_API_TOKEN || "dev_internal_token_signalex_2026";
    const res = await fetch(`${backendUrl}/prices`, {
      headers: { "X-Internal-Token": internalToken },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return NextResponse.json({ ok: false, error: "Backend unavailable" }, { status: 503 });
    const data    = await res.json();
    const pairs   = (data.pairs || []).map((p) => ({ pair: p.pair, candles: p.candles || [] }));
    const results = await forecastAll(pairs);
    return NextResponse.json({
      ok:            true,
      forecasts:     Object.fromEntries(results),
      daily_outlook: getDailyOutlook(),
      ran_pairs:     pairs.length,
      timestamp:     new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
