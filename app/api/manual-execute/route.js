// POST /api/manual-execute — promote SECONDARY signal to ACTIVE + mark result (P5)
import { NextResponse } from "next/server";
import { getSignalById, updateSignalStatus, updateSignalResult, saveSignal } from "../../../lib/db.js";

export async function POST(request) {
  try {
    const body   = await request.json().catch(() => ({}));
    const { id, action, result } = body;

    if (!id) return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });

    const signal = getSignalById(id);
    if (!signal) return NextResponse.json({ ok: false, error: `Signal ${id} not found` }, { status: 404 });

    if (signal.type !== "SECONDARY") {
      return NextResponse.json({
        ok: false,
        error: "Only SECONDARY signals can be manually executed",
      }, { status: 400 });
    }

    // action=execute → promote to ACTIVE
    if (action === "execute") {
      updateSignalStatus(id, "SENT", { executedAt: Date.now(), sentAt: Date.now() });
      console.log(`[manualExecute] SECONDARY signal ${id} (${signal.pair}) promoted to ACTIVE`);
      return NextResponse.json({
        ok: true,
        message: `Signal ${id} promoted to ACTIVE`,
        signal: { ...signal, status: "SENT", executed_at: Date.now() },
      });
    }

    // action=result → assign WIN or LOSS manually (no automatic interference)
    if (action === "result") {
      if (!result || !["WIN", "LOSS"].includes(result.toUpperCase())) {
        return NextResponse.json({ ok: false, error: "result must be WIN or LOSS" }, { status: 400 });
      }
      // Only mark result on this specific signal — never touches other signals
      updateSignalResult(id, result.toUpperCase());
      console.log(`[manualExecute] SECONDARY signal ${id} result=${result.toUpperCase()} — manual assignment`);
      return NextResponse.json({
        ok: true,
        message: `Signal ${id} result set to ${result.toUpperCase()}`,
        note: "This result is isolated — no other signals affected",
        signal: { ...signal, result: result.toUpperCase() },
      });
    }

    return NextResponse.json({ ok: false, error: "action must be 'execute' or 'result'" }, { status: 400 });

  } catch (err) {
    console.error("[manualExecute] Error:", err);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
