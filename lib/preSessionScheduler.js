// ═══════════════════════════════════════════════════════════════════════════════
// SIGNALEX V8.0 — PRE-SESSION SCHEDULER
// lib/preSessionScheduler.js
//
// PURPOSE:
//   Implements ChatGPT's "Scheduled Intelligence" concept:
//   Instead of the user clicking → system reacts,
//   the system PREPARES AUTOMATICALLY before each session starts.
//
// HOW IT WORKS:
//   ┌─────────────────────────────────────────────────────────────────┐
//   │ 08:45 GMT+1 → Pre-selection scan runs automatically            │
//   │ 08:45–09:00 → Pairs selected (6–8 best), ranked, stored in DB  │
//   │ 08:55 GMT+1 → Telegram: "📋 SESSION BRIEF" sent to VIP group  │
//   │ 09:00 GMT+1 → London session starts, signal engine runs        │
//   │               ONLY from the pre-selected pairs                 │
//   └─────────────────────────────────────────────────────────────────┘
//
// SESSIONS (GMT+1, Cameroon time):
//   ASIAN:    03:00–09:00  (pre-scan at 02:45)
//   LONDON:   09:00–13:00  (pre-scan at 08:45)
//   NEW YORK: 14:30–18:00  (pre-scan at 14:15)
//   EVENING:  20:00–23:00  (pre-scan at 19:45)
//
// FEATURES:
//   1. Automatic trigger — fires exactly 15 min before session start
//   2. Manual override  — POST /api/pre-session?force=1 bypasses timer
//   3. Timezone-safe   — always computes in GMT+1 (Africa/Douala / UTC+1)
//   4. Persistent      — pre-selected pairs stored in SQLite, survive restart
//   5. Telegram brief  — sends pair list + schedule to VIP group at T-10
//   6. Status endpoint — GET /api/pre-session returns current state + next trigger
//
// INTEGRATION:
//   analyze/route.js calls getPreSelectedPairs() which returns:
//   - The locked pair list if a pre-scan was done for this session
//   - null if no pre-scan → engine falls back to real-time scoring
// ═══════════════════════════════════════════════════════════════════════════════

import {
  savePreSessionRecord,
  loadPreSessionRecord,
  markPreSessionTelegramSent,
  getPreSessionHistoryRecords,
} from "./store/index.js";

// ─── Session definitions (GMT+1) ─────────────────────────────────────────────

export const SESSION_DEFS = [
  { key: "ASIAN",   startHour: 3,  startMin: 0,  endHour: 9,  endMin: 0,  preScanMin: 15 },  // 03:00–09:00 GMT+1
  { key: "LONDON",  startHour: 9,  startMin: 0,  endHour: 13, endMin: 0,  preScanMin: 15 },  // 09:00–13:00 GMT+1
  { key: "NEWYORK", startHour: 14, startMin: 30, endHour: 18, endMin: 0,  preScanMin: 15 },  // 14:30–18:00 GMT+1
  { key: "EVENING", startHour: 20, startMin: 0,  endHour: 23, endMin: 0,  preScanMin: 15 },  // 20:00–23:00 GMT+1
];

// ─── GMT+1 clock helpers ──────────────────────────────────────────────────────

function nowGMT1() {
  const now = new Date();
  // GMT+1 = UTC + 1 hour
  const utcMs    = now.getTime() + now.getTimezoneOffset() * 60000;
  const gmt1Date = new Date(utcMs + 3600000);
  return {
    hour:    gmt1Date.getHours(),
    minute:  gmt1Date.getMinutes(),
    second:  gmt1Date.getSeconds(),
    dateStr: gmt1Date.toISOString().slice(0, 10),  // "YYYY-MM-DD"
    totalMinutes: gmt1Date.getHours() * 60 + gmt1Date.getMinutes(),
    ts: gmt1Date,
  };
}

function sessionStartTotalMin(def) {
  return def.startHour * 60 + def.startMin;
}

function preScanTotalMin(def) {
  return sessionStartTotalMin(def) - def.preScanMin;
}

// ─── In-memory state ──────────────────────────────────────────────────────────

let _schedulerRunning  = false;
let _schedulerInterval = null;
let _lastCheck         = null;

