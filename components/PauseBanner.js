"use client";

import { useState } from "react";
import styles from "./PauseBanner.module.css";

export default function PauseBanner({ pauseReason, onResume }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const getFriendlyReason = (reason) => {
    if (!reason) return "Safety guardrail activated";
    const r = String(reason).toLowerCase();
    if (r.includes("loss_streak") || r.includes("consecutive")) {
      return "🛑 Stopped after 3 consecutive losses (Guardrail #1: Loss Streak Limit reached)";
    }
    if (r.includes("daily_loss")) {
      return "📉 Daily loss limit reached (Guardrail #3: Capital Preservation activated)";
    }
    if (r.includes("max_trades")) {
      return "📊 Maximum trades per day reached for current session window";
    }
    if (r.includes("kill")) {
      return "⚠️ Emergency Kill Switch was activated";
    }
    if (r.includes("session_expired") || r.includes("auth")) {
      return "🔑 Broker session expired or unauthorized — re-login needed";
    }
    return `Safety guardrail: ${reason}`;
  };

  const handleResume = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "resume" }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || "Failed to resume trading");
      }
      if (onResume) onResume(data.state);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.banner} role="alert">
      <div className={styles.left}>
        <div className={styles.icon}>🛑</div>
        <div className={styles.content}>
          <div className={styles.title}>TRADING PAUSED</div>
          <div className={styles.reason}>{getFriendlyReason(pauseReason)}</div>
          <div className={styles.subtext}>
            Order execution is currently stopped. All market monitoring and shadow evaluation continue safely.
          </div>
          {error && <div style={{ color: "#ff8b8b", fontSize: 11, marginTop: 4 }}>❌ {error}</div>}
        </div>
      </div>
      <button
        className={styles.resumeBtn}
        onClick={handleResume}
        disabled={loading}
        title="Tap to manually resume trading"
      >
        {loading ? "⟳ Resuming…" : "▶ Resume Trading"}
      </button>
    </div>
  );
}
