export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";

// ═══════════════════════════════════════════════════════════════════════════════
// SIGNALEX V10.0 — TELEGRAM DELIVERY LAYER
// V10.0: VIP group auto-dispatch — signals + results sent simultaneously
// ═══════════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════════
//
// V7.0 CHANGES (over V6.5):
//   [5]  COLORFUL HTML MESSAGES: Switched from plain text to Telegram HTML
//        parse_mode. BUY=green candle emoji+arrow, SELL=red candle emoji+arrow,
//        expiry=orange, strength=bold, confidence bar colored by level,
//        tier A/B/C colored, market phase emoji-coded.
//   [5]  DISTINCT VISUAL SECTIONS: Each signal block has clear visual hierarchy
//        using bold headers, code blocks for key numbers, emoji color coding.
//   [*]  All timing/lock logic preserved from V6.5 (Tasks 1–7).
//   [*]  parse_mode: "HTML" added to all sendMessage calls.
//        Telegram HTML supports: <b>, <i>, <code>, <pre>, <a href>
//        Does NOT support color tags — we use emoji as color proxies.
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Module-level single-trade lock ───────────────────────────────────────────
let activeTradeExpiresAt = 0;

// ─── Timing constants ─────────────────────────────────────────────────────────
const BUFFER_BY_TIER = {
  HIGH:        15,
  MEDIUM:      25,
  LOW:         35,
  LOW_EVENING: 35,
  DEFAULT:     25,
};
const MIN_DELAY_MS    = 10_000;
const FAILSAFE_MS     = 60_000;
const COOLDOWN_MS     = 2_000;

// ═══════════════════════════════════════════════════════════════════════════════
// HTML ESCAPE — required for Telegram HTML parse_mode
// ═══════════════════════════════════════════════════════════════════════════════