// Exposed state — readable by the dashboard
export const schedulerState = {
  running:         false,
  nextTrigger:     null,   // { sessionKey, triggerAt: "HH:MM", sessionAt: "HH:MM" }
  lastPreScan:     null,   // { sessionKey, triggeredAt, pairs, triggerType }
  currentSession:  null,   // active session key or null
};

// ─── DB helpers ───────────────────────────────────────────────────────────────

function savePreSession(sessionKey, sessionDate, selectedPairs, backupPairs, scoresArr, triggerType, gmt1Hour, gmt1Min) {
  savePreSessionRecord({
    sessionKey,
    sessionDate,
    selectedPairs,
    backupPairs,
    scores: scoresArr,
    triggeredAt: new Date().toISOString(),
    triggerType,
    telegramSent: false,
    gmt1Hour,
    gmt1Minute: gmt1Min,
  });
}

function loadPreSession(sessionKey, sessionDate) {
  return loadPreSessionRecord(sessionKey, sessionDate);
}

export function markTelegramSent(sessionKey, sessionDate) {
  markPreSessionTelegramSent(sessionKey, sessionDate);
}

export function getPreSessionHistory(limit = 20) {
  return getPreSessionHistoryRecords(limit);
}

// ─── Core: get pre-selected pairs for a session (called by analyze/route.js) ──

/**
 * Returns the pre-selected pairs for today's session if a pre-scan was done.
 * Returns null if no pre-scan exists → engine falls back to real-time scoring.
 *
 * @param {string} sessionKey - "LONDON" | "NEWYORK" | "EVENING"
 * @returns {{ selectedPairs: string[], backupPairs: string[] } | null}
 */
export function getPreSelectedPairs(sessionKey) {
  const { dateStr } = nowGMT1();
  const record = loadPreSession(sessionKey, dateStr);
  if (!record) return null;
  if (record.selectedPairs.length === 0) return null;
  return {
    selectedPairs: record.selectedPairs,
    backupPairs:   record.backupPairs,
    triggeredAt:   record.triggeredAt,
    triggerType:   record.triggerType,
  };
}

/**
 * Store a completed pre-scan result.
 * Called by analyze/route.js after scoring all pairs.
 */
export function storePreScan(sessionKey, selectedPairs, backupPairs, scoresArr, triggerType = "auto") {
  const { dateStr, hour, minute } = nowGMT1();
  savePreSession(sessionKey, dateStr, selectedPairs, backupPairs, scoresArr, triggerType, hour, minute);
  schedulerState.lastPreScan = {
    sessionKey,
    triggeredAt: new Date().toISOString(),
    pairs: selectedPairs,
    triggerType,
  };
  console.log(`[preSession] Stored ${selectedPairs.length} pairs for ${sessionKey} | type: ${triggerType}`);
}

// ─── Compute next trigger times ───────────────────────────────────────────────

export function getNextTriggers() {
  const { totalMinutes, dateStr } = nowGMT1();
  const upcoming = [];

  for (const def of SESSION_DEFS) {
    const preScanMin  = preScanTotalMin(def);
    const sessionMin  = sessionStartTotalMin(def);
    const minutesAway = preScanMin - totalMinutes;

    // Check if today's pre-scan is still in the future
    if (minutesAway > 0) {
      const h = Math.floor(preScanMin / 60);
      const m = preScanMin % 60;
      const sh = def.startHour;
      const sm = def.startMin;
      upcoming.push({
        sessionKey:  def.key,
        triggerAt:   `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")} GMT+1`,
        sessionAt:   `${String(sh).padStart(2,"0")}:${String(sm).padStart(2,"0")} GMT+1`,
        minutesAway: Math.ceil(minutesAway),
        inSession:   totalMinutes >= sessionMin && totalMinutes < def.endHour * 60 + def.endMin,
      });
    }
  }

  return upcoming.sort((a, b) => a.minutesAway - b.minutesAway);
}

export function getCurrentSessionKey() {
  const { totalMinutes } = nowGMT1();
  for (const def of SESSION_DEFS) {
    const start = sessionStartTotalMin(def);
    const end   = def.endHour * 60 + def.endMin;
    if (totalMinutes >= start && totalMinutes < end) return def.key;
  }
  return null;
}

