// ═══════════════════════════════════════════════════════════════════════════════
// SIGNALEX V10 — Trading Orchestrator & Execution Engine
// State Machine (OFF | SIGNALS | SEMI | AUTO)
// Server-Side Guardrails, Order Dispatcher & Restart Safety
// ═══════════════════════════════════════════════════════════════════════════════

import {
  getAppSettings,
  updateAppSettings,
  writeAuditLog,
  saveTrade,
  updateTradeResultDb,
  getTradeHistory,
  createPendingConfirmation,
  getPendingConfirmations,
  updatePendingConfirmationState,
} from "../store/index.js";
import { getAssetsFromGateway, normalizePair } from "./priceResolver.js";

const PO_GATEWAY_URL = process.env.PO_GATEWAY_URL || "http://127.0.0.1:8002";
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN || "dev_internal_token_signalex_2026";
const MAX_STAKE_HARD_CAP = parseFloat(process.env.MAX_STAKE_HARD_CAP || "50.0");

class TradingOrchestrator {
  constructor() {
    this.initialized = false;
    this.killActive = false;
    this.instanceId = Math.random().toString(36).slice(2, 10);
    console.log(`[Orchestrator] Initialized TradingOrchestrator instance id=${this.instanceId}`);
    this.state = {
      mode: "SIGNALS", // Restart safety default
      account: "demo",
      trading_paused: false,
      pause_reason: null,
      consecutive_losses: { demo: 0, real: 0 },
      last_order_at: 0,
      active_deals: new Map(),
    };
    this.init();
  }

  /**
   * Section 7.1 Restart safety:
   * When the Next.js server boots or reboots, mode MUST drop to SIGNALS,
   * even if it was previously SEMI or AUTO in Supabase.
   */
  async init() {
    if (this.initialized) return;
    this.initialized = true;

    const currentSettings = getAppSettings();
    const prevMode = currentSettings.mode;

    // Enforce restart safety: drop to SIGNALS if it was AUTO or SEMI
    if (prevMode === "AUTO" || prevMode === "SEMI") {
      updateAppSettings({ mode: "SIGNALS" });
      this.state.mode = "SIGNALS";
      writeAuditLog("system", "restart_safety_demote", {
        reason: "Server startup restart safety enforced — dropped mode to SIGNALS",
        previous_mode: prevMode,
        current_mode: "SIGNALS",
      });
      console.warn(`[Orchestrator] Restart safety engaged: mode dropped from ${prevMode} to SIGNALS`);
    } else {
      this.state.mode = currentSettings.mode || "SIGNALS";
    }

    this.state.account = currentSettings.account || "demo";
    this.state.trading_paused = Boolean(currentSettings.trading_paused);
    this.state.pause_reason = currentSettings.pause_reason || null;

    // Calculate current consecutive loss streak from history
    this.recalcLossStreak("demo");
    this.recalcLossStreak("real");
  }

  recalcLossStreak(account = "demo") {
    const history = getTradeHistory(30).filter((t) => t.account === account && t.result);
    let streak = 0;
    for (const t of history) {
      if (t.result === "LOSS") streak++;
      else if (t.result === "WIN" || t.result === "TIE") break;
    }
    this.state.consecutive_losses[account] = streak;
    return streak;
  }

  getState() {
    return {
      ...this.state,
      kill_active: this.killActive,
      settings: getAppSettings(),
    };
  }

