#!/usr/bin/env node
import assert from "assert";
import { normalizePair, calcBreakEven } from "../lib/trading/priceResolver.js";
import { scheduleShadowEvaluation } from "../lib/trading/shadowEvaluator.js";
import { getJournalHistory, saveSignal } from "../lib/store/index.js";

async function testPriceResolver() {
  console.log("Running Price Resolver & Shadow Evaluator Tests...");

  // 1. Break-even formula tests
  const be85 = calcBreakEven(85);
  assert.strictEqual(be85, 54.05, "85% payout should yield 54.05% break-even rate");

  const be90 = calcBreakEven(90);
  assert.strictEqual(be90, 52.63, "90% payout should yield 52.63% break-even rate");

  const be80 = calcBreakEven(80);
  assert.strictEqual(be80, 55.56, "80% payout should yield 55.56% break-even rate");

  // 2. Pair normalization tests
  const otcNorm1 = normalizePair("EUR/USD OTC");
  assert.strictEqual(otcNorm1.isOtc, true);
  assert.strictEqual(otcNorm1.poAsset, "EURUSD_otc");

  const otcNorm2 = normalizePair("AUDCAD_otc");
  assert.strictEqual(otcNorm2.isOtc, true);
  assert.strictEqual(otcNorm2.poAsset, "AUDCAD_otc");

  const fxNorm1 = normalizePair("EUR/USD");
  assert.strictEqual(fxNorm1.isOtc, false);
  assert.strictEqual(fxNorm1.poAsset, "EURUSD");
  assert.strictEqual(fxNorm1.derivPair, "EUR/USD");

  const fxNorm2 = normalizePair("USDJPY");
  assert.strictEqual(fxNorm2.isOtc, false);
  assert.strictEqual(fxNorm2.poAsset, "USDJPY");
  assert.strictEqual(fxNorm2.derivPair, "USD/JPY");

  // 3. Shadow Evaluator scheduling check
  const testSig = {
    id: `test_shadow_${Date.now()}`,
    pair: "EURUSD_otc",
    direction: "CALL",
    entryPrice: 1.08500,
    expirySecs: 60,
    createdAt: Date.now(),
  };
  saveSignal(testSig);
  // Schedule shadow evaluation (does not throw)
  scheduleShadowEvaluation(testSig);

  console.log("All Price Resolver & Break-even Math Tests Passed Successfully!");
}

testPriceResolver().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
