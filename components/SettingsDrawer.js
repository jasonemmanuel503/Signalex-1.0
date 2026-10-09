"use client";

import { useState, useEffect } from "react";
import styles from "./SettingsDrawer.module.css";

export default function SettingsDrawer({
  isOpen,
  onClose,
  currentSettings = {},
  onSettingsSaved,
}) {
  const [formData, setFormData] = useState({
    loss_streak_limit: 3,
    max_stake: 25.0,
    stake_mode: "fixed",
    stake_value: 10.0,
    max_trades_per_day: 30,
    daily_loss_limit: 100.0,
    min_payout_pct: 80,
    min_tier_for_auto: "B",
    max_signal_age_secs: 3,
    max_data_age_secs: 120,
    trading_hours_filter: "off",
  });
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null);

  useEffect(() => {
    if (currentSettings) {
      setFormData((prev) => ({
        ...prev,
        ...currentSettings,
      }));
    }
  }, [currentSettings, isOpen]);

  if (!isOpen) return null;

  const handleChange = (field, value) => {
    setFormData((prev) => ({
      ...prev,
      [field]: value,
    }));
  };

  const handleSave = async () => {
    setSaving(true);
    setToast(null);

    // Client-side validations
    const streak = parseInt(formData.loss_streak_limit, 10);
    if (isNaN(streak) || streak < 1 || streak > 5) {
      setToast({ type: "error", msg: "Loss streak limit must be between 1 and 5 (hard cap: 5)." });
      setSaving(false);
      return;
    }

    const stakeCap = parseFloat(formData.max_stake);
    if (isNaN(stakeCap) || stakeCap <= 0 || stakeCap > 50.0) {
      setToast({ type: "error", msg: "Max stake cannot exceed $50.00 hard cap." });
      setSaving(false);
      return;
    }

    const patch = {
      loss_streak_limit: streak,
      max_stake: stakeCap,
      stake_mode: formData.stake_mode,
      stake_value: parseFloat(formData.stake_value) || 10.0,
      max_trades_per_day: parseInt(formData.max_trades_per_day, 10) || 30,
      daily_loss_limit: parseFloat(formData.daily_loss_limit) || 100.0,
      min_payout_pct: parseInt(formData.min_payout_pct, 10) || 80,
      min_tier_for_auto: formData.min_tier_for_auto || "B",
      max_signal_age_secs: parseInt(formData.max_signal_age_secs, 10) || 3,
      max_data_age_secs: parseInt(formData.max_data_age_secs, 10) || 120,
      trading_hours_filter: formData.trading_hours_filter || "off",
    };

    try {
      const res = await fetch("/api/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update_settings", settings: patch }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || "Failed to update settings");
      }
      setToast({ type: "success", msg: "Settings saved to Supabase & engine!" });
      if (onSettingsSaved) onSettingsSaved(data.settings);
      setTimeout(() => {
        onClose();
      }, 1000);
    } catch (err) {
      setToast({ type: "error", msg: err.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div className={styles.drawer} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className={styles.header}>
          <div className={styles.title}>
            <span>⚙️</span> GUARDRAILS & SETTINGS
          </div>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close settings">
            ✕
          </button>
        </div>

        {/* Content */}
        <div className={styles.content}>
          {toast && (
            <div className={`${styles.toast} ${toast.type === "success" ? styles.toastSuccess : styles.toastError}`}>
              {toast.msg}
            </div>
          )}

          {/* Capital Preservation & Streak Limits */}
          <div className={styles.section}>
            <div className={styles.sectionTitle}>Capital Preservation Guardrails</div>

            <div className={styles.field}>
              <div className={styles.labelRow}>
                <label className={styles.label}>Loss Streak Limit</label>
                <span className={styles.hardCap}>HARD CAP: 5</span>
              </div>
              <input
                className={styles.input}
                type="number"
                min="1"
                max="5"
                value={formData.loss_streak_limit}
                onChange={(e) => handleChange("loss_streak_limit", e.target.value)}
              />
              <span className={styles.helper}>
                Automatically pauses trading and demotes mode to SIGNALS when hit. Requires manual resume.
              </span>
            </div>

            <div className={styles.field}>
              <div className={styles.labelRow}>
                <label className={styles.label}>Max Stake per Trade ($)</label>
                <span className={styles.hardCap}>HARD CAP: $50.00</span>
              </div>
              <input
                className={styles.input}
                type="number"
                step="0.5"
                min="1"
                max="50"
                value={formData.max_stake}
                onChange={(e) => handleChange("max_stake", e.target.value)}
              />
              <span className={styles.helper}>
                Server-enforced ceiling. Orders exceeding this are rejected at the gateway.
              </span>
            </div>

            <div className={styles.field}>
              <label className={styles.label}>Daily Loss Limit ($)</label>
              <input
                className={styles.input}
                type="number"
                step="5"
                min="10"
                value={formData.daily_loss_limit}
                onChange={(e) => handleChange("daily_loss_limit", e.target.value)}
              />
              <span className={styles.helper}>
                Pauses trading for the remainder of the calendar day when cumulative losses reach this limit.
              </span>
            </div>

            <div className={styles.field}>
              <label className={styles.label}>Max Trades per Day</label>
              <input
                className={styles.input}
                type="number"
                min="1"
                max="100"
                value={formData.max_trades_per_day}
                onChange={(e) => handleChange("max_trades_per_day", e.target.value)}
              />
              <span className={styles.helper}>
                Replaces old session-based limits. Prevents overtrading across all pairs.
              </span>
            </div>
          </div>

          {/* Sizing & Execution Mode */}
          <div className={styles.section}>
            <div className={styles.sectionTitle}>Position Sizing Rules</div>

            <div className={styles.field}>
              <label className={styles.label}>Stake Mode</label>
              <select
                className={styles.select}
                value={formData.stake_mode}
                onChange={(e) => handleChange("stake_mode", e.target.value)}
              >
                <option value="fixed">Fixed Dollar Amount ($)</option>
                <option value="percent">Percentage of Account Balance (%)</option>
              </select>
            </div>

            <div className={styles.field}>
              <label className={styles.label}>
                {formData.stake_mode === "fixed" ? "Stake Value ($)" : "Stake Value (% of Balance)"}
              </label>
              <input
                className={styles.input}
                type="number"
                step="0.5"
                min="1"
                value={formData.stake_value}
                onChange={(e) => handleChange("stake_value", e.target.value)}
              />
              <span className={styles.helper}>
                Martingale is strictly prohibited. Stake never increases after a loss.
              </span>
            </div>
          </div>

          {/* Signal Quality & Broker Filters */}
          <div className={styles.section}>
            <div className={styles.sectionTitle}>Signal Quality & Filters</div>

            <div className={styles.field}>
              <label className={styles.label}>Minimum Payout (%)</label>
              <input
                className={styles.input}
                type="number"
                min="60"
                max="95"
                value={formData.min_payout_pct}
                onChange={(e) => handleChange("min_payout_pct", e.target.value)}
              />
              <span className={styles.helper}>
                Blocks signals and orders when asset payout on Pocket Option falls below this threshold.
              </span>
            </div>

            <div className={styles.field}>
              <label className={styles.label}>Minimum Tier for AUTO Mode</label>
              <select
                className={styles.select}
                value={formData.min_tier_for_auto}
                onChange={(e) => handleChange("min_tier_for_auto", e.target.value)}
              >
                <option value="A">Tier A Only (Highest confidence)</option>
                <option value="B">Tier B & Tier A (Standard default)</option>
              </select>
              <span className={styles.helper}>
                Tier C signals are shown in SIGNALS mode only and are never auto-executed.
              </span>
            </div>

            <div className={styles.field}>
              <label className={styles.label}>Max Signal Age (seconds)</label>
              <input
                className={styles.input}
                type="number"
                min="1"
                max="10"
                value={formData.max_signal_age_secs}
                onChange={(e) => handleChange("max_signal_age_secs", e.target.value)}
              />
              <span className={styles.helper}>
                Rejects orders if latency from candle close to execution exceeds this limit.
              </span>
            </div>

            <div className={styles.field}>
              <label className={styles.label}>Trading Hours Filter</label>
              <select
                className={styles.select}
                value={formData.trading_hours_filter}
                onChange={(e) => handleChange("trading_hours_filter", e.target.value)}
              >
                <option value="off">Off — Trade 24/7 when opportunities appear</option>
                <option value="london_ny">London & NY Overlap Only</option>
              </select>
              <span className={styles.helper}>
                Session windows are descriptive labels. OTC trades continue 24/7.
              </span>
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div className={styles.footer}>
          <button className={styles.cancelBtn} onClick={onClose}>
            Cancel
          </button>
          <button className={styles.saveBtn} onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : "Save Settings"}
          </button>
        </div>
      </div>
    </div>
  );
}