// ─── Telegram pre-session brief formatter ────────────────────────────────────

function formatPreSessionBrief(sessionKey, selectedPairs, backupPairs, scoresArr, sessionDef) {
  const sessionNames = { ASIAN: "🌏 ASIAN", LONDON: "🇬🇧 LONDON", NEWYORK: "🇺🇸 NEW YORK", EVENING: "🌙 EVENING" };
  const name         = sessionNames[sessionKey] || sessionKey;
  const startTime    = `${String(sessionDef.startHour).padStart(2,"0")}:${String(sessionDef.startMin).padStart(2,"0")} GMT+1`;
  const endTime      = `${String(sessionDef.endHour).padStart(2,"0")}:00 GMT+1`;
  const { dateStr }  = nowGMT1();

  const pairLines = selectedPairs.map((pair, i) => {
    const score = scoresArr.find((s) => s.pair === pair);
    const scoreStr = score ? ` <code>${score.score}/100</code>` : "";
    return `  ${i + 1}. <b>${pair}</b>${scoreStr}`;
  }).join("\n");

  const backupLines = backupPairs.length > 0
    ? `\n<i>🔁 Backup pairs: ${backupPairs.join(", ")}</i>`
    : "";

  return [
    `📋 <b>PRE-SESSION BRIEF — ${name}</b>`,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    `📅 Date: <code>${dateStr}</code>`,
    `🕐 Session: <b>${startTime} → ${endTime}</b>`,
    ``,
    `<b>✅ Selected Trading Pairs (${selectedPairs.length}):</b>`,
    pairLines,
    backupLines,
    ``,
    `<b>📌 Instructions:</b>`,
    `  • Open these pairs on Pocket Option / Quotex`,
    `  • Wait for signal alerts starting at <b>${startTime}</b>`,
    `  • Only trade pairs listed above this session`,
    `  • Risk max <b>1–2%</b> per trade`,
    ``,
    `⏰ <i>Session begins in ${sessionDef.preScanMin} minutes. Stay ready.</i>`,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    `🤖 <i>SIGNALEX V8.0 — Auto Pre-Session Scheduler</i>`,
  ].join("\n");
}

// ─── Send pre-session brief to Telegram ──────────────────────────────────────

async function sendPreSessionBrief(sessionKey, selectedPairs, backupPairs, scoresArr) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId || token === "your-bot-token-here") {
    console.log("[preSession] Telegram not configured — skipping brief");
    return false;
  }

  const def = SESSION_DEFS.find((d) => d.key === sessionKey);
  if (!def) return false;

  const html = formatPreSessionBrief(sessionKey, selectedPairs, backupPairs, scoresArr, def);

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id:                  chatId,
        text:                     html,
        parse_mode:               "HTML",
        disable_web_page_preview: true,
      }),
    });
    const data = await res.json();
    if (data.ok) {
      const { dateStr } = nowGMT1();
      markTelegramSent(sessionKey, dateStr);
      console.log(`[preSession] Brief sent to Telegram for ${sessionKey}`);
      return true;
    }
    console.warn("[preSession] Telegram send failed:", data.description);
    return false;
  } catch (err) {
    console.error("[preSession] Telegram error:", err.message);
    return false;
  }
}

// ─── Pre-scan trigger (called by scheduler OR manual override) ────────────────

/**
 * Triggers the pre-selection scan for a session.
 * Makes an internal call to the analyze route with prescan=1 to score pairs.
 */
