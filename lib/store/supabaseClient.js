// ═══════════════════════════════════════════════════════════════════════════════
// SIGNALEX V10 — Supabase Server Client
// Server-only: Uses SUPABASE_SERVICE_ROLE_KEY to bypass RLS.
// Never prefix with NEXT_PUBLIC_ or expose to client bundle.
// ═══════════════════════════════════════════════════════════════════════════════

import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseServiceRoleKey);

let clientInstance = null;

if (isSupabaseConfigured) {
  clientInstance = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

/**
 * Returns the active Supabase admin client, or null if unconfigured.
 */
export function getSupabaseAdmin() {
  return clientInstance;
}

export default getSupabaseAdmin;
