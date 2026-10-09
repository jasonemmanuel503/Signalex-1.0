import { NextResponse } from "next/server";
import { orchestrator } from "../../../lib/trading/orchestrator.js";
import { updateAppSettings, getAppSettings, writeAuditLog } from "../../../lib/store/index.js";

const PO_GATEWAY_URL = process.env.PO_GATEWAY_URL || "http://127.0.0.1:8002";
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN || "dev_internal_token_signalex_2026";

export async function GET(req) {
  try {
    const state = orchestrator.getState();

    // Check PO Gateway health
    let gateway = { connected: false, session: "unknown" };
    try {
      const res = await fetch(`${PO_GATEWAY_URL}/health`, {
        headers: { "X-Internal-Token": INTERNAL_API_TOKEN },
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) gateway = await res.json();
    } catch {
      gateway = { connected: false, session: "unreachable" };
    }

    return NextResponse.json({
      ok: true,
      ...state,
      gateway,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { action } = body;
    const ip = req.headers.get("x-forwarded-for") || "127.0.0.1";
    const userAgent = req.headers.get("user-agent") || "unknown";
    const meta = { ip, userAgent };

    switch (action) {
      case "set_mode": {
        const { mode } = body;
        const res = await orchestrator.setMode(mode, "user", meta);
        return NextResponse.json({ ok: true, state: res });
      }

      case "set_account": {
        const { account } = body;
        const res = await orchestrator.setAccount(account, "user", meta);
        return NextResponse.json({ ok: true, state: res });
      }

      case "kill": {
        const { reason } = body;
        const res = await orchestrator.triggerKill("user", reason || "Manual kill switch from UI", meta);
        return NextResponse.json({ ok: true, state: res });
      }

      case "resume": {
        const res = await orchestrator.resumeTrading("user", meta);
        return NextResponse.json({ ok: true, state: res });
      }

      case "update_settings": {
        const { settings } = body;
        if (!settings) throw new Error("Missing settings object");
        const updated = updateAppSettings(settings);
        writeAuditLog("user", "settings_change", { settings, ...meta });
        return NextResponse.json({ ok: true, settings: updated });
      }

      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
