"use client";

import { useState, useEffect } from "react";
import styles from "./PendingTradeCard.module.css";

export default function PendingTradeCard({ pendingList = [], onRefresh }) {
  const [timers, setTimers] = useState({});
  const [acting, setActing] = useState({});
  const [messages, setMessages] = useState({});

  // Countdown timer effect
  useEffect(() => {
    const updateCountdown = () => {
      const now = Date.now();
      const updated = {};
      for (const item of pendingList) {
        const expiresTime = new Date(item.expires_at || Date.now() + 20000).getTime();
        const leftSecs = Math.max(0, Math.ceil((expiresTime - now) / 1000));
        updated[item.id] = leftSecs;
      }
      setTimers(updated);
    };

    updateCountdown();
    const interval = setInterval(updateCountdown, 1000);
    return () => clearInterval(interval);
  }, [pendingList]);

  if (!pendingList || pendingList.length === 0) return null;

  const handleAction = async (id, action) => {
    setActing((prev) => ({ ...prev, [id]: true }));
    setMessages((prev) => ({ ...prev, [id]: null }));
    try {
      const res = await fetch("/api/pending", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || `Failed to ${action} trade`);
      }
      setMessages((prev) => ({
        ...prev,
        [id]: action === "confirm" ? "✅ Order Dispatched to Broker!" : "Skipped",
      }));
      if (onRefresh) onRefresh();
    } catch (err) {
      setMessages((prev) => ({ ...prev, [id]: `❌ ${err.message}` }));
    } finally {
      setActing((prev) => ({ ...prev, [id]: false }));
    }
  };

  return (
    <div className={styles.container}>
      <div className={styles.headingRow}>
        <div className={styles.headingTitle}>
          <span>⚡</span> SEMI-AUTO PENDING CONFIRMATIONS ({pendingList.length})
        </div>
      </div>

      {pendingList.map((item) => {
        const payload = item.payload || {};
        const pair = payload.pair || "EURUSD";
        const direction = payload.direction || "CALL";
        const expiry = payload.expiry || payload.expirySecs || 60;
        const stake = payload.stake || 10.0;
        const payout = payload.payout_pct || 85;
        const breakEven = (100 / (100 + payout)) * 100;
        const timeLeft = timers[item.id] !== undefined ? timers[item.id] : 20;
        const isExpired = timeLeft <= 0;
        const isExecuting = acting[item.id];
        const statusMsg = messages[item.id];

        const isBuy = direction.toUpperCase() === "BUY" || direction.toUpperCase() === "CALL";

        return (
          <div key={item.id} className={styles.card}>
            {/* Top row: Pair, Direction, Timer */}
            <div className={styles.cardTop}>
              <div className={styles.pairBadge}>
                <span className={styles.pairName}>{pair}</span>
                <span className={`${styles.directionChip} ${isBuy ? styles.dirBuy : styles.dirSell}`}>
                  {isBuy ? "▲ BUY / CALL" : "▼ SELL / PUT"}
                </span>
                {payload.tier && (
                  <span style={{ fontSize: 11, padding: "2px 6px", background: "rgba(0,120,212,0.2)", borderRadius: 4, color: "#5ab0f7" }}>
                    TIER {payload.tier}
                  </span>
                )}
              </div>

              <div className={styles.timerContainer}>
                <span className={styles.timerLabel}>Countdown:</span>
                <span className={styles.timerValue}>
                  {isExpired ? "EXPIRED" : `${timeLeft}s`}
                </span>
              </div>
            </div>

            {/* Metrics grid */}
            <div className={styles.metricsGrid}>
              <div className={styles.metricItem}>
                <span className={styles.metricLabel}>Stake</span>
                <span className={styles.metricVal}>${Number(stake).toFixed(2)}</span>
              </div>
              <div className={styles.metricItem}>
                <span className={styles.metricLabel}>Payout</span>
                <span className={styles.metricVal} style={{ color: "#54b054" }}>{payout}%</span>
              </div>
              <div className={styles.metricItem}>
                <span className={styles.metricLabel}>Break-Even</span>
                <span className={`${styles.metricVal} ${styles.metricBreakEven}`}>{breakEven.toFixed(1)}%</span>
              </div>
              <div className={styles.metricItem}>
                <span className={styles.metricLabel}>Expiry</span>
                <span className={styles.metricVal}>{expiry}s</span>
              </div>
              {payload.signalPrice && (
                <div className={styles.metricItem}>
                  <span className={styles.metricLabel}>Signal Price</span>
                  <span className={styles.metricVal}>{payload.signalPrice}</span>
                </div>
              )}
            </div>

            {/* Status Feedback */}
            {statusMsg && (
              <div className={styles.statusCard}>
                <span>{statusMsg}</span>
              </div>
            )}

            {/* Actions */}
            <div className={styles.actionsRow}>
              <button
                className={styles.executeBtn}
                onClick={() => handleAction(item.id, "confirm")}
                disabled={isExpired || isExecuting}
              >
                {isExecuting ? "⟳ Dispatching…" : isExpired ? "Expired (No Order)" : "⚡ EXECUTE ORDER"}
              </button>
              <button
                className={styles.skipBtn}
                onClick={() => handleAction(item.id, "skip")}
                disabled={isExecuting}
              >
                Dismiss / Skip
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
