export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { orchestrator } from "../../../lib/trading/orchestrator.js";
import { updateAppSettings, getAppSettings, writeAuditLog, getTradeHistory } from "../../../lib/store/index.js";

const PO_GATEWAY_URL = process.env.PO_GATEWAY_URL || "http://127.0.0.1:8002";
const PYTHON_BACKEND_URL = process.env.PYTHON_BACKEND_URL || "http://127.0.0.1:8001";
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN || "dev_internal_token_signalex_2026";

export async function GET(req) {
  try {
    const state = orchestrator.getState();

    // Check PO Gateway health & balance
    let gateway = { connected: false, session: "unknown", last_message_age_secs: null };
    let balance = { demo: null, real: null, current: null };
    try {
      const res = await fetch(`${PO_GATEWAY_URL}/health`, {
        headers: { "X-Internal-Token": INTERNAL_API_TOKEN },
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        gateway = await res.json();
      }
    } catch {
      gateway = { connected: false, session: "unreachable", last_message_age_secs: null };
    }

    if (gateway.connected && gateway.session === "valid") {
      if (gateway.balance != null && Number.isFinite(Number(gateway.balance)) && (state.account || "demo") === "demo") {
        balance.demo = Number(gateway.balance);
        balance.current = balance.demo;
      } else {
        try {
          const balRes = await fetch(`${PO_GATEWAY_URL}/balance?account=${state.account || "demo"}`, {
            headers: { "X-Internal-Token": INTERNAL_API_TOKEN },
            signal: AbortSignal.timeout(2000),
          });
          if (balRes.ok) {
            const balData = await balRes.json();
            if (balData.balance != null && Number.isFinite(Number(balData.balance))) {
              const numBal = Number(balData.balance);
              balance.current = numBal;
              if (state.account === "real") {
                balance.real = numBal;
              } else {
                balance.demo = numBal;
              }
            }
          }
        } catch {
          // Leave null
        }
      }
    }

    // Check Deriv / python-backend health
    let deriv = { connected: false, status: "unknown" };
    try {
      const derivRes = await fetch(`${PYTHON_BACKEND_URL}/health`, {
        headers: { "X-Internal-Token": INTERNAL_API_TOKEN },
        signal: AbortSignal.timeout(2000),
      });
      if (derivRes.ok) {
        const dData = await derivRes.json();
        deriv = { connected: true, status: dData.status || "ok" };
      }
    } catch {
      deriv = { connected: false, status: "unreachable" };
    }

    // Compute today's performance metrics
    const todayStr = new Date().toISOString().slice(0, 10);
    const allTrades = getTradeHistory(200);
    const todayTrades = allTrades.filter(
      (t) => (t.account === state.account || !state.account) && (t.sent_at || "").startsWith(todayStr)
    );
    let todayProfit = 0;
    let todayWins = 0;
    let todayLosses = 0;
    for (const t of todayTrades) {
      if (t.result === "WIN") {
        todayWins++;
        todayProfit += Number(t.profit || 0);
      } else if (t.result === "LOSS") {
        todayLosses++;
        todayProfit += Number(t.profit || 0);
      }
    }

    const currentLossStreak =
      state.consecutive_losses?.[state.account || "demo"] ??
      orchestrator.recalcLossStreak(state.account || "demo");

    return NextResponse.json({
      ok: true,
      ...state,
      gateway,
      deriv,
      balance,
      loss_streak: currentLossStreak,
      today: {
        tradesCount: todayTrades.length,
        maxTrades: state.settings?.max_trades_per_day || 30,
        netProfit: Number(todayProfit.toFixed(2)),
        wins: todayWins,
        losses: todayLosses,
      },
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
        const { account, confirm } = body;
        if (account === "real") {
          if (confirm !== "REAL") {
            return NextResponse.json(
              { error: 'Switching to REAL account requires confirmation confirm: "REAL"' },
              { status: 400 }
            );
          }
          try {
            const hRes = await fetch(`${PO_GATEWAY_URL}/health`, {
              headers: { "X-Internal-Token": INTERNAL_API_TOKEN },
              signal: AbortSignal.timeout(3000),
            });
            if (!hRes.ok) {
              return NextResponse.json(
                { error: "Cannot switch to REAL account: Gateway health check failed" },
                { status: 400 }
              );
            }
            const hData = await hRes.json();
            const realAcc = hData?.accounts?.real;
            if (!realAcc || realAcc.connected !== true || realAcc.session !== "valid") {
              const reason = realAcc?.status === "not_configured"
                ? "Real credentials are not configured"
                : `Real connection status is ${realAcc?.status || "disconnected"}, session: ${realAcc?.session || "invalid"}`;
              return NextResponse.json(
                { error: `Cannot switch to REAL account: ${reason}` },
                { status: 400 }
              );
            }
          } catch (e) {
            return NextResponse.json(
              { error: `Cannot switch to REAL account: Gateway unreachable (${e.message})` },
              { status: 400 }
            );
          }
        }
        const res = await orchestrator.setAccount(account, "user", { ...meta, confirm });
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