function esc(str) {
  return String(str ?? "—")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ═══════════════════════════════════════════════════════════════════════════════
// COLOR HELPERS — emoji as color proxies (Telegram HTML has no color tags)
// ═══════════════════════════════════════════════════════════════════════════════

/** BUY → green candle + up arrow  |  SELL → red candle + down arrow */
function directionBlock(direction) {
  const isBuy = direction === "BUY";
  return isBuy
    ? "🟢🕯 <b>BUY</b>  ▲"
    : "🔴🕯 <b>SELL</b> ▼";
}

/** Candle color indicator for the pair header */
function candleEmoji(direction) {
  return direction === "BUY" ? "🟩" : "🟥";
}

/** Confidence bar — colored by level using emoji blocks */
function confBar(pct) {
  const p     = Math.max(0, Math.min(100, pct || 0));
  const filled = Math.round(p / 10);
  const empty  = 10 - filled;
  // Color the bar: green if ≥70, yellow if ≥55, red if lower
  const fillChar = p >= 70 ? "🟩" : p >= 55 ? "🟨" : "🟥";
  return fillChar.repeat(filled) + "⬜".repeat(empty);
}

/** Quality score bar */
function qualityBar(score) {
  const s      = Math.max(0, Math.min(100, score || 0));
  const filled = Math.round(s / 10);
  const empty  = 10 - filled;
  const fillChar = s >= 70 ? "🔵" : s >= 50 ? "🟡" : "🔴";
  return fillChar.repeat(filled) + "⚫".repeat(empty);
}

/** Signal tier color */
function tierColor(tier) {
  const map = { A: "🟢 <b>Tier A</b>", B: "🟡 <b>Tier B</b>", C: "🟠 <b>Tier C</b>", SKIP: "⚫ Tier SKIP" };
  return map[tier] || `⚪ Tier ${esc(tier)}`;
}

/** Strength label */
function strengthLabel(strength) {
  const map = {
    STRONG:   "💪 <b>STRONG</b>",
    MODERATE: "✊ <b>MODERATE</b>",
    WEAK:     "🤏 WEAK",
  };
  return map[strength] || esc(strength);
}

/** Market phase emoji + label */
function phaseLabel(phase) {
  const map = {
    TRENDING:       "📈 <b>TRENDING</b>",
    RANGING:        "↔️ <b>RANGING</b>",
    CHAOTIC:        "🌀 CHAOTIC",
    LOW_VOLATILITY: "😴 LOW VOLATILITY",
  };
  return map[phase] || `❓ ${esc(phase)}`;
}

/** Volatility tier label */
function volatilityLabel(tier) {
  const map = {
    HIGH:        "🔴 HIGH",
    MEDIUM:      "🟡 MEDIUM",
    LOW:         "🟢 LOW",
    LOW_EVENING: "🟢 LOW (EVE)",
  };
  return map[tier] || esc(tier);
}

/** Expiry displayed in orange via bold + clock emoji */
function expiryLabel(expiry) {
  return `🟠 <b>${esc(expiry)}</b>`;
}

/** MTF confirmation */
function mtfLabel(confirmed) {
  return confirmed ? "✅ <b>CONFIRMED</b>" : "⚠️ Not confirmed";
}

// ═══════════════════════════════════════════════════════════════════════════════
// DYNAMIC DELAY CALCULATOR — unchanged from V6.5
// ═══════════════════════════════════════════════════════════════════════════════

function calcDeliveryDelay(signal) {
  try {
    const secs = Number(signal?.expirySecs);
    if (!Number.isFinite(secs) || secs <= 0) {
      return { delayMs: FAILSAFE_MS, delaySecs: FAILSAFE_MS / 1000, buffer: BUFFER_BY_TIER.DEFAULT, failsafe: true };
    }
    const tier   = signal?.volatilityTier ?? "DEFAULT";
    const buffer = BUFFER_BY_TIER[tier] ?? BUFFER_BY_TIER.DEFAULT;
    const rawMs  = (secs - buffer) * 1000;
    const delayMs   = Math.max(MIN_DELAY_MS, Math.min(rawMs, secs * 1000));
    const delaySecs = Math.round(delayMs / 1000);
    return { delayMs, delaySecs, buffer, failsafe: false };
  } catch {
    return { delayMs: FAILSAFE_MS, delaySecs: FAILSAFE_MS / 1000, buffer: BUFFER_BY_TIER.DEFAULT, failsafe: true };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCAN SUMMARY FORMATTER — HTML version
// ═══════════════════════════════════════════════════════════════════════════════

function formatScanSummary(tradeableCount, blockedCount, dataSource, isRealData, sessionKey, sessionPairs, sessionTradeCount, maxTrades) {
  const sourceTag  = isRealData ? "🟢 LIVE" : "🟡 SIMULATED";
  const safeSource = esc(String(dataSource || "unknown").replace(/_/g, " ").toUpperCase());
  const timeStr    = new Date().toLocaleTimeString("en-US", { hour12: false });
  const pairsStr   = sessionPairs && sessionPairs.length > 0
    ? sessionPairs.map(esc).join(", ")
    : "All pairs";
  const tradeInfo  = `${sessionTradeCount || 0}/${maxTrades || 10}`;

  return [
    `<b>⚡ SIGNALEX V7.0 — SCAN COMPLETE</b>`,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    `📊 Tradeable signals: <b>${tradeableCount}</b>`,
    `🚫 Filtered out: <b>${blockedCount}</b>`,
    `🕐 Session: <code>${esc(sessionKey || "OFF_HOURS")}</code>`,
    `👁 Watchlist: <code>${pairsStr}</code>`,
    `📈 Trades this session: <b>${tradeInfo}</b>`,
    `📡 Data: ${sourceTag} (<code>${safeSource}</code>)`,
    `🕒 Time: <code>${timeStr} GMT+1</code>`,
    `━━━━━━━━━━━━━━━━━━━━━━`,
  ].join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════════
// SIGNAL FORMATTER — V7.0: Full HTML color layout
// ═══════════════════════════════════════════════════════════════════════════════

function formatSignal(signal, rank, totalTradeable, timingInfo) {
  if (signal.noTrade) {
    const reasons = (signal.noTradeReasons || ["Conditions unfavourable"])
      .map((r) => `  ✗ ${esc(r)}`)
      .join("\n");
    return `<b>🚫 NO TRADE — ${esc(signal.pair)}</b>\n${reasons}`;
  }

  const isBuy     = signal.direction === "BUY";
  const candle    = candleEmoji(signal.direction);
  const dir       = directionBlock(signal.direction);
  const conf      = signal.confidence || 0;
  const quality   = signal.marketQualityScore || 0;
  const bar       = confBar(conf);
  const qBar      = qualityBar(quality);

  const nextHint = timingInfo && !timingInfo.failsafe
    ? `⏭ Next scan in ~<b>${timingInfo.delaySecs}s</b> (${timingInfo.buffer}s before expiry)`
    : `⏭ Next scan in ~<b>60s</b> (safe default)`;

  const lines = [
    `${candle} <b>SIGNAL #${rank} of ${totalTradeable} — ${esc(signal.pair)}</b> ${candle}`,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    // Direction block — most important, largest visual
    `${dir}`,
    ``,
    // Key trade data
    `⏱ Timeframe:  <code>${esc(signal.timeframe || "—")}</code>`,
    `⏳ Expiry:     ${expiryLabel(signal.expiry || "—")}`,
    `🎯 Entry:      <code>${esc(signal.entryWindow || "Next candle open")}</code>`,
    ``,
    // Quality section
    `${strengthLabel(signal.strength || "—")}`,
    `📊 Confidence: <b>${conf}%</b>`,
    `${bar}`,
    ``,
    `🔬 Quality:    <b>${quality}/100</b>`,
    `${qBar}`,
    ``,
    // Context
    `📈 Phase:      ${phaseLabel(signal.marketPhase || "—")}`,
    `🏆 Tier:       ${tierColor(signal.signalTier || "—")}`,
    `📉 Volatility: ${volatilityLabel(signal.volatilityTier || "—")}`,
    `🔀 MTF:        ${mtfLabel(signal.mtfConfirmed)}`,
    `🏦 Market:     <code>${esc((signal.marketType || "—").toUpperCase())}</code>`,
    `📐 Strategy:   <code>${esc(signal.strategyUsed || "TREND")}</code>`,
    ``,
  ];

  // Analysis reasons
  const { reasons } = signal;
  if (reasons) {
    lines.push(`<b>🔍 Analysis:</b>`);
    if (reasons.trend)      lines.push(`  ✅ ${esc(reasons.trend)}`);
    if (reasons.indicators) lines.push(`  ✅ ${esc(reasons.indicators)}`);
    if (reasons.zone)       lines.push(`  ✅ ${esc(reasons.zone)}`);
    if (reasons.session)    lines.push(`  ℹ️ ${esc(reasons.session)}`);
    lines.push(``);
  }

  // Expiry basis
  if (signal.expiryReason) {
    lines.push(`<i>📌 Expiry basis: ${esc(signal.expiryReason)}</i>`);
    lines.push(``);
  }

  // Warnings
  if (signal.warnings && signal.warnings.length > 0) {
    lines.push(`<b>⚠️ Caution:</b>`);
    signal.warnings.forEach((w) => lines.push(`  ⚠️ ${esc(w)}`));
    lines.push(``);
  }

  // Entry instruction
  lines.push(`<b>📋 Recommendation:</b>`);
  lines.push(`  ▶️ ${esc(signal.entryInstruction || `Enter within ${signal.entryWindow || "30s"} of candle open. Expiry: ${signal.expiry || "—"}.`)}`);
  lines.push(`  💰 Risk: <b>${signal.positionSize ?? "1.0"}%</b> of balance  (Tier ${esc(signal.signalTier || "—")}, ${conf}% conf)`);
  if (signal.strength !== "STRONG") {
    lines.push(`  🛑 Skip if market spikes at entry`);
  }

  lines.push(``);
  lines.push(nextHint);
  lines.push(`━━━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`🤖 <i>SIGNALEX V7.0 — Rule-Based Signal Engine</i>`);

  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════════
// NO TRADE ALERT — HTML version
// ═══════════════════════════════════════════════════════════════════════════════

function formatNoTradeAlert(blockedSignals) {
  if (!blockedSignals || blockedSignals.length === 0) return null;
  return [
    `<b>🚫 SMART FILTER — NO TRADE THIS SCAN</b>`,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    `All pairs blocked:`,
    ``,
    ...blockedSignals.slice(0, 5).map((s) => {
      const reason = (s.noTradeReasons || []).join(" | ");
      return `✗ <b>${esc(s.pair)}</b>: <i>${esc(reason)}</i>`;
    }),
    ``,
    `⏳ <i>Market conditions unfavourable — waiting for better setup</i>`,
    `━━━━━━━━━━━━━━━━━━━━━━`,
  ].join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════════
// SEND TO ALL CHATS — personal + VIP group simultaneously (V10.0)
// ═══════════════════════════════════════════════════════════════════════════════

async function sendMessageRaw(token, chatId, html) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  try {
    const res  = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId, text: html, parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    const data = await res.json().catch(() => ({ ok: false, description: "JSON parse failed" }));
    if (!data.ok && data.description?.includes("parse")) {
      const plain = html.replace(/<[^>]+>/g, "").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").trim();
      const res2  = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: plain, disable_web_page_preview: true }),
      });
      return res2.json().catch(() => ({ ok: false, description: "Fallback also failed" }));
    }
    return data;
  } catch (err) {
    return { ok: false, description: err.message };
  }
}

/**
 * sendMessage — sends to personal chat AND VIP group simultaneously.
 * VIP group is optional — only fires if TELEGRAM_VIP_CHAT_ID is set.
 * Returns the personal chat result (primary). VIP is fire-and-forget.
 */
async function sendMessage(token, chatId, html) {
  const vipChatId = process.env.TELEGRAM_VIP_CHAT_ID;

  // Fire both simultaneously — personal is awaited, VIP is parallel
  const [personalResult] = await Promise.all([
    sendMessageRaw(token, chatId, html),
    vipChatId && vipChatId !== chatId
      ? sendMessageRaw(token, vipChatId, html).then((r) => {
          if (r.ok) console.log(`[telegram] ✅ VIP group dispatch OK (${vipChatId})`);
          else console.warn(`[telegram] ⚠️  VIP group dispatch failed: ${r.description}`);
          return r;
        })
      : Promise.resolve({ ok: true, vip: false }),
  ]);

  return personalResult;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE HANDLER — V7.0
// ═══════════════════════════════════════════════════════════════════════════════

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const {
      signals             = [],
      dataSource          = "unknown",
      isRealData          = false,
      blockedCount        = 0,
      sessionKey          = "OFF_HOURS",
      activePairs         = [],
      sessionPairs        = [],
      backupPairs         = [],
      sessionTradeCount   = 0,
      maxTradesPerSession = 10,
    } = body;

    const token  = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (!token || token === "your-bot-token-here") {
      return NextResponse.json({
        ok: false, error: "TELEGRAM_BOT_TOKEN not configured",
        hint: "Add TELEGRAM_BOT_TOKEN to .env.local and restart: pm2 restart all",
      }, { status: 400 });
    }

    if (!chatId || chatId === "your-chat-id-here") {
      return NextResponse.json({
        ok: false, error: "TELEGRAM_CHAT_ID not configured",
        hint: "Message @userinfobot on Telegram to get your chat ID",
      }, { status: 400 });
    }

    // Hard cap: exactly 1 tradeable signal per cycle
    const tradeableSignals = signals.filter((s) => !s.noTrade).slice(0, 1);
    const blockedSignals   = signals.filter((s) =>  s.noTrade);
    const results          = [];
    let   deliveryTiming   = null;

    // Single-active-trade lock
    const now = Date.now();
    if (activeTradeExpiresAt > now) {
      const remainingSecs = Math.ceil((activeTradeExpiresAt - now) / 1000);
      console.log(`[telegram] Active trade still live — ${remainingSecs}s remaining`);
      return NextResponse.json({
        ok: false, blocked: true,
        reason: `Active trade in progress — ${remainingSecs}s until expiry`,
        remainingSecs,
        nextDispatchAt: new Date(activeTradeExpiresAt).toISOString(),
      });
    }

    // 1. Scan summary
    const summary = formatScanSummary(
      tradeableSignals.length,
      blockedCount || blockedSignals.length,
      dataSource, isRealData, sessionKey,
      sessionPairs.length > 0 ? sessionPairs : activePairs,
      sessionTradeCount, maxTradesPerSession,
    );
    const summaryResult = await sendMessage(token, chatId, summary);
    results.push({ type: "summary", ok: summaryResult.ok, error: summaryResult.description });

    // 2. Send the single tradeable signal
    if (tradeableSignals.length > 0) {
      const signal     = tradeableSignals[0];
      const timingInfo = calcDeliveryDelay(signal);

      await new Promise((r) => setTimeout(r, COOLDOWN_MS));

      const html   = formatSignal(signal, 1, tradeableSignals.length, timingInfo);
      const result = await sendMessage(token, chatId, html);
      results.push({
        type:                    "signal",
        pair:                    signal.pair,
        rank:                    1,
        ok:                      result.ok,
        error:                   result.description,
        nextSignalCheckDelaySecs: timingInfo.delaySecs,
        timingFailsafe:           timingInfo.failsafe,
      });

      if (result.ok) {
        const expirySecs     = Number(signal.expirySecs) || FAILSAFE_MS / 1000;
        activeTradeExpiresAt = Date.now() + expirySecs * 1000;
        console.log(`[telegram] Trade lock set — ${expirySecs}s | pair: ${signal.pair} | direction: ${signal.direction}`);
      }

      deliveryTiming = {
        expirySecs:               signal.expirySecs,
        volatilityTier:           signal.volatilityTier,
        buffer:                   timingInfo.buffer,
        nextSignalCheckDelaySecs: timingInfo.delaySecs,
        nextSignalCheckTime:      new Date(Date.now() + timingInfo.delayMs).toISOString(),
        failsafe:                 timingInfo.failsafe,
      };

      console.log(`[telegram] Signal dispatched | ${signal.pair} | ${signal.direction} | expiry: ${signal.expirySecs}s | next check: ${timingInfo.delaySecs}s`);
    }

    // 3. No-trade alert
    if (tradeableSignals.length === 0 && blockedSignals.length > 0) {
      await new Promise((r) => setTimeout(r, COOLDOWN_MS));
      const noTradeMsg = formatNoTradeAlert(blockedSignals);
      if (noTradeMsg) {
        const result = await sendMessage(token, chatId, noTradeMsg);
        results.push({ type: "no_trade_alert", ok: result.ok, error: result.description });
      }
    }

    const sentCount = results.filter((r) => r.ok && r.type === "signal").length;
    const allOk     = results.every((r) => r.ok);
    const errors    = results.filter((r) => !r.ok).map((r) => r.error).filter(Boolean);

    return NextResponse.json({
      ok: allOk, sentCount, results, deliveryTiming,
      ...(errors.length ? { errors } : {}),
    });

  } catch (err) {
    console.error("[telegram] fatal:", err);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
