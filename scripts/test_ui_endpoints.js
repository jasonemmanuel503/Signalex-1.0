// ═══════════════════════════════════════════════════════════════════════════════
// SIGNALEX V10 — Milestone 5 UI Endpoints & Statistical Model Tests
// ═══════════════════════════════════════════════════════════════════════════════

import assert from "node:assert";
import { orchestrator } from "../lib/trading/orchestrator.js";
import {
  getAppSettings,
  updateAppSettings,
  getTradeHistory,
  saveTrade,
  createPendingConfirmation,
  getPendingConfirmations,
  updatePendingConfirmationState,
} from "../lib/store/index.js";

console.log("Running Milestone 5 UI & Statistical Model Tests...\n");

// ── Test 1: Control State & Guardrails Integration ──
console.log("1. Testing Control State retrieval...");
const state = orchestrator.getState();
assert.ok(state.mode, "State should have a mode");
assert.ok(["OFF", "SIGNALS", "SEMI", "AUTO"].includes(state.mode), "Mode must be valid");
assert.ok(state.account, "State should have an account");
assert.strictEqual(typeof state.trading_paused, "boolean", "trading_paused must be boolean");
console.log("   ✓ State structure verified:", { mode: state.mode, account: state.account });

// ── Test 2: Mode Transitions ──
console.log("\n2. Testing Mode Transitions from UI actions...");
await orchestrator.setMode("SIGNALS", "test_user");
assert.strictEqual(orchestrator.getState().mode, "SIGNALS", "Should be in SIGNALS mode");

await orchestrator.setMode("SEMI", "test_user");
assert.strictEqual(orchestrator.getState().mode, "SEMI", "Should be in SEMI mode");

await orchestrator.setMode("AUTO", "test_user");
assert.strictEqual(orchestrator.getState().mode, "AUTO", "Should be in AUTO mode");

await orchestrator.setMode("OFF", "test_user");
assert.strictEqual(orchestrator.getState().mode, "OFF", "Should be in OFF mode");
console.log("   ✓ All 4 modes (OFF, SIGNALS, SEMI, AUTO) transitioned cleanly");

// ── Test 3: Account Switching ──
console.log("\n3. Testing Account Switching (DEMO <-> REAL)...");
await orchestrator.setAccount("demo", "test_user");
assert.strictEqual(orchestrator.getState().account, "demo");

await orchestrator.setAccount("real", "test_user");
assert.strictEqual(orchestrator.getState().account, "real");

await orchestrator.setAccount("demo", "test_user");
assert.strictEqual(orchestrator.getState().account, "demo");
console.log("   ✓ Account switching validated");

// ── Test 4: Kill Switch & Resume ──
console.log("\n4. Testing Kill Switch and Resume from UI...");
await orchestrator.triggerKill("test_user", "Manual UI Kill Test");
assert.strictEqual(orchestrator.getState().mode, "OFF", "Kill must force mode to OFF");
assert.strictEqual(orchestrator.getState().kill_active, true, "kill_active flag must be true");

await orchestrator.resumeTrading("test_user");
assert.strictEqual(orchestrator.getState().kill_active, false, "kill_active flag cleared on resume");
console.log("   ✓ Kill and Resume behavior verified");

// ── Test 5: Settings Updates with Hard Caps ──
console.log("\n5. Testing Settings Drawer update persistence...");
const newSettings = updateAppSettings({
  loss_streak_limit: 4,
  max_stake: 35.0,
  min_payout_pct: 82,
});
assert.strictEqual(newSettings.loss_streak_limit, 4);
assert.strictEqual(newSettings.max_stake, 35.0);
assert.strictEqual(newSettings.min_payout_pct, 82);

// Reset back to defaults
updateAppSettings({
  loss_streak_limit: 3,
  max_stake: 25.0,
  min_payout_pct: 80,
});
console.log("   ✓ Settings updates verified and reset to defaults");

// ── Test 6: SEMI Mode Pending Confirmations Flow ──
console.log("\n6. Testing SEMI Mode Pending Confirmations...");
const pendingId = `test_pend_${Date.now()}`;
createPendingConfirmation({
  id: pendingId,
  signal_id: `sig_${Date.now()}`,
  payload: {
    pair: "EURUSD",
    direction: "CALL",
    expiry: 60,
    stake: 10.0,
    payout_pct: 85,
    tier: "A",
  },
  expires_at: new Date(Date.now() + 20000).toISOString(),
  state: "pending",
});

const pendingList = getPendingConfirmations("pending");
assert.ok(pendingList.some((p) => p.id === pendingId), "Pending trade must appear in store");

orchestrator.skipPendingTrade(pendingId);
const updatedList = getPendingConfirmations("pending");
assert.ok(!updatedList.some((p) => p.id === pendingId), "Skipped trade must be removed from pending list");
console.log("   ✓ Pending confirmations creation & skip flow verified");

// ── Test 7: Wilson Confidence Interval & Break-Even Math ──
console.log("\n7. Testing Wilson Confidence Interval & Break-Even Maths...");
function calcWilson(w, n) {
  if (n <= 0) return { lower: 0, upper: 0 };
  const z = 1.96;
  const z2 = z * z;
  const p = w / n;
  const den = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / den;
  const spread = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / den;
  return {
    lower: Number((Math.max(0, center - spread) * 100).toFixed(1)),
    upper: Number((Math.min(1, center + spread) * 100).toFixed(1)),
  };
}

// 60 wins out of 100 trades (p = 0.60)
const interval100 = calcWilson(60, 100);
assert.ok(interval100.lower > 49 && interval100.lower < 51, `Expected lower ~50%, got ${interval100.lower}%`);
assert.ok(interval100.upper > 68 && interval100.upper < 70, `Expected upper ~69%, got ${interval100.upper}%`);

// Break-even for 85% payout
const be85 = (100 / (100 + 85)) * 100;
assert.strictEqual(be85.toFixed(1), "54.1", "Break-even at 85% payout must be 54.1%");
console.log(`   ✓ 85% payout break-even: ${be85.toFixed(1)}%`);
console.log(`   ✓ 60/100 wins Wilson interval: [${interval100.lower}% – ${interval100.upper}%]`);

console.log("\n🎉 ALL Milestone 5 UI Endpoints & Statistical Model Tests Passed Successfully!");
