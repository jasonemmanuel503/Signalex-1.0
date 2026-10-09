#!/usr/bin/env node
import assert from "assert";
import { orchestrator } from "../lib/trading/orchestrator.js";
import { updateAppSettings, getAppSettings, getAuditLogs, saveTrade, updateTradeResultDb } from "../lib/store/index.js";

async function testOrchestrator() {
  console.log("Running Trading Orchestrator & Guardrails Unit Tests...");

  // 1. Initial Mode & Restart Safety
  const state = orchestrator.getState();
  assert.strictEqual(state.mode, "SIGNALS", "Default or restart mode must be SIGNALS");
  assert.strictEqual(state.account, "demo", "Default account should be demo");

  // 2. Mode Transitions & Audit Log
  await orchestrator.setMode("SIGNALS", "test_user");
  assert.strictEqual(orchestrator.getState().mode, "SIGNALS");

  await orchestrator.setMode("SEMI", "test_user");
  assert.strictEqual(orchestrator.getState().mode, "SEMI");

  await orchestrator.setMode("AUTO", "test_user");
  assert.strictEqual(orchestrator.getState().mode, "AUTO");

  const auditLogs = getAuditLogs();
  assert.ok(auditLogs.some((l) => l.action === "mode_change" && l.details.to === "AUTO"));

  // Invalid mode throws error
  await assert.rejects(
    async () => orchestrator.setMode("INVALID_MODE"),
    /Invalid mode/
  );

  // 3. Kill Switch Engagement
  await orchestrator.triggerKill("test_user", "Emergency test kill");
  const killState = orchestrator.getState();
  assert.strictEqual(killState.kill_active, true);
  assert.strictEqual(killState.trading_paused, true);
  assert.strictEqual(killState.mode, "OFF", "Kill switch must set mode to OFF");

  // While killed, switching to AUTO or SEMI must be rejected
  await assert.rejects(
    async () => orchestrator.setMode("AUTO"),
    /Cannot switch to AUTO while trading is paused/
  );

  // Resume trading
  await orchestrator.resumeTrading("test_user");
  assert.strictEqual(orchestrator.getState().kill_active, false);
  assert.strictEqual(orchestrator.getState().trading_paused, false);

  // 4. Guardrail: Tier C rejection
  await orchestrator.setMode("AUTO");
  const tierCSig = {
    id: `sig_tier_c_${Date.now()}`,
    pair: "EURUSD",
    direction: "CALL",
    tier: "C",
    confidence: 65,
    entryPrice: 1.085,
    expirySecs: 60,
    createdAt: Date.now(),
  };
  const valTierC = await orchestrator.validateOrderGuardrails(tierCSig);
  assert.strictEqual(valTierC.valid, false);
  assert.ok(valTierC.reason.includes("Tier C is ineligible"));

  // 5. Guardrail: Stale Signal rejection (> 3s)
  const staleSig = {
    id: `sig_stale_${Date.now()}`,
    pair: "EURUSD",
    direction: "CALL",
    tier: "A",
    confidence: 88,
    entryPrice: 1.085,
    expirySecs: 60,
    createdAt: Date.now() - 5000, // 5 seconds ago > 3s
  };
  const valStale = await orchestrator.validateOrderGuardrails(staleSig);
  assert.strictEqual(valStale.valid, false);
  assert.ok(valStale.reason.includes("Signal age"));

  // 6. Guardrail: Three Consecutive Losses
  console.log("Testing 3 consecutive losses rule...");
  // Record 3 consecutive losses for test
  const t1 = `test_loss_1_${Date.now()}`;
  const t2 = `test_loss_2_${Date.now()}`;
  const t3 = `test_loss_3_${Date.now()}`;

  saveTrade({ id: t1, pair: "EURUSD", account: "demo", direction: "CALL", stake: 10, sent_at: new Date(Date.now() - 30000).toISOString() });
  updateTradeResultDb(t1, "LOSS");

  saveTrade({ id: t2, pair: "EURUSD", account: "demo", direction: "CALL", stake: 10, sent_at: new Date(Date.now() - 20000).toISOString() });
  updateTradeResultDb(t2, "LOSS");

  saveTrade({ id: t3, pair: "EURUSD", account: "demo", direction: "CALL", stake: 10, sent_at: new Date(Date.now() - 10000).toISOString() });
  updateTradeResultDb(t3, "LOSS");

  const validSig = {
    id: `sig_valid_${Date.now()}`,
    pair: "EURUSD",
    direction: "CALL",
    tier: "A",
    confidence: 88,
    entryPrice: 1.085,
    expirySecs: 60,
    createdAt: Date.now(),
  };

  const valStreak = await orchestrator.validateOrderGuardrails(validSig);
  assert.strictEqual(valStreak.valid, false);
  assert.ok(valStreak.reason.includes("3 consecutive losses"));
  assert.strictEqual(orchestrator.getState().trading_paused, true);
  assert.strictEqual(orchestrator.getState().mode, "SIGNALS");

  // Resume trading after loss pause
  await orchestrator.resumeTrading("user");
  assert.strictEqual(orchestrator.getState().trading_paused, false);

  // 7. SEMI Mode 20-second countdown flow
  await orchestrator.setMode("SEMI");
  const semiSig = {
    id: `sig_semi_${Date.now()}`,
    pair: "EURUSD",
    direction: "CALL",
    tier: "A",
    confidence: 90,
    entryPrice: 1.085,
    expirySecs: 60,
    createdAt: Date.now(),
  };

  const pendingConf = orchestrator.createPendingTrade(semiSig);
  assert.ok(pendingConf);
  assert.strictEqual(pendingConf.state, "pending");

  // Skip pending trade
  orchestrator.skipPendingTrade(pendingConf.id);
  assert.strictEqual(pendingConf.state, "skipped");

  // Drop back to SIGNALS mode for safe test exit
  await orchestrator.setMode("SIGNALS");

  console.log("All Orchestrator & Guardrails Tests Passed Successfully!");
}

testOrchestrator().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