  // ── Mode & Account Control (with full audit logging) ───────────────────────
  async setMode(newMode, actor = "user", meta = {}) {
    const validModes = ["OFF", "SIGNALS", "SEMI", "AUTO"];
    if (!validModes.includes(newMode)) {
      throw new Error(`Invalid mode: ${newMode}`);
    }

    const prevMode = this.state.mode;
    if (prevMode === newMode) return this.getState();

    // If attempting to enter SEMI or AUTO while paused or killed, reject
    if ((newMode === "SEMI" || newMode === "AUTO") && (this.state.trading_paused || this.killActive)) {
      throw new Error(`Cannot switch to ${newMode} while trading is paused (${this.state.pause_reason || "KILL"})`);
    }

    // Fail-closed gating: entering SEMI or AUTO requires live, authorized broker connection
    if (newMode === "SEMI" || newMode === "AUTO") {
      try {
        const healthRes = await fetch(`${PO_GATEWAY_URL}/health`, {
          headers: { "X-Internal-Token": INTERNAL_API_TOKEN },
          signal: AbortSignal.timeout(3000),
        });
        if (!healthRes.ok) {
          throw new Error(`Gateway health check failed (HTTP ${healthRes.status})`);
        }
        const healthData = await healthRes.json();
        if (healthData?.connected !== true || healthData?.session !== "valid") {
          const sessionState = healthData?.session || "disconnected";
          throw new Error(`Cannot switch to ${newMode}: Pocket Option broker is ${sessionState}`);
        }
      } catch (err) {
        throw new Error(`Cannot switch to ${newMode}: ${err.message}`);
      }
    }

    this.state.mode = newMode;
    updateAppSettings({ mode: newMode });

    writeAuditLog(actor, "mode_change", {
      from: prevMode,
      to: newMode,
      ...meta,
    });

    console.log(`[Orchestrator] Mode changed by ${actor}: ${prevMode} -> ${newMode}`);
    return this.getState();
  }

  async setAccount(newAccount, actor = "user", meta = {}) {
    const validAccounts = ["demo", "real"];
    if (!validAccounts.includes(newAccount)) {
      throw new Error(`Invalid account: ${newAccount}`);
    }

    if (newAccount === "real") {
      if (meta.confirm !== "REAL") {
        throw new Error('Switching to REAL account requires confirmation confirm: "REAL"');
      }
      try {
        const hRes = await fetch(`${PO_GATEWAY_URL}/health`, {
          headers: { "X-Internal-Token": INTERNAL_API_TOKEN },
          signal: AbortSignal.timeout(3000),
        });
        if (!hRes.ok) {
          throw new Error("Gateway health check failed");
        }
        const hData = await hRes.json();
        const realAcc = hData?.accounts?.real;
        if (!realAcc || realAcc.connected !== true || realAcc.session !== "valid") {
          const reason = realAcc?.status === "not_configured"
            ? "Real credentials are not configured"
            : `Real connection status is ${realAcc?.status || "disconnected"}, session: ${realAcc?.session || "invalid"}`;
          throw new Error(`Cannot switch to REAL account: ${reason}`);
        }
      } catch (e) {
        throw new Error(`Cannot switch to REAL account: ${e.message}`);
      }
    }

    const prevAccount = this.state.account;
    if (prevAccount === newAccount) return this.getState();

    this.state.account = newAccount;
    updateAppSettings({ account: newAccount });

    writeAuditLog(actor, "account_change", {
      from: prevAccount,
      to: newAccount,
      ...meta,
    });

    console.log(`[Orchestrator] Account changed by ${actor}: ${prevAccount} -> ${newAccount}`);
    return this.getState();
  }

  cancelPendingConfirmations(reason = "cancelled") {
    let cancelledCount = 0;
    try {
      const pendings = getPendingConfirmations("pending");
      for (const p of pendings) {
        try {
          updatePendingConfirmationState(p.id, "skipped");
          cancelledCount++;
        } catch (err) {
          console.warn(`[Orchestrator] Error cancelling pending trade ${p.id}:`, err.message);
        }
      }
    } catch (e) {
      console.warn("[Orchestrator] Error querying pending trades to cancel:", e.message);
    }
    return cancelledCount;
  }

