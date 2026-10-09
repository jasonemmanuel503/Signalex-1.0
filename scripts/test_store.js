#!/usr/bin/env node
import assert from "assert";
import {
  saveTrade,
  updateTradeResultDb,
  getTradeHistory,
  getStats,
  saveSignal,
  getSignals,
  getSignalById,
  getAppSettings,
  updateAppSettings,
  writeAuditLog,
  getAuditLogs,
  createPendingConfirmation,
  getPendingConfirmations,
  updatePendingConfirmationState,
} from "../lib/store/index.js";

async function runStoreTests() {
  console.log("Running Repository & Store Unit Tests...");

  // 1. Settings
  const initialSettings = getAppSettings();
  assert.strictEqual(initialSettings.mode, "SIGNALS", "Restart safety default mode is SIGNALS");
  assert.strictEqual(initialSettings.loss_streak_limit, 3);

  updateAppSettings({ mode: "SIGNALS", loss_streak_limit: 3 });
  const updatedSettings = getAppSettings();
  assert.strictEqual(updatedSettings.mode, "SIGNALS");

  // 2. Signals
  const sig = {
    id: "sig_test_101",
    pair: "EURUSD",
    market: "forex",
    direction: "CALL",
    confidence: 88,
    tier: "A",
    quality_score: 82,
    strategy: "MOMENTUM_ALIGNMENT",
    expiry_secs: 60,
  };
  const sigSaved = saveSignal(sig);
  assert.strictEqual(sigSaved, true);
  const foundSig = getSignalById("sig_test_101");
  assert.strictEqual(foundSig.pair, "EURUSD");
  assert.strictEqual(foundSig.direction, "CALL");

  // 3. Trades
  const trade = {
    id: "tr_test_201",
    signalId: "sig_test_101",
    pair: "EURUSD",
    direction: "CALL",
    positionSize: 10,
    payout_pct: 85,
    entryPrice: 1.08550,
  };
  const tradeSaved = saveTrade(trade);
  assert.strictEqual(tradeSaved, true);

  const historyBefore = getTradeHistory();
  assert.ok(historyBefore.some((t) => t.id === "tr_test_201"));

  // Update Result
  updateTradeResultDb("tr_test_201", "WIN", 1.08570);
  const stats = getStats();
  assert.strictEqual(stats.wins >= 1, true);

  // 4. Pending Confirmations
  const conf = createPendingConfirmation("sig_test_101", { pair: "EURUSD", stake: 10 }, 10);
  assert.strictEqual(conf.signal_id, "sig_test_101");
  assert.strictEqual(conf.state, "pending");

  const pendingList = getPendingConfirmations("pending");
  assert.ok(pendingList.some((c) => c.id === conf.id));

  updatePendingConfirmationState(conf.id, "executed");
  const executedList = getPendingConfirmations("executed");
  assert.ok(executedList.some((c) => c.id === conf.id));

  // 5. Audit Log
  writeAuditLog("user", "mode_change", { from: "OFF", to: "SIGNALS" });
  const logs = getAuditLogs();
  assert.ok(logs.some((l) => l.action === "mode_change"));

  console.log("All Repository Layer Unit Tests Passed Successfully!");
}

runStoreTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
