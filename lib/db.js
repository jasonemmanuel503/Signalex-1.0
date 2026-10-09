// ═══════════════════════════════════════════════════════════════════════════════
// SIGNALEX V10 — lib/db.js (Compatibility Bridge)
// Delegates directly to the Supabase + Outbox repository layer in lib/store/
// ═══════════════════════════════════════════════════════════════════════════════

export * from "./store/index.js";
export { default } from "./store/index.js";
