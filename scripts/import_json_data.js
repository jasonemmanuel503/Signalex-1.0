#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════════
// SIGNALEX — One-Time Migration Script: signalex.json -> Supabase
// Usage: node scripts/import_json_data.js
// ═══════════════════════════════════════════════════════════════════════════════

import fs from "fs";
import path from "path";
import { saveTrade, saveSignal, saveTierPerformance, setAppState } from "../lib/store/index.js";
import { getSupabaseAdmin, isSupabaseConfigured } from "../lib/store/supabaseClient.js";

const DATA_DIR = path.join(process.cwd(), "data");
const JSON_PATH = path.join(DATA_DIR, "signalex.json");
const DB_SHIM_PATH = path.join(DATA_DIR, "signalex.db");

async function runMigration() {
  console.log("=================================================");
  console.log("SIGNALEX ONE-TIME JSON -> SUPABASE DATA MIGRATION");
  console.log("=================================================");

  let targetPath = null;
  if (fs.existsSync(JSON_PATH)) {
    targetPath = JSON_PATH;
  } else if (fs.existsSync(DB_SHIM_PATH)) {
    // sqlite-shim saved its JSON data in signalex.db
    targetPath = DB_SHIM_PATH;
  }

  if (!targetPath) {
    console.log(`[INFO] No legacy JSON files found at ${JSON_PATH} or ${DB_SHIM_PATH}. Nothing to import.`);
    process.exit(0);
  }

  console.log(`[INFO] Found legacy data file at: ${targetPath}`);
  let rawData;
  try {
    const content = fs.readFileSync(targetPath, "utf8");
    rawData = JSON.parse(content);
  } catch (err) {
    console.error(`[ERROR] Failed to parse JSON at ${targetPath}:`, err.message);
    process.exit(1);
  }

  console.log("[INFO] Supabase configured:", isSupabaseConfigured);

  let importedTrades = 0;
  let importedSignals = 0;
  let importedTiers = 0;

  // 1. Import Trades
  const trades = rawData.trades || rawData.trade_history || [];
  if (Array.isArray(trades)) {
    for (const t of trades) {
      if (t && t.id) {
        saveTrade(t);
        importedTrades += 1;
      }
    }
  }

  // 2. Import Signals
  const signals = rawData.signals || [];
  if (Array.isArray(signals)) {
    for (const s of signals) {
      if (s && s.id) {
        saveSignal(s);
        importedSignals += 1;
      }
    }
  }

  // 3. Import Tier Performance
  const tierPerf = rawData.tier_performance || rawData.tierPerformance;
  if (tierPerf) {
    saveTierPerformance(tierPerf);
    importedTiers += 1;
  }

  // 4. Import App State / Settings
  const appState = rawData.app_state || rawData.appState;
  if (appState && typeof appState === "object") {
    for (const [k, v] of Object.entries(appState)) {
      setAppState(k, v);
    }
  }

  console.log("-------------------------------------------------");
  console.log(`Import Complete!`);
  console.log(`- Trades imported:  ${importedTrades}`);
  console.log(`- Signals imported: ${importedSignals}`);
  console.log(`- Tier performance: ${importedTiers ? "Yes" : "No"}`);
  console.log("Events have been queued to the async outbox for Supabase sync.");
  console.log("-------------------------------------------------");

  // Give outbox worker 3 seconds to drain
  await new Promise((res) => setTimeout(res, 3000));
  process.exit(0);
}

runMigration().catch((err) => {
  console.error("[FATAL] Migration error:", err);
  process.exit(1);
});
