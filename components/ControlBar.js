"use client";

import { useState, useEffect } from "react";
import styles from "./ControlBar.module.css";

const MODE_DESCRIPTIONS = {
  OFF: "OFF — Market analysis & shadow evaluation continue. No signals acted on, no orders.",
  SIGNALS: "SIGNALS — Live signals shown on UI & dispatched to Telegram. Zero orders placed.",
  SEMI: "SEMI — Order-eligible signals create pending cards with 20s countdown. One tap executes.",
  AUTO: "AUTO — Signals meeting tier & payout guardrails are automatically executed on broker.",
};

export default function ControlBar({
  controlState,
  onStateUpdate,
  onOpenSettings,
}) {
  const [loadingMode, setLoadingMode] = useState(false);
  const [loadingAccount, setLoadingAccount] = useState(false);
  const [errorToast, setErrorToast] = useState(null);

  // Modals state
  const [showRealModal, setShowRealModal] = useState(false);
  const [realInput, setRealInput] = useState("");
  const [showAutoModal, setShowAutoModal] = useState(false);
  const [showKillModal, setShowKillModal] = useState(false);

  const mode = controlState?.mode || "SIGNALS";
  const account = controlState?.account || "demo";
  const isPaused = Boolean(controlState?.trading_paused);
  const isSessionValid = controlState?.gateway?.connected === true && controlState?.gateway?.session === "valid";
  const isGatewayDown = !controlState?.gateway?.connected;

  // Clear toast after 5s
  useEffect(() => {
    if (errorToast) {
      const t = setTimeout(() => setErrorToast(null), 5000);
      return () => clearTimeout(t);
    }
  }, [errorToast]);

  // Mode change handler
  const handleSelectMode = async (targetMode) => {
    if (targetMode === mode) return;

    // Guard: Can't switch to SEMI/AUTO if paused or session is not valid
    if ((targetMode === "SEMI" || targetMode === "AUTO") && isPaused) {
      setErrorToast("Cannot enable SEMI or AUTO while trading is paused. Resume trading first.");
      return;
    }
    if ((targetMode === "SEMI" || targetMode === "AUTO") && !isSessionValid) {
      const stateLabel = controlState?.gateway?.session || (isGatewayDown ? "disconnected" : "unreachable");
      setErrorToast(`Cannot enable SEMI or AUTO while Pocket Option session is ${stateLabel}.`);
      return;
    }

    // AUTO requires session confirmation modal on first select
    if (targetMode === "AUTO") {
      const hasConfirmed = typeof window !== "undefined" && sessionStorage.getItem("signalex_auto_modal_confirmed");
      if (!hasConfirmed) {
        setShowAutoModal(true);
        return;
      }
    }

    await executeModeChange(targetMode);
  };

  const executeModeChange = async (targetMode) => {
    setLoadingMode(true);
    setErrorToast(null);
    try {
      const res = await fetch("/api/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set_mode", mode: targetMode }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || "Failed to change mode");
      }
      if (onStateUpdate) onStateUpdate(data.state);
    } catch (err) {
      setErrorToast(`Mode change failed: ${err.message}`);
    } finally {
      setLoadingMode(false);
    }
  };

  // Account change handler
  const handleSelectAccount = (targetAccount) => {
    if (targetAccount === account) return;
    if (targetAccount === "real") {
      setRealInput("");
      setShowRealModal(true);
    } else {
      executeAccountChange("demo");
    }
  };

  const executeAccountChange = async (targetAccount, confirm) => {
    setLoadingAccount(true);
    setErrorToast(null);
    try {
      const payload = { action: "set_account", account: targetAccount };
      if (targetAccount === "real") {
        payload.confirm = confirm;
      }
      const res = await fetch("/api/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || "Failed to change account");
      }
      if (onStateUpdate) onStateUpdate(data.state);
      setShowRealModal(false);
    } catch (err) {
      setErrorToast(`Account switch failed: ${err.message}`);
    } finally {
      setLoadingAccount(false);
    }
  };

  // Kill switch handler
  const handleExecuteKill = async () => {
    setErrorToast(null);
    try {
      const res = await fetch("/api/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "kill", reason: "Emergency Kill Switch tapped on Dashboard" }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || "Kill switch command failed");
      }
      if (onStateUpdate) onStateUpdate(data.state);
      setShowKillModal(false);
    } catch (err) {
      setErrorToast(`Kill switch failed: ${err.message}`);
    }
  };

  // Status Chip computations
  const poStateText = isGatewayDown
    ? "PO: DOWN"
    : controlState?.gateway?.last_message_age_secs > 60
    ? "PO: STALE"
    : "PO: OK";
  const poStateClass = isGatewayDown ? styles.chipError : controlState?.gateway?.last_message_age_secs > 60 ? styles.chipWarning : styles.chipSuccess;

  const sessionStatus = controlState?.gateway?.session || (isGatewayDown ? "disconnected" : "unknown");
  const sessionStateText = `SESSION: ${sessionStatus.toUpperCase()}`;
  const sessionStateClass =
    sessionStatus === "valid"
      ? styles.chipSuccess
      : sessionStatus === "connecting"
      ? styles.chipWarning
      : styles.chipError;

  const derivStateText = controlState?.deriv?.connected ? "DERIV: OK" : "DERIV: DOWN";
  const derivStateClass = controlState?.deriv?.connected ? styles.chipSuccess : styles.chipError;

  const rawBalance = account === "real"
    ? controlState?.balance?.real
    : controlState?.balance?.demo;
  const hasValidBalance = rawBalance != null && Number.isFinite(Number(rawBalance));
  const balanceDisplay = hasValidBalance
    ? `$${Number(rawBalance).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : "NO DATA";

  const profitVal = controlState?.today?.netProfit ?? 0;
  const profitStr = `${profitVal >= 0 ? "+" : ""}$${profitVal.toFixed(2)}`;
  const profitClass = profitVal > 0 ? styles.chipSuccess : profitVal < 0 ? styles.chipError : styles.chip;

  const tradesCount = controlState?.today?.tradesCount ?? 0;
  const maxTrades = controlState?.settings?.max_trades_per_day ?? 30;

  const streakLimit = controlState?.settings?.loss_streak_limit ?? 3;
  const lossStreak = controlState?.loss_streak ?? 0;

  return (
    <div className={styles.container}>
      {/* Top Row: Account + Mode Buttons + Actions */}
      <div className={styles.topRow}>
        {/* Account switcher */}
        <div className={styles.accountGroup} role="group" aria-label="Account selection">
          <button
            className={`${styles.accountBtn} ${account === "demo" ? styles.accountBtnActiveDemo : ""}`}
            onClick={() => handleSelectAccount("demo")}
            disabled={loadingAccount}
            title="Switch to Demo Practice Account"
          >
            🛡️ DEMO
          </button>
          <button
            className={`${styles.accountBtn} ${account === "real" ? styles.accountBtnActiveReal : ""}`}
            onClick={() => handleSelectAccount("real")}
            disabled={loadingAccount}
            title="Switch to Live Real-Money Account"
          >
            🔥 REAL
          </button>
          {account === "real" && (
            <span
              style={{
                backgroundColor: "#d13438",
                color: "#ffffff",
                fontWeight: "700",
                fontSize: "11px",
                padding: "3px 8px",
                borderRadius: "4px",
                letterSpacing: "0.5px",
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
                boxShadow: "0 0 10px rgba(209, 52, 56, 0.6)",
                border: "1px solid #a80000",
              }}
              title="Real-money trading is active"
            >
              ⚠️ REAL ACCOUNT
            </span>
          )}
        </div>

        {/* Mode buttons */}
        <div className={styles.modeGroup} role="group" aria-label="Trading Mode selection">
          {["OFF", "SIGNALS", "SEMI", "AUTO"].map((m) => {
            const isActive = mode === m;
            const activeClass = isActive ? styles[`modeBtnActive${m}`] : "";
            const stateLabel = controlState?.gateway?.session || (isGatewayDown ? "disconnected" : "unreachable");
            const isDisabled = loadingMode || ((m === "SEMI" || m === "AUTO") && (isPaused || !isSessionValid));
            return (
              <button
                key={m}
                className={`${styles.modeBtn} ${activeClass}`}
                onClick={() => handleSelectMode(m)}
                disabled={isDisabled}
                title={
                  (m === "SEMI" || m === "AUTO") && isPaused
                    ? "Disabled while trading is paused"
                    : (m === "SEMI" || m === "AUTO") && !isSessionValid
                    ? `Disabled while session is ${stateLabel}`
                    : `Set mode to ${m}`
                }
              >
                {loadingMode && isActive ? "⟳" : null}
                {m === "OFF" && "⏸ OFF"}
                {m === "SIGNALS" && "📡 SIGNALS"}
                {m === "SEMI" && "⚡ SEMI"}
                {m === "AUTO" && "🤖 AUTO"}
              </button>
            );
          })}
        </div>

        {/* Actions: Kill & Settings */}
        <div className={styles.actionGroup}>
          <button
            className={styles.killBtn}
            onClick={() => setShowKillModal(true)}
            title="Immediate emergency kill switch — stops all trading"
          >
            🛑 KILL
          </button>
          {onOpenSettings && (
            <button
              className={styles.settingsBtn}
              onClick={onOpenSettings}
              title="Open Guardrail & App Settings"
              aria-label="Settings"
            >
              ⚙️
            </button>
          )}
        </div>
      </div>

      {/* One-line mode description */}
      <div className={styles.modeDescRow}>
        <div className={styles.modeDesc}>{MODE_DESCRIPTIONS[mode] || ""}</div>
        {isPaused && (
          <div className={`${styles.statusNotice}`} style={{ color: "#f1707b" }}>
            ⚠️ PAUSED ({controlState?.pause_reason || "Guardrail"})
          </div>
        )}
      </div>

      {/* Status Chips Row */}
      <div className={styles.chipsRow}>
        <div className={`${styles.chip} ${poStateClass}`}>
          {poStateText}
        </div>
        <div className={`${styles.chip} ${sessionStateClass}`}>
          {sessionStateText}
        </div>
        <div className={`${styles.chip} ${derivStateClass}`}>
          {derivStateText}
        </div>
        <div className={`${styles.chip} ${styles.chipHighlight} ${account === "real" ? styles.chipError : styles.chipAccent}`}>
          💰 {balanceDisplay}
        </div>
        <div className={`${styles.chip} ${profitClass}`}>
          TODAY: {profitStr}
        </div>
        <div className={`${styles.chip} ${tradesCount >= maxTrades ? styles.chipWarning : ""}`}>
          TRADES: {tradesCount}/{maxTrades}
        </div>
        <div className={`${styles.chip} ${lossStreak > 0 ? (lossStreak >= streakLimit ? styles.chipError : styles.chipWarning) : styles.chipSuccess}`}>
          STREAK: {lossStreak}/{streakLimit} losses
        </div>
        <div className={`${styles.chip} ${isPaused ? styles.chipError : styles.chipSuccess}`}>
          {isPaused ? "⏸ PAUSED" : "▶ ACTIVE"}
        </div>
      </div>

      {/* Error Toast */}
      {errorToast && <div className={styles.toast}>❌ {errorToast}</div>}

      {/* ── Confirmation Modal: Switch to REAL Account ── */}
      {showRealModal && (
        <div className={styles.modalBackdrop} onClick={() => setShowRealModal(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalTitle}>
              <span>⚠️</span> CONFIRM REAL-MONEY TRADING
            </div>
            <div className={styles.modalBody}>
              <p>You are about to switch to the <strong>REAL Pocket Option account</strong>.</p>
              <div style={{ background: "rgba(0,0,0,0.3)", padding: "10px", borderRadius: "6px", margin: "10px 0" }}>
                <div>💵 <strong>Real Balance:</strong> {controlState?.balance?.real != null && Number.isFinite(Number(controlState.balance.real)) ? `$${Number(controlState.balance.real).toFixed(2)}` : "NO DATA"}</div>
                <div>🛑 <strong>Loss Streak Limit:</strong> {controlState?.settings?.loss_streak_limit ?? 3} losses</div>
                <div>🛡️ <strong>Max Stake Cap:</strong> ${controlState?.settings?.max_stake ?? 25.00}</div>
                <div>📊 <strong>Daily Loss Limit:</strong> ${controlState?.settings?.daily_loss_limit ?? 100.00}</div>
              </div>
              <p style={{ color: "#f1707b", fontSize: 12 }}>
                Orders will risk real capital. To confirm, please type <strong>REAL</strong> below:
              </p>
              <input
                className={styles.modalInput}
                type="text"
                placeholder='Type "REAL"'
                value={realInput}
                onChange={(e) => setRealInput(e.target.value.toUpperCase())}
                autoFocus
              />
            </div>
            <div className={styles.modalActions}>
              <button className={styles.modalBtnCancel} onClick={() => setShowRealModal(false)}>
                Cancel
              </button>
              <button
                className={styles.modalBtnDanger}
                disabled={realInput !== "REAL" || loadingAccount}
                onClick={() => executeAccountChange("real", realInput)}
              >
                {loadingAccount ? "Switching…" : "Confirm REAL Account"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Confirmation Modal: AUTO Mode ── */}
      {showAutoModal && (
        <div className={styles.modalBackdrop} onClick={() => setShowAutoModal(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalTitle}>
              <span>🤖</span> ENABLE FULL AUTO TRADING
            </div>
            <div className={styles.modalBody}>
              <p>
                In <strong>AUTO mode</strong>, every signal meeting your configured minimum tier (
                <strong>{controlState?.settings?.min_tier_for_auto || "B"}</strong>) and minimum payout (
                <strong>{controlState?.settings?.min_payout_pct || 80}%</strong>) will be placed immediately without confirmation.
              </p>
              <p style={{ color: "rgba(255,255,255,0.7)", fontSize: 12 }}>
                Server guardrails remain fully active: automatic stop at 3 consecutive losses, daily trade limit, and active-trade lock.
              </p>
            </div>
            <div className={styles.modalActions}>
              <button className={styles.modalBtnCancel} onClick={() => setShowAutoModal(false)}>
                Cancel
              </button>
              <button
                className={styles.modalBtnSuccess}
                onClick={() => {
                  if (typeof window !== "undefined") {
                    sessionStorage.setItem("signalex_auto_modal_confirmed", "true");
                  }
                  setShowAutoModal(false);
                  executeModeChange("AUTO");
                }}
              >
                I Understand — Enable AUTO
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Confirmation Modal: Emergency Kill Switch ── */}
      {showKillModal && (
        <div className={styles.modalBackdrop} onClick={() => setShowKillModal(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalTitle}>
              <span>🛑</span> ENGAGE EMERGENCY KILL SWITCH
            </div>
            <div className={styles.modalBody}>
              <p>
                This will immediately:
              </p>
              <ul style={{ paddingLeft: 18, margin: "8px 0", fontSize: 12, lineHeight: 1.6 }}>
                <li>Set mode to <strong>OFF</strong></li>
                <li>Cancel all pending SEMI confirmations</li>
                <li>Instruct Pocket Option Gateway to reject any new orders</li>
                <li>Audit log the emergency stop event</li>
              </ul>
              <p style={{ fontSize: 12, color: "rgba(255,255,255,0.6)" }}>
                Any currently open orders on the broker will be tracked to expiry normally.
              </p>
            </div>
            <div className={styles.modalActions}>
              <button className={styles.modalBtnCancel} onClick={() => setShowKillModal(false)}>
                Cancel
              </button>
              <button className={styles.modalBtnDanger} onClick={handleExecuteKill}>
                STOP ALL TRADING NOW
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
