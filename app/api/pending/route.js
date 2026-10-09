import { NextResponse } from "next/server";
import { getPendingConfirmations } from "../../../lib/store/index.js";
import { orchestrator } from "../../../lib/trading/orchestrator.js";

export async function GET() {
  try {
    const pending = getPendingConfirmations("pending");
    return NextResponse.json({ ok: true, pending });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const { action, id } = await req.json();

    if (!id) {
      return NextResponse.json({ error: "Missing confirmation id" }, { status: 400 });
    }

    if (action === "confirm") {
      const result = await orchestrator.confirmPendingTrade(id, "user");
      return NextResponse.json({ ok: result.success, ...result });
    } else if (action === "skip") {
      orchestrator.skipPendingTrade(id);
      return NextResponse.json({ ok: true, skipped: id });
    }

    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
