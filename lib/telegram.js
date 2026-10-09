/**
 * lib/telegram.js
 * Operations alerts helper for SignaLex.
 * Sends critical system, session, and operational alerts to TELEGRAM_CHAT_ID ONLY.
 * NEVER sends operational alerts to TELEGRAM_VIP_CHAT_ID.
 */

let warnedMissingConfig = false;

export function escapeHtml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export async function sendOpsAlert(text) {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (!token || !chatId) {
      if (!warnedMissingConfig) {
        console.warn("[Telegram Ops] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not configured. Ops alert skipped.");
        warnedMissingConfig = true;
      }
      return { ok: false, error: "Telegram credentials not configured" };
    }

    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(5000),
    });

    const data = await res.json().catch(() => ({ ok: false }));
    if (!res.ok || !data.ok) {
      const errMsg = data?.description || `HTTP ${res.status}`;
      console.warn(`[Telegram Ops] Failed to dispatch alert: ${errMsg}`);
      return { ok: false, error: errMsg };
    }

    return { ok: true };
  } catch (err) {
    console.warn(`[Telegram Ops] Dispatch error: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

export default {
  sendOpsAlert,
  escapeHtml,
};
