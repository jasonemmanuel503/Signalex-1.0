"use client";

import { useState, useEffect } from "react";
import styles from "./TradesTable.module.css";

export default function TradesTable() {
  const [trades, setTrades] = useState([]);
  const [loading, setLoading] = useState(true);
  const [accountFilter, setAccountFilter] = useState("all");
  const [marketFilter, setMarketFilter] = useState("all");

  const fetchTrades = async () => {
    try {
      const res = await fetch("/api/trades?limit=100");
      if (res.ok) {
        const data = await res.json();
        if (data.trades) {
          setTrades(data.trades);
        }
      }
    } catch {
      // Background poll silently fails safely
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTrades();
    const interval = setInterval(fetchTrades, 2000);
    return () => clearInterval(interval);
  }, []);

  const filteredTrades = trades.filter((t) => {
    if (accountFilter !== "all" && t.account !== accountFilter) return false;
    if (marketFilter !== "all" && t.market !== marketFilter) return false;
    return true;
  });

  return (
    <div className={styles.container}>
      {/* Header and Filter Row */}
      <div className={styles.headerRow}>
        <div className={styles.titleArea}>
          <div className={styles.title}>📜 TRADE EXECUTION LEDGER</div>
          <span className={styles.countBadge}>{filteredTrades.length} trades</span>
        </div>

        <div className={styles.filterGroup}>
          {["all", "demo", "real"].map((f) => (
            <button
              key={f}
              className={`${styles.filterBtn} ${accountFilter === f ? styles.filterBtnActive : ""}`}
              onClick={() => setAccountFilter(f)}
            >
              {f.toUpperCase()}
            </button>
          ))}
          <span style={{ color: "rgba(255,255,255,0.2)", margin: "0 2px" }}>|</span>
          {["all", "forex", "otc"].map((m) => (
            <button
              key={m}
              className={`${styles.filterBtn} ${marketFilter === m ? styles.filterBtnActive : ""}`}
              onClick={() => setMarketFilter(m)}
            >
              {m.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {loading && trades.length === 0 ? (
        <div className={styles.emptyState}>Loading trades ledger…</div>
      ) : filteredTrades.length === 0 ? (
        <div className={styles.emptyState}>No trades recorded yet for selected filter.</div>
      ) : (
        <>
          {/* Desktop Table View */}
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.th}>Time</th>
                  <th className={styles.th}>Account</th>
                  <th className={styles.th}>Pair</th>
                  <th className={styles.th}>Direction</th>
                  <th className={styles.th}>Source</th>
                  <th className={styles.th}>Stake</th>
                  <th className={styles.th}>Payout</th>
                  <th className={styles.th}>Entry / Exit</th>
                  <th className={styles.th}>Latency</th>
                  <th className={styles.th}>Result</th>
                  <th className={styles.th}>Profit</th>
                </tr>
              </thead>
              <tbody>
                {filteredTrades.map((t) => {
                  const isWin = t.result === "WIN";
                  const isLoss = t.result === "LOSS";
                  const isTie = t.result === "TIE";
                  const resClass = isWin
                    ? styles.resWin
                    : isLoss
                    ? styles.resLoss
                    : isTie
                    ? styles.resTie
                    : styles.resUnconfirmed;

                  const timeStr = t.sent_at
                    ? new Date(t.sent_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
                    : "—";

                  return (
                    <tr key={t.id} className={styles.tr}>
                      <td className={styles.td} style={{ opacity: 0.7 }}>{timeStr}</td>
                      <td className={styles.td}>
                        <span className={t.account === "real" ? styles.chipReal : styles.chipDemo}>
                          {t.account?.toUpperCase() || "DEMO"}
                        </span>
                      </td>
                      <td className={styles.td} style={{ fontWeight: 700 }}>
                        {t.pair}
                        {t.market === "otc" && (
                          <span style={{ fontSize: 9, marginLeft: 4, opacity: 0.6, color: "#ffaa44" }}>OTC</span>
                        )}
                      </td>
                      <td className={styles.td}>
                        <span style={{ color: t.direction === "BUY" || t.direction === "CALL" ? "#54b054" : "#f1707b", fontWeight: 700 }}>
                          {t.direction}
                        </span>
                      </td>
                      <td className={styles.td} style={{ textTransform: "uppercase", fontSize: 11, opacity: 0.8 }}>
                        {t.source || "auto"}
                      </td>
                      <td className={styles.td}>${Number(t.stake || 10).toFixed(2)}</td>
                      <td className={styles.td} style={{ color: "#54b054" }}>{t.payout_pct || 85}%</td>
                      <td className={styles.td} style={{ fontFamily: "var(--font-data, monospace)", fontSize: 11 }}>
                        {t.entry_price != null ? t.entry_price : "—"}
                        {" → "}
                        {t.exit_price != null ? t.exit_price : "—"}
                      </td>
                      <td className={styles.td} style={{ opacity: 0.7, fontSize: 11 }}>
                        {t.latency_ms != null ? `${t.latency_ms}ms` : "—"}
                      </td>
                      <td className={styles.td}>
                        <span className={resClass}>{t.result || "OPEN"}</span>
                      </td>
                      <td className={styles.td} style={{ fontWeight: 800 }}>
                        {t.profit != null ? (
                          <span style={{ color: t.profit > 0 ? "#54b054" : t.profit < 0 ? "#f1707b" : "#ffaa44" }}>
                            {t.profit > 0 ? `+$${t.profit.toFixed(2)}` : t.profit < 0 ? `-$${Math.abs(t.profit).toFixed(2)}` : "$0.00"}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile Card View */}
          <div className={styles.mobileCardList}>
            {filteredTrades.map((t) => {
              const isWin = t.result === "WIN";
              const isLoss = t.result === "LOSS";
              const isTie = t.result === "TIE";
              const resClass = isWin
                ? styles.resWin
                : isLoss
                ? styles.resLoss
                : isTie
                ? styles.resTie
                : styles.resUnconfirmed;

              const timeStr = t.sent_at
                ? new Date(t.sent_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
                : "—";

              return (
                <div key={t.id} className={styles.mCard}>
                  <div className={styles.mCardTop}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span className={t.account === "real" ? styles.chipReal : styles.chipDemo}>
                        {t.account?.toUpperCase() || "DEMO"}
                      </span>
                      <strong style={{ fontSize: 14 }}>{t.pair}</strong>
                      <span style={{ color: t.direction === "BUY" || t.direction === "CALL" ? "#54b054" : "#f1707b", fontWeight: 700, fontSize: 12 }}>
                        {t.direction}
                      </span>
                    </div>
                    <span className={resClass}>{t.result || "OPEN"}</span>
                  </div>

                  <div className={styles.mCardRow}>
                    <span>Stake / Payout:</span>
                    <span>${Number(t.stake || 10).toFixed(2)} @ {t.payout_pct || 85}%</span>
                  </div>

                  <div className={styles.mCardRow}>
                    <span>Profit:</span>
                    <strong>
                      {t.profit != null ? (
                        <span style={{ color: t.profit > 0 ? "#54b054" : t.profit < 0 ? "#f1707b" : "#ffaa44" }}>
                          {t.profit > 0 ? `+$${t.profit.toFixed(2)}` : t.profit < 0 ? `-$${Math.abs(t.profit).toFixed(2)}` : "$0.00"}
                        </span>
                      ) : "—"}
                    </strong>
                  </div>

                  <div className={styles.mCardRow} style={{ fontSize: 11, opacity: 0.6 }}>
                    <span>{timeStr} · {t.source || "auto"}</span>
                    <span>{t.latency_ms ? `${t.latency_ms}ms` : ""}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
