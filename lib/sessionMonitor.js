/**
 * lib/sessionMonitor.js
 * Continuous background monitor for Pocket Option gateway connection and session health.
 * Enforces runtime mode demotion, pending trade cancellations, audit logging,
 * and ops-only Telegram alerting upon session degradation.
 */

import { orchestrator } from "./trading/orchestrator.js";
import { writeAuditLog } from "./store/index.js";
import { sendOpsAlert, escapeHtml } from "./telegram.js";

const PO_GATEWAY_URL = process.env.PO_GATEWAY_URL || "http://127.0.0.1:8002";
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN || "dev_internal_token_signalex_2026";

export class SessionMonitor {
  constructor(options = {}) {
    this.pollIntervalMs = options.pollIntervalMs || 10_000;
    this.gatewayUrl = options.gatewayUrl || PO_GATEWAY_URL;
    this.token = options.token || INTERNAL_API_TOKEN;

    this.isFirstPoll = true;
    this.lastKnownStatus = null;
    this.badStateTransitioned = false;
    this.unreachableConsecutiveCount = 0;
    this.connectingSince = 0;
    this.lastExpiredReminderAt = 0;

    this.stepFlags = {
      setMode: false,
      cancelPending: false,
      auditLog: false,
      alert: false,
    };

    this.timer = null;
  }

  async checkStatus() {
    try {
      const res = await fetch(`${this.gatewayUrl}/health`, {
        headers: { "X-Internal-Token": this.token },
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const data = await res.json();
        return data.session || "unknown";
      }
      return "unreachable";
    } catch {
      return "unreachable";
    }
  }

  async tick() {
    const rawStatus = await this.checkStatus();
    const now = Date.now();

    // 1. Boot grace & first poll check
    if (this.isFirstPoll) {
      this.isFirstPoll = false;
      this.lastKnownStatus = rawStatus;
      if (rawStatus === "connecting" || rawStatus === "unknown") {
        this.connectingSince = now;
      }
      if (rawStatus === "unreachable") {
        this.unreachableConsecutiveCount = 1;
      }
      return;
    }

    // 2. Track unreachable count
    if (rawStatus === "unreachable") {
      this.unreachableConsecutiveCount++;
    } else {
      this.unreachableConsecutiveCount = 0;
    }

    // 3. Resolve status
    let effectiveStatus = rawStatus;
    if (rawStatus === "unreachable") {
      if (this.unreachableConsecutiveCount < 3) {
        // Boot grace / brief network hiccup
        return;
      }
      effectiveStatus = "unreachable";
    } else if (rawStatus === "connecting" || rawStatus === "unknown") {
      if (this.connectingSince === 0) {
        this.connectingSince = now;
      }
      if (now - this.connectingSince < 60_000) {
        // In transitional grace period
        return;
      }
      // After 60s transitional grace, treat as bad
      effectiveStatus = rawStatus;
    } else {
      this.connectingSince = 0;
    }

    // 4. Recovery to valid
    if (effectiveStatus === "valid") {
      if (this.badStateTransitioned) {
        this.badStateTransitioned = false;
        this.lastExpiredReminderAt = 0;
        this.stepFlags = { setMode: false, cancelPending: false, auditLog: false, alert: false };
        try {
          await sendOpsAlert(
            "🟢 <b>Pocket Option Session Restored</b>\n" +
            "Broker connection is now VALID. Note: Trading mode remains in SIGNALS for safety. Re-enable SEMI or AUTO via the control bar."
          );
        } catch (e) {
          console.warn("[SessionMonitor] Restored alert dispatch error:", e.message);
        }
      }
      this.lastKnownStatus = "valid";
      return;
    }

    // 5. Bad states: expired, disconnected, missing, unreachable, or timed-out connecting/unknown
    const isBad = ["expired", "disconnected", "missing", "unreachable", "connecting", "unknown"].includes(effectiveStatus);
    if (!isBad) return;

    // Transition to new bad state resets step flags
    if (effectiveStatus !== this.lastKnownStatus) {
      this.lastKnownStatus = effectiveStatus;
      this.badStateTransitioned = true;
      this.stepFlags = {
        setMode: false,
        cancelPending: false,
        auditLog: false,
        alert: false,
      };
    }

    const reason = `Pocket Option session degraded: ${effectiveStatus}`;

    // Step 1: Mode demotion to SIGNALS if SEMI or AUTO
    if (!this.stepFlags.setMode) {
      try {
        const state = orchestrator.getState();
        if (state.mode === "SEMI" || state.mode === "AUTO") {
          await orchestrator.setMode("SIGNALS", "system", { reason });
        }
        this.stepFlags.setMode = true;
      } catch (err) {
        console.warn("[SessionMonitor] Step 1 setMode error:", err.message);
      }
    }

    // Step 2: Cancel pending confirmations
    if (!this.stepFlags.cancelPending) {
      try {
        orchestrator.cancelPendingConfirmations(reason);
        this.stepFlags.cancelPending = true;
      } catch (err) {
        console.warn("[SessionMonitor] Step 2 cancelPendingConfirmations error:", err.message);
      }
    }

    // Step 3: Audit log
    if (!this.stepFlags.auditLog) {
      try {
        writeAuditLog("system", "session_monitor_demote", {
          status: effectiveStatus,
          reason,
          at: new Date().toISOString(),
        });
        this.stepFlags.auditLog = true;
      } catch (err) {
        console.warn("[SessionMonitor] Step 3 writeAuditLog error:", err.message);
      }
    }

    // Step 4: Ops alert
    if (!this.stepFlags.alert) {
      try {
        const alertRes = await sendOpsAlert(
          `⚠️ <b>SignaLex Broker Alert: ${escapeHtml(effectiveStatus.toUpperCase())}</b>\n` +
          `Pocket Option session status is <code>${escapeHtml(effectiveStatus)}</code>.\n` +
          `Automated action taken: mode set to SIGNALS, pending trade confirmations cancelled.`
        );
        if (alertRes.ok) {
          this.stepFlags.alert = true;
        }
      } catch (err) {
        console.warn("[SessionMonitor] Step 4 sendOpsAlert error:", err.message);
      }
    }

    // Reminder every 30 minutes while expired persists
    if (effectiveStatus === "expired" && this.stepFlags.alert) {
      if (now - this.lastExpiredReminderAt >= 30 * 60 * 1000) {
        this.lastExpiredReminderAt = now;
        try {
          await sendOpsAlert(
            "⚠️ <b>Reminder: Pocket Option Session Expired</b>\n" +
            "Broker session remains expired. Update credentials via the Reconnect Banner or API to restore trading execution."
          );
        } catch (err) {
          console.warn("[SessionMonitor] Expired reminder error:", err.message);
        }
      }
    }
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((err) => {
        console.warn("[SessionMonitor] Unhandled tick error:", err.message);
      });
    }, this.pollIntervalMs);

    if (this.timer && typeof this.timer.unref === "function") {
      this.timer.unref();
    }
    console.log(`[SessionMonitor] Background session monitor started (interval: ${this.pollIntervalMs}ms)`);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

export function startSessionMonitor() {
  const g = globalThis;
  if (g.__signalexSessionMonitor) return;
  g.__signalexSessionMonitor = new SessionMonitor();
  g.__signalexSessionMonitor.start();
}

export default {
  SessionMonitor,
  startSessionMonitor,
};
