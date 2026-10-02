// GET /api/stats — persistent performance statistics (P3)
import { NextResponse } from "next/server";
import { getStats, getWinRateByTier, loadSessionHistory } from "../../../lib/db.js";

export async function GET() {
  try {
    const stats      = getStats();
    const byTier     = getWinRateByTier();
    const sessions   = loadSessionHistory(20);
    return NextResponse.json({
      ok: true,
      overall: {
        total_trades: stats.total,
        wins:         stats.wins,
        losses:       stats.losses,
        accuracy:     stats.accuracy ?? 0,
      },
      by_session: stats.bySession,
      by_pair:    stats.byPair,
      by_tier:    byTier,
      recent_sessions: sessions.map((s) => ({
        session:    s.sessionKey,
        startedAt:  s.startedAt,
        wins:       s.wins,
        losses:     s.losses,
        total:      s.total,
        winRate:    s.winRate,
      })),
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
