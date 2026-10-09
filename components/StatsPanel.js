"use client";

import { useState, useEffect } from "react";
import styles from "./StatsPanel.module.css";

// 95% Wilson score interval for binomial proportion
function calculateWilsonInterval(wins, total) {
  if (total <= 0) return { lower: 0, upper: 0 };
  const z = 1.96; // 95% confidence
  const z2 = z * z;
  const p = wins / total;
  const denominator = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denominator;
  const spread =
    (z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))) / denominator;

  const lower = Math.max(0, center - spread) * 100;
  const upper = Math.min(1, center + spread) * 100;
  return {
    lower: Number(lower.toFixed(1)),
    upper: Number(upper.toFixed(1)),
  };
}

export default function StatsPanel() {
  const [slice, setSlice] = useState("account"); // account | market | tier | pair | hour
  const [trades, setTrades] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadTrades() {
      try {
        const res = await fetch("/api/trades?limit=200");
        if (res.ok) {
          const data = await res.json();
          if (data.trades) setTrades(data.trades);
        }
      } catch {
        // Safe fallback
      } finally {
        setLoading(false);
      }
    }
    loadTrades();
  }, []);

  // Group trades by selected slice
  const groupData = () => {
    const groups = {};

    for (const t of trades) {
      if (!t.result || (t.result !== "WIN" && t.result !== "LOSS")) continue;

      let key = "Other";
      if (slice === "account") {
        key = t.account?.toUpperCase() || "DEMO";
      } else if (slice === "market") {
        key = t.market?.toUpperCase() || (t.pair?.includes("_otc") ? "OTC" : "FOREX");
      } else if (slice === "tier") {
        key = `Tier ${t.tier || "B"}`;
      } else if (slice === "pair") {
        key = t.pair || "Unknown";
      } else if (slice === "hour") {
        const d = new Date(t.sent_at || Date.now());
        key = `${String(d.getUTCHours()).padStart(2, "0")}:00 UTC`;
      }

      if (!groups[key]) {
        groups[key] = {
          name: key,
          wins: 0,
          losses: 0,
          total: 0,
          totalProfit: 0,
          payoutSum: 0,
        };
      }

      const g = groups[key];
      g.total += 1;
      g.payoutSum += Number(t.payout_pct || 85);
      g.totalProfit += Number(t.profit || 0);
      if (t.result === "WIN") g.wins += 1;
      else if (t.result === "LOSS") g.losses += 1;
    }

    // Process slices
    const results = Object.values(groups).map((g) => {
      const avgPayout = g.total > 0 ? g.payoutSum / g.total : 85;
      const breakEven = (100 / (100 + avgPayout)) * 100;
      const winRate = g.total > 0 ? (g.wins / g.total) * 100 : 0;
      const interval = calculateWilsonInterval(g.wins, g.total);

      let verdict = "Not enough trades yet";
      let verdictClass = styles.vNeutral;

      if (g.total < 15) {
        verdict = "Not enough trades yet (<15 trades)";
        verdictClass = styles.vNeutral;
      } else if (winRate < breakEven) {
        verdict = "Below break-even";
        verdictClass = styles.vBelow;
      } else if (interval.lower < breakEven) {
        verdict = "Above break-even, still uncertain";
        verdictClass = styles.vUncertain;
      } else {
        verdict = "Likely profitable";
        verdictClass = styles.vProfitable;
      }

      return {
        ...g,
        avgPayout: Number(avgPayout.toFixed(1)),
        breakEven: Number(breakEven.toFixed(1)),
        winRate: Number(winRate.toFixed(1)),
        interval,
        netProfit: Number(g.totalProfit.toFixed(2)),
        verdict,
        verdictClass,
      };
    });

    return results;
  };

  const processedSlices = groupData();

  return (
    <div className={styles.container}>
      {/* Header */}
      <div className={styles.headerRow}>
        <div className={styles.titleArea}>
          <div className={styles.title}>
            <span>📊</span> HONEST PERFORMANCE & BREAK-EVEN ANALYSIS
          </div>
          <div className={styles.subtitle}>
            Evaluates win rate against break-even hurdle with 95% Wilson confidence intervals.
          </div>
        </div>

        {/* Slice navigation */}
        <div className={styles.sliceNav}>
          {[
            { id: "account", label: "Account" },
            { id: "market", label: "Market" },
            { id: "tier", label: "Tier" },
            { id: "pair", label: "Pair" },
            { id: "hour", label: "Hour (UTC)" },
          ].map((s) => (
            <button
              key={s.id}
              className={`${styles.sliceBtn} ${slice === s.id ? styles.sliceBtnActive : ""}`}
              onClick={() => setSlice(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* Cards Grid */}
      {loading ? (
        <div style={{ textAlign: "center", padding: "30px 0", color: "rgba(255,255,255,0.4)" }}>
          Computing statistics…
        </div>
      ) : processedSlices.length === 0 ? (
        <div style={{ textAlign: "center", padding: "30px 0", color: "rgba(255,255,255,0.4)" }}>
          No resolved trades yet. As trades close, honest statistics will appear here.
        </div>
      ) : (
        <div className={styles.cardsGrid}>
          {processedSlices.map((item) => (
            <div key={item.name} className={styles.statCard}>
              <div className={styles.cardHead}>
                <span className={styles.cardLabel}>{item.name}</span>
                <span className={styles.tradesCount}>{item.total} trades ({item.wins}W / {item.losses}L)</span>
              </div>

              <div className={styles.metricsRow}>
                <div className={styles.metricBox}>
                  <span className={styles.metricLabel}>Win Rate</span>
                  <span
                    className={styles.metricVal}
                    style={{ color: item.winRate >= item.breakEven ? "#54b054" : "#f1707b" }}
                  >
                    {item.winRate}%
                  </span>
                </div>
                <div className={styles.metricBox}>
                  <span className={styles.metricLabel}>Break-Even Hurdle</span>
                  <span className={styles.metricVal} style={{ color: "#5ab0f7" }}>
                    {item.breakEven}%
                  </span>
                </div>
                <div className={styles.metricBox}>
                  <span className={styles.metricLabel}>95% Confidence</span>
                  <span className={styles.intervalText}>
                    [{item.interval.lower}% – {item.interval.upper}%]
                  </span>
                </div>
                <div className={styles.metricBox}>
                  <span className={styles.metricLabel}>Net Profit</span>
                  <span
                    className={styles.metricVal}
                    style={{ color: item.netProfit > 0 ? "#54b054" : item.netProfit < 0 ? "#f1707b" : "#ffffff" }}
                  >
                    {item.netProfit >= 0 ? "+" : ""}${item.netProfit.toFixed(2)}
                  </span>
                </div>
              </div>

              {/* Verdict badge */}
              <div className={`${styles.verdictBadge} ${item.verdictClass}`}>
                {item.verdict}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className={styles.disclaimer}>
        ℹ️ <strong>Note:</strong> This statistical analysis is purely informational for edge assessment and never locks or blocks trading.
      </div>
    </div>
  );
}