  async triggerKill(actor = "user", reason = "Manual kill switch engaged", meta = {}) {
    this.killActive = true;
    this.state.trading_paused = true;
    this.state.pause_reason = reason;
    this.state.mode = "OFF";

    updateAppSettings({
      trading_paused: true,
      pause_reason: reason,
      mode: "OFF",
    });

    // Cancel all pending confirmations
    this.cancelPendingConfirmations(reason);

    // Notify PO gateway to block all further orders
    try {
      await fetch(`${PO_GATEWAY_URL}/kill`, {
        method: "POST",
        headers: { "X-Internal-Token": INTERNAL_API_TOKEN },
        signal: AbortSignal.timeout(3000),
      });
    } catch (e) {
      console.warn("[Orchestrator] Failed to notify PO gateway of kill switch:", e.message);
    }

    writeAuditLog(actor, "kill", { reason, ...meta });
    console.warn(`[Orchestrator] KILL SWITCH ENGAGED by ${actor}: ${reason}`);
    return this.getState();
  }

  async resumeTrading(actor = "user", meta = {}) {
    this.killActive = false;
    this.state.trading_paused = false;
    this.state.pause_reason = null;
    this.state.consecutive_losses[this.state.account] = 0;

    updateAppSettings({
      trading_paused: false,
      pause_reason: null,
    });

    writeAuditLog(actor, "resume", { ...meta });
    console.log(`[Orchestrator] Trading resumed by ${actor}`);
    return this.getState();
  }

