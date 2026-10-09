export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    if (process.env.NEXT_PHASE === "phase-production-build") {
      return;
    }
    const signalexEnv = (process.env.SIGNALEX_ENV || "").toLowerCase();
    const token = process.env.INTERNAL_API_TOKEN;
    const isDevToken = !token || token.trim() === "" || token === "dev_internal_token_signalex_2026";

    if (signalexEnv === "production") {
      if (isDevToken) {
        throw new Error(
          "[SIGNALEX_ENV=production] Next.js server startup failed: INTERNAL_API_TOKEN is missing, empty, or set to the default dev token."
        );
      }
      if (!process.env.SUPABASE_URL || !process.env.SUPABASE_URL.trim()) {
        throw new Error(
          "[SIGNALEX_ENV=production] Next.js server startup failed: SUPABASE_URL is missing or empty."
        );
      }
      if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.SUPABASE_SERVICE_ROLE_KEY.trim()) {
        throw new Error(
          "[SIGNALEX_ENV=production] Next.js server startup failed: SUPABASE_SERVICE_ROLE_KEY is missing or empty."
        );
      }
    } else {
      if (isDevToken) {
        console.warn(
          "[SECURITY WARNING] Running Next.js with default or unconfigured INTERNAL_API_TOKEN in non-production mode."
        );
      }
    }
  }
}