export async function triggerPreScan(sessionKey, triggerType = "auto") {
  console.log(`[preSession] Triggering pre-scan for ${sessionKey} (${triggerType})`);
  try {
    // Fetch market data from Python backend
    const backendUrl  = process.env.PYTHON_BACKEND_URL || "http://127.0.0.1:8001";
    const internalToken = process.env.INTERNAL_API_TOKEN || "dev_internal_token_signalex_2026";
    const pricesRes   = await fetch(`${backendUrl}/prices`, {
      headers: { "X-Internal-Token": internalToken },
      signal: AbortSignal.timeout(20000),
    });

    if (!pricesRes.ok) {
      console.warn(`[preSession] Backend returned ${pricesRes.status} — pre-scan aborted`);
      return { ok: false, reason: "Backend unavailable" };
    }

    const pricesData = await pricesRes.json();
    const allPairs   = pricesData.pairs || [];

    if (allPairs.length === 0) {
      console.warn("[preSession] No pairs from backend — pre-scan aborted");
      return { ok: false, reason: "No price data" };
    }

    // Import scoring function from analyze route via internal API call
    // We call the API with a prescan flag to get pair scores without emitting a signal
    const scanRes = await fetch(
      `${process.env.NEXTAUTH_URL || "http://localhost:3000"}/api/analyze`,
      {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prescan: sessionKey }),
        signal:  AbortSignal.timeout(30000),
      }
    );

    if (!scanRes.ok) {
      console.warn(`[preSession] Internal scan returned ${scanRes.status}`);
      return { ok: false, reason: "Internal scan failed" };
    }

    const scanData = await scanRes.json();

    if (scanData.prescanResult) {
      const { selectedPairs, backupPairs, scores } = scanData.prescanResult;

      // Send Telegram brief (10 min before session — fire-and-forget)
      sendPreSessionBrief(sessionKey, selectedPairs, backupPairs, scores).catch(() => {});

      schedulerState.lastPreScan = {
        sessionKey, triggeredAt: new Date().toISOString(),
        pairs: selectedPairs, triggerType,
      };

      console.log(`[preSession] ✅ Pre-scan complete: ${selectedPairs.length} pairs selected for ${sessionKey}`);
      return { ok: true, selectedPairs, backupPairs, scores };
    }

    return { ok: false, reason: "No prescan result in response" };
  } catch (err) {
    console.error("[preSession] triggerPreScan error:", err.message);
    return { ok: false, reason: err.message };
  }
}

// ─── Background scheduler ─────────────────────────────────────────────────────

/**
 * Checks every 60 seconds whether a pre-scan should fire.
 * Fires when: currentTime is within the 1-minute window of preScanTime.
 * Only fires once per session per day (DB deduplication).
 */
async function schedulerTick() {
  const gmt1 = nowGMT1();
  _lastCheck = gmt1.ts.toISOString();

  // Update current session in state
  schedulerState.currentSession = getCurrentSessionKey();
  schedulerState.nextTrigger    = getNextTriggers()[0] || null;

  for (const def of SESSION_DEFS) {
    const preScanMin = preScanTotalMin(def);
    const nowMin     = gmt1.totalMinutes;

    // Fire window: within 1 minute of target pre-scan time
    if (Math.abs(nowMin - preScanMin) <= 1) {
      // Check if already done today
      const existing = loadPreSession(def.key, gmt1.dateStr);
      if (existing) {
        // Already ran today — skip
        continue;
      }

      console.log(`[preSession] ⏰ Auto-trigger firing for ${def.key} at ${gmt1.hour}:${gmt1.minute} GMT+1`);
      await triggerPreScan(def.key, "auto");
      break; // Only one per tick
    }
  }
}

/**
 * Start the background scheduler. Safe to call multiple times — idempotent.
 * Called from analyze/route.js on first request so it self-starts.
 */
export function startScheduler() {
  if (_schedulerRunning) return;
  _schedulerRunning         = true;
  schedulerState.running    = true;

  // Tick immediately, then every 60 seconds
  schedulerTick().catch((err) => console.error("[preSession] Tick error:", err.message));
  _schedulerInterval = setInterval(() => {
    schedulerTick().catch((err) => console.error("[preSession] Tick error:", err.message));
  }, 60_000);

  console.log("[preSession] ✅ Scheduler started — checking every 60s");
}

/**
 * Manual override: force a pre-scan for a specific session right now.
 * Used by the dashboard "Run Pre-Session Scan Now" button.
 */
export async function forcePreScan(sessionKey) {
  if (!sessionKey || !SESSION_DEFS.find((d) => d.key === sessionKey)) {
    return { ok: false, reason: `Unknown session: ${sessionKey}` };
  }
  return triggerPreScan(sessionKey, "manual");
}
