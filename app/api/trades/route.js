import { NextResponse } from "next/server";
import { getTradeHistory, getStats, getWinRateByTier } from "../../../lib/store/index.js";
import { orchestrator } from "../../../lib/trading/orchestrator.js";

export async function GET(req) {
  try {
    const url = new URL(req.url);
    const limit = parseInt(url.searchParams.get("limit") || "100", 10);
    const account = url.searchParams.get("account");

    let trades = getTradeHistory(limit);
    if (account) {
      trades = trades.filter((t) => t.account === account);
    }

    return NextResponse.json({
      ok: true,
      trades,
      stats: getStats(),
      winRateByTier: getWinRateByTier(),
      count: trades.length,
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { signal } = body;
    if (!signal) {
      return NextResponse.json({ error: "Missing signal object" }, { status: 400 });
    }

    const result = await orchestrator.dispatchOrder(signal, "manual", true);
    return NextResponse.json({ ok: result.success, ...result });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
