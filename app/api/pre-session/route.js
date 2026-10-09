export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import {
  schedulerState,
  getNextTriggers,
  getCurrentSessionKey,
  getPreSelectedPairs,
  getPreSessionHistory,
  forcePreScan,
  startScheduler,
  SESSION_DEFS,
} from "../../../lib/preSessionScheduler.js";

// Ensure scheduler is running (self-starts on first API hit)
startScheduler();

// ─── GET /api/pre-session — returns current scheduler state + upcoming triggers ─

export async function GET(request) {
  const { searchParams } = new URL(request.url);

  // ?history=1 → return last N pre-scan records
  if (searchParams.get("history") === "1") {
    const history = getPreSessionHistory(10);
    return NextResponse.json({ ok: true, history });
  }

  const currentSession = getCurrentSessionKey();
  const nextTriggers   = getNextTriggers();
  const preSelected    = currentSession ? getPreSelectedPairs(currentSession) : null;

  // Build session status for all three sessions
  const sessionStatus = SESSION_DEFS.map((def) => {
    const pre = getPreSelectedPairs(def.key);
    const preScanMin   = (def.startHour * 60 + def.startMin) - def.preScanMin;
    const triggerHour  = Math.floor(preScanMin / 60);
    const triggerMin   = preScanMin % 60;
    return {
      key:          def.key,
      startTime:    `${String(def.startHour).padStart(2,"0")}:${String(def.startMin).padStart(2,"0")}`,
      endTime:      `${String(def.endHour).padStart(2,"0")}:00`,
      preScanTime:  `${String(triggerHour).padStart(2,"0")}:${String(triggerMin).padStart(2,"0")}`,
      preScanDone:  pre !== null,
      selectedPairs: pre?.selectedPairs ?? [],
      backupPairs:   pre?.backupPairs   ?? [],
      triggeredAt:   pre?.triggeredAt   ?? null,
      triggerType:   pre?.triggerType   ?? null,
    };
  });

  return NextResponse.json({
    ok:              true,
    schedulerRunning: schedulerState.running,
    currentSession,
    preSelectedPairs: preSelected?.selectedPairs ?? null,
    backupPairs:      preSelected?.backupPairs   ?? null,
    nextTriggers,
    lastPreScan:      schedulerState.lastPreScan,
    sessionStatus,
    timestamp:        new Date().toISOString(),
  });
}

// ─── POST /api/pre-session — manual override ──────────────────────────────────

export async function POST(request) {
  try {
    const body       = await request.json().catch(() => ({}));
    const sessionKey = body.sessionKey || getCurrentSessionKey();

    if (!sessionKey) {
      return NextResponse.json({
        ok:     false,
        error:  "No active session and no sessionKey specified",
        hint:   "Pass { sessionKey: 'LONDON' | 'NEWYORK' | 'EVENING' } in the request body",
      }, { status: 400 });
    }

    const validKeys = SESSION_DEFS.map((d) => d.key);
    if (!validKeys.includes(sessionKey)) {
      return NextResponse.json({
        ok:    false,
        error: `Invalid sessionKey: ${sessionKey}. Valid: ${validKeys.join(", ")}`,
      }, { status: 400 });
    }

    console.log(`[preSession API] Manual override triggered for ${sessionKey}`);
    const result = await forcePreScan(sessionKey);

    return NextResponse.json({
      ok:        result.ok,
      sessionKey,
      result,
      timestamp: new Date().toISOString(),
      ...(result.ok
        ? { selectedPairs: result.selectedPairs, backupPairs: result.backupPairs }
        : { error: result.reason }
      ),
    });

  } catch (err) {
    console.error("[preSession API] POST error:", err);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