  // ── Guardrails Validation ──────────────────────────────────────────────────
  async validateOrderGuardrails(signal, isUserConfirmed = false) {
    const settings = getAppSettings();
    const account = this.state.account;

    // 1. Trading paused check
    if (this.state.trading_paused || settings.trading_paused) {
      return { valid: false, reason: `Trading is paused: ${this.state.pause_reason || settings.pause_reason}` };
    }

    // 2. Kill flag check
    if (this.killActive) {
      return { valid: false, reason: "Kill switch is active" };
    }

    // 3. Mode check
    if (this.state.mode === "OFF" || this.state.mode === "SIGNALS") {
      return { valid: false, reason: `Mode is ${this.state.mode} — order execution disabled` };
    }
    if (this.state.mode === "SEMI" && !isUserConfirmed) {
      return { valid: false, reason: "SEMI mode requires user confirmation" };
    }

    // 4. Signal tier check (min_tier_for_auto, default B; Tier C is never auto-traded)
    const tier = signal.tier || signal.signalTier || "C";
    if (tier === "C" || tier === "SKIP") {
      return { valid: false, reason: `Tier ${tier} is ineligible for auto/semi trading` };
    }
    const minTier = settings.min_tier_for_auto || "B";
    if (minTier === "A" && tier !== "A") {
      return { valid: false, reason: `Tier ${tier} below min_tier_for_auto (${minTier})` };
    }

    // 5. Signal age check (default max 3 seconds)
    const signalTimeMs = signal.createdAt
      ? (typeof signal.createdAt === "number" ? signal.createdAt : new Date(signal.createdAt).getTime())
      : signal.signalTime
      ? (typeof signal.signalTime === "number" ? signal.signalTime : new Date(signal.signalTime).getTime())
      : Date.now();
    const signalAgeSecs = (Date.now() - signalTimeMs) / 1000;
    const maxSignalAge = Number(settings.max_signal_age_secs || 3);
    if (signalAgeSecs > maxSignalAge) {
      return { valid: false, reason: `Signal age (${signalAgeSecs.toFixed(1)}s) exceeds max ${maxSignalAge}s` };
    }

    // 6. Market data age check (default max 120 seconds)
    const dataAgeSecs = Number(signal.ageSeconds || 0);
    const maxDataAge = Number(settings.max_data_age_secs || 120);
    if (dataAgeSecs > maxDataAge) {
      return { valid: false, reason: `Market data age (${dataAgeSecs}s) exceeds max ${maxDataAge}s` };
    }

    // 7. Three consecutive losses check
    const currentLossStreak = this.recalcLossStreak(account);
    const streakLimit = Number(settings.loss_streak_limit || 3);
    if (currentLossStreak >= streakLimit) {
      this.state.trading_paused = true;
      this.state.pause_reason = `${streakLimit} consecutive losses`;
      this.state.mode = "SIGNALS";
      updateAppSettings({ trading_paused: true, pause_reason: this.state.pause_reason, mode: "SIGNALS" });
      writeAuditLog("system", "auto_pause", {
        reason: `${streakLimit} consecutive losses`,
        streak: currentLossStreak,
      });
      return { valid: false, reason: this.state.pause_reason };
    }

    // 8. Daily loss limit check
    const todayStartMs = new Date().setHours(0, 0, 0, 0);
    const todayTrades = getTradeHistory(100).filter(
      (t) => t.account === account && new Date(t.sent_at || 0).getTime() >= todayStartMs
    );
    let todayLossSum = 0;
    for (const t of todayTrades) {
      if (t.result === "LOSS") todayLossSum += Math.abs(t.profit || t.stake || 0);
    }
    if (todayLossSum >= Number(settings.daily_loss_limit || 100.0)) {
      this.state.trading_paused = true;
      this.state.pause_reason = `Daily loss limit ($${settings.daily_loss_limit}) reached`;
      this.state.mode = "SIGNALS";
      updateAppSettings({ trading_paused: true, pause_reason: this.state.pause_reason, mode: "SIGNALS" });
      writeAuditLog("system", "auto_pause", { reason: this.state.pause_reason, loss_sum: todayLossSum });
      return { valid: false, reason: this.state.pause_reason };
    }

    // 9. Max trades per day check
    if (todayTrades.length >= Number(settings.max_trades_per_day || 30)) {
      return { valid: false, reason: `Daily trades limit (${settings.max_trades_per_day}) reached` };
    }

    // 10. Idempotency check: signal_id must not have been sent before
    const existing = getTradeHistory(200).find((t) => t.signal_id === signal.id);
    if (existing) {
      return { valid: false, reason: `Signal ${signal.id} has already been traded` };
    }

    // 11. Asset open & payout floor check
    const assets = await getAssetsFromGateway();
    const { poAsset } = normalizePair(signal.pair);
    const assetMeta = assets.get(poAsset);

    if (!assetMeta || !assetMeta.open) {
      return { valid: false, reason: `Asset ${signal.pair} (${poAsset}) is closed or unavailable` };
    }
    const minPayout = Number(settings.min_payout_pct || 80);
    if (assetMeta.payout_pct < minPayout) {
      return { valid: false, reason: `Payout ${assetMeta.payout_pct}% below required ${minPayout}%` };
    }

    // 12. Stake calculation & hard caps
    let calculatedStake = Number(settings.stake_value || 10.0);
    if (settings.stake_mode === "percent") {
      // Calculate from gateway balance
      let currentBal = null;
      try {
        const balRes = await fetch(`${PO_GATEWAY_URL}/balance?account=${account}`, {
          headers: { "X-Internal-Token": INTERNAL_API_TOKEN },
          signal: AbortSignal.timeout(3000),
        });
        if (balRes.ok) {
          const balData = await balRes.json();
          if (balData.balance != null && Number.isFinite(Number(balData.balance))) {
            currentBal = Number(balData.balance);
          }
        }
      } catch (e) {
        console.warn("[Orchestrator] Balance read warning:", e.message);
      }
      if (currentBal === null) {
        return { valid: false, reason: "Balance unavailable" };
      }
      calculatedStake = Number(((currentBal * (settings.stake_value / 100.0))).toFixed(2));
    }

    // Cap by settings.max_stake and MAX_STAKE_HARD_CAP
    const allowedMax = Math.min(Number(settings.max_stake || 25.0), MAX_STAKE_HARD_CAP);
    if (calculatedStake > allowedMax) {
      calculatedStake = allowedMax;
    }
    if (calculatedStake <= 0) {
      return { valid: false, reason: `Calculated stake ${calculatedStake} is invalid` };
    }

    // 13. Broker gateway health and session check
    try {
      const healthRes = await fetch(`${PO_GATEWAY_URL}/health`, {
        headers: { "X-Internal-Token": INTERNAL_API_TOKEN },
        signal: AbortSignal.timeout(3000),
      });
      if (!healthRes.ok) return { valid: false, reason: `PO Gateway error ${healthRes.status}` };
      const healthData = await healthRes.json();
      if (!healthData.connected || healthData.session !== "valid") {
        return { valid: false, reason: `Broker session is not valid (${healthData.session})` };
      }
    } catch (e) {
      return { valid: false, reason: `Broker gateway connection error: ${e.message}` };
    }

    return {
      valid: true,
      stake: calculatedStake,
      payout_pct: assetMeta.payout_pct,
      poAsset,
    };
  }

