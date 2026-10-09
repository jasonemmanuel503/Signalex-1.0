import { NextResponse } from "next/server";

// ═══════════════════════════════════════════════════════════════════════════════
// SIGNALEX V7.0.5 — BACKEND HEALTH MONITOR
// app/api/health-monitor/route.js
//
// Proactively monitors the Python backend every 60 seconds.
// Sends Telegram alerts when backend goes OFFLINE and when it comes back ONLINE.
// The dashboard polls GET /api/health-monitor every 30s to show status.
// ═══════════════════════════════════════════════════════════════════════════════

const PYTHON_BACKEND  = process.env.PYTHON_BACKEND_URL || "http://127.0.0.1:8001";
const CHECK_INTERVAL  = 60_000;  // 60 seconds
const ALERT_COOLDOWN  = 5 * 60_000;  // Don't re-alert for 5 minutes after an alert

// ─── Module-level monitor state (guarded with globalThis) ───────────────────────

if (!globalThis.__signalex_health_monitor) {
  globalThis.__signalex_health_monitor = {
    running: false,
    interval: null,
    wasOnline: null,
    lastAlertAt: 0,
    consecutiveFails: 0,
    lastCheckAt: null,
    lastStatus: "unknown",
    downtimeStart: null,
  };
}
const _state = globalThis.__signalex_health_monitor;
let _monitorRunning  = _state.running;
let _monitorInterval = _state.interval;
let _wasOnline       = _state.wasOnline;
let _lastAlertAt     = _state.lastAlertAt;
let _consecutiveFails = _state.consecutiveFails;
let _lastCheckAt     = _state.lastCheckAt;
let _lastStatus      = _state.lastStatus;
let _downtimeStart   = _state.downtimeStart;
let _checkCount      = 0;

// ─── Telegram sender ──────────────────────────────────────────────────────────

async function sendTelegramAlert(html) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId || token === "your-bot-token-here") return;

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id:    chatId,
        text:       html,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
  } catch (err) {
    console.error("[healthMonitor] Telegram error:", err.message);
  }
}

// ─── Health check ─────────────────────────────────────────────────────────────

async function checkBackend() {
  _checkCount++;
  _lastCheckAt = new Date().toISOString();

  let isOnline = false;
  let details  = {};

  try {
    const internalToken = process.env.INTERNAL_API_TOKEN || "dev_internal_token_signalex_2026";
    const res = await fetch(`${PYTHON_BACKEND}/health`, {
      headers: { "X-Internal-Token": internalToken },
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) {
      isOnline = true;
      try { details = await res.json(); } catch {}
      _consecutiveFails = 0;
    } else {
      _consecutiveFails++;
    }
  } catch {
    _consecutiveFails++;
  }

  const now = Date.now();
  _lastStatus = isOnline ? "online" : "offline";

  // Transition: online → offline
  if (_wasOnline === true && !isOnline) {
    _downtimeStart = now;
    console.warn("[healthMonitor] 🔴 Backend OFFLINE detected");
    if (now - _lastAlertAt > ALERT_COOLDOWN) {
      _lastAlertAt = now;
      const time = new Date().toLocaleTimeString("en-US", { hour12: false });
      await sendTelegramAlert([
        `🔴 <b>SIGNALEX BACKEND OFFLINE</b>`,
        `━━━━━━━━━━━━━━━━━━━━━━`,
        `⏰ Time: <code>${time} GMT+1</code>`,
        `🖥 Backend: <code>${PYTHON_BACKEND}</code>`,
        ``,
        `<b>⚠️ Signal generation is suspended.</b>`,
        `Market data cannot be fetched.`,
        ``,
        `<b>To fix:</b>`,
        `  1. Check if Python backend is running`,
        `  2. Run: <code>pm2 restart signalex-backend</code>`,
        `  3. Or: <code>cd python-backend && python main.py</code>`,
        `━━━━━━━━━━━━━━━━━━━━━━`,
        `🤖 <i>SIGNALEX Auto Monitor</i>`,
      ].join("\n"));
    }
  }

  // Transition: offline → online
  if (_wasOnline === false && isOnline) {
    const downtimeSecs = _downtimeStart ? Math.round((now - _downtimeStart) / 1000) : 0;
    const downtimeStr  = downtimeSecs > 60
      ? `${Math.floor(downtimeSecs / 60)}m ${downtimeSecs % 60}s`
      : `${downtimeSecs}s`;

    console.log("[healthMonitor] 🟢 Backend ONLINE — recovered");
    _downtimeStart = null;

    if (now - _lastAlertAt > 5000) {  // Small debounce
      _lastAlertAt = now;
      const time = new Date().toLocaleTimeString("en-US", { hour12: false });
      await sendTelegramAlert([
        `🟢 <b>SIGNALEX BACKEND ONLINE</b>`,
        `━━━━━━━━━━━━━━━━━━━━━━`,
        `⏰ Recovered at: <code>${time} GMT+1</code>`,
        `⏱ Downtime: <code>${downtimeStr}</code>`,
        `📡 Source: <code>${details.primary_source ?? "unknown"}</code>`,
        ``,
        `<b>✅ Signal generation resumed.</b>`,
        `━━━━━━━━━━━━━━━━━━━━━━`,
        `🤖 <i>SIGNALEX Auto Monitor</i>`,
      ].join("\n"));
    }
  }

  _wasOnline = isOnline;
  return { isOnline, details };
}

// ─── Start monitor (self-starting, idempotent) ────────────────────────────────

export function startHealthMonitor() {
  if (_monitorRunning) return;
  _monitorRunning = true;

  // First check immediately
  checkBackend().catch(() => {});

  _monitorInterval = setInterval(() => {
    checkBackend().catch((err) => console.error("[healthMonitor] Check error:", err.message));
  }, CHECK_INTERVAL);

  console.log("[healthMonitor] ✅ Started — checking backend every 60s");
}

// Start immediately on module load
startHealthMonitor();

// ─── GET /api/health-monitor — dashboard polls this ──────────────────────────

export async function GET() {
  // Run a check right now if we've never checked
  if (_wasOnline === null) {
    await checkBackend().catch(() => {});
  }

  return NextResponse.json({
    ok:               true,
    backendStatus:    _lastStatus,
    backendOnline:    _wasOnline,
    consecutiveFails: _consecutiveFails,
    lastCheckAt:      _lastCheckAt,
    checkCount:       _checkCount,
    downtimeStart:    _downtimeStart ? new Date(_downtimeStart).toISOString() : null,
    backendUrl:       PYTHON_BACKEND,
    monitorRunning:   _monitorRunning,
    timestamp:        new Date().toISOString(),
  });
}
