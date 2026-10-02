// GET /api/debug/session-pairs — scheduler diagnostics (P1)
import { NextResponse } from "next/server";
import {
  schedulerState, getPreSelectedPairs, getPreSessionHistory,
  getCurrentSessionKey, getNextTriggers, SESSION_DEFS,
} from "../../../../lib/preSessionScheduler.js";

export async function GET() {
  try {
    const currentSession = getCurrentSessionKey();
    const sessionStatus  = SESSION_DEFS.map((def) => {
      const pre = getPreSelectedPairs(def.key);
      return {
        key:           def.key,
        start:         `${String(def.startHour).padStart(2,"0")}:${String(def.startMin).padStart(2,"0")} UTC`,
        end:           `${String(def.endHour).padStart(2,"0")}:00 UTC`,
        prescan_done:  pre !== null,
        selected_pairs: pre?.selectedPairs ?? [],
        backup_pairs:   pre?.backupPairs   ?? [],
        triggered_at:  pre?.triggeredAt    ?? null,
        trigger_type:  pre?.triggerType    ?? null,
      };
    });

    return NextResponse.json({
      ok:               true,
      scheduler_running: schedulerState.running,
      current_session:  currentSession ?? "OFF_HOURS",
      next_triggers:    getNextTriggers(),
      last_prescan:     schedulerState.lastPreScan,
      session_status:   sessionStatus,
      history:          getPreSessionHistory(5),
      debug_note: [
        "P1 DIAGNOSIS:",
        "1. scheduler_running must be true — if false, call /api/pre-session GET to self-start",
        "2. prescan_done should be true for sessions that have started today",
        "3. If prescan_done=false and session is active → pairs fell back to real-time scoring",
        "4. history shows last 5 pre-scans with trigger timestamps",
      ].join(" | "),
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