  // ── Order Dispatching ──────────────────────────────────────────────────────
  async dispatchOrder(signal, source = "auto", isUserConfirmed = false) {
    const validation = await this.validateOrderGuardrails(signal, isUserConfirmed);
    if (!validation.valid) {
      console.warn(`[Orchestrator] Order rejected for ${signal.pair}: ${validation.reason}`);
      writeAuditLog("engine", "order_rejected", {
        signal_id: signal.id,
        pair: signal.pair,
        reason: validation.reason,
      });
      return { success: false, reason: validation.reason };
    }

    const { stake, payout_pct, poAsset } = validation;
    const account = this.state.account;
    const tradeId = `tr_${Date.now()}_${signal.id}`;
    const expirySecs = Number(signal.expirySecs || signal.expiry || 60);

    // Initial intent record in store
    saveTrade({
      id: tradeId,
      signalId: signal.id,
      account,
      source,
      pair: signal.pair,
      market: signal.market || (signal.pair.includes("OTC") ? "otc" : "forex"),
      direction: signal.direction,
      positionSize: stake,
      payout_pct,
      expirySecs,
      signalPrice: signal.entryPrice || signal.signal_price,
      entryTimestamp: Date.now(),
      result: null,
      session: signal.session || "ACTIVE",
      signalTier: signal.tier || signal.signalTier || "B",
    });

    writeAuditLog("engine", "order_sent", {
      trade_id: tradeId,
      signal_id: signal.id,
      account,
      pair: signal.pair,
      direction: signal.direction,
      stake,
      payout_pct,
    });

    // Send order to po-gateway
    const t0 = Date.now();
    let gatewayRes;
    try {
      const res = await fetch(`${PO_GATEWAY_URL}/orders`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Token": INTERNAL_API_TOKEN,
        },
        body: JSON.stringify({
          idempotency_key: signal.id,
          signal_id: signal.id,
          account,
          pair: poAsset,
          direction: signal.direction,
          stake,
          expiry_secs: expirySecs,
          signal_price: signal.entryPrice,
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.detail || `Gateway returned HTTP ${res.status}`);
      }

      gatewayRes = await res.json();
    } catch (err) {
      console.error(`[Orchestrator] Order dispatch failed for ${tradeId}:`, err.message);
      updateTradeResultDb(tradeId, "REJECTED", null);
      writeAuditLog("engine", "order_failed", { trade_id: tradeId, error: err.message });
      return { success: false, reason: err.message };
    }

    const latencyMs = Date.now() - t0;
    const confirmedEntryPrice = gatewayRes.entry_price || signal.entryPrice;
    const slippage = signal.entryPrice ? Number((confirmedEntryPrice - signal.entryPrice).toFixed(6)) : 0;

    // Update trade confirmation in store
    saveTrade({
      id: tradeId,
      signalId: signal.id,
      account,
      source,
      pair: signal.pair,
      market: signal.market || (signal.pair.includes("OTC") ? "otc" : "forex"),
      direction: signal.direction,
      positionSize: stake,
      payout_pct: gatewayRes.payout_pct || payout_pct,
      expirySecs,
      entryPrice: confirmedEntryPrice,
      poDealId: gatewayRes.deal_id,
      latency_ms: latencyMs,
      slippage,
      entryTimestamp: Date.now(),
      confirmed_at: new Date().toISOString(),
    });

    // Spawn background tracker to poll for real broker result
    this.trackDealOutcome(tradeId, gatewayRes.deal_id, expirySecs, account);

    return {
      success: true,
      tradeId,
      dealId: gatewayRes.deal_id,
      entryPrice: confirmedEntryPrice,
      latencyMs,
      slippage,
    };
  }

  // ── Background Deal Tracking ───────────────────────────────────────────────
  trackDealOutcome(tradeId, dealId, expirySecs, account) {
    const timeoutSecs = expirySecs + 90;
    const startMs = Date.now();

    const interval = setInterval(async () => {
      try {
        const elapsedSecs = (Date.now() - startMs) / 1000;

        const res = await fetch(`${PO_GATEWAY_URL}/orders/${dealId}`, {
          headers: { "X-Internal-Token": INTERNAL_API_TOKEN },
          signal: AbortSignal.timeout(4000),
        });

        if (res.ok) {
          const order = await res.json();
          if (order && order.status === "CLOSED" && order.result) {
            clearInterval(interval);
            console.log(`[Orchestrator] Trade ${tradeId} closed: ${order.result} | Exit: ${order.exit_price}`);
            updateTradeResultDb(tradeId, order.result, order.exit_price);

            // Re-evaluate consecutive losses
            const streak = this.recalcLossStreak(account);
            const settings = getAppSettings();
            if (streak >= (settings.loss_streak_limit || 3)) {
              this.state.trading_paused = true;
              this.state.pause_reason = "3 consecutive losses";
              this.state.mode = "SIGNALS";
              updateAppSettings({ trading_paused: true, pause_reason: this.state.pause_reason, mode: "SIGNALS" });
              writeAuditLog("system", "auto_pause", {
                reason: "3 consecutive losses",
                trade_id: tradeId,
                streak,
              });
              console.warn(`[Orchestrator] 3 consecutive losses hit! Auto-paused trading.`);
            }
            return;
          }
        }

        // Timeout reached without confirmation
        if (elapsedSecs >= timeoutSecs) {
          clearInterval(interval);
          console.warn(`[Orchestrator] Trade ${tradeId} deal ${dealId} unconfirmed after ${timeoutSecs}s`);
          updateTradeResultDb(tradeId, "UNCONFIRMED", null);
        }
      } catch (e) {
        console.debug(`[Orchestrator] Deal outcome polling error (${dealId}):`, e.message);
      }
    }, 4000);

    if (interval && interval.unref) interval.unref();
  }

  // ── SEMI Mode Countdown Flow ───────────────────────────────────────────────
  createPendingTrade(signal) {
    if (this.state.mode !== "SEMI") return null;
    if (this.state.trading_paused || this.killActive) return null;

    // Check tier
    const tier = signal.tier || signal.signalTier;
    if (tier === "C" || tier === "SKIP") return null;

    return createPendingConfirmation(signal.id, signal, 20); // 20-second countdown
  }

  async confirmPendingTrade(confirmationId, actor = "user") {
    const list = getPendingConfirmations("pending");
    const conf = list.find((c) => c.id === confirmationId);
    if (!conf) throw new Error("Pending trade not found or already expired");

    const now = Date.now();
    if (new Date(conf.expires_at).getTime() <= now) {
      updatePendingConfirmationState(conf.id, "expired");
      throw new Error("Pending confirmation countdown has expired (20s exceeded)");
    }

    updatePendingConfirmationState(conf.id, "executed");
    const result = await this.dispatchOrder(conf.payload, "semi", true);
    return result;
  }

  skipPendingTrade(confirmationId) {
    return updatePendingConfirmationState(confirmationId, "skipped");
  }
}

const g = globalThis;
if (!g.__signalexOrchestrator) g.__signalexOrchestrator = new TradingOrchestrator();
export const orchestrator = g.__signalexOrchestrator;
export default orchestrator;
