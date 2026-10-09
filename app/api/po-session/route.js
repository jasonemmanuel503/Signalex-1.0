export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import crypto from "crypto";
import { writeAuditLog } from "../../../lib/store/index.js";

const PO_GATEWAY_URL = process.env.PO_GATEWAY_URL || "http://127.0.0.1:8002";
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN || "dev_internal_token_signalex_2026";

let lastAttemptTimestamp = 0;

function timingSafeMatch(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string" || !provided || !expected) {
    return false;
  }
  const h1 = crypto.createHash("sha256").update(provided).digest();
  const h2 = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(h1, h2);
}

async function authenticateRequest(req) {
  // 1. Valid X-Internal-Token
  const internalToken = req.headers.get("x-internal-token");
  if (internalToken && timingSafeMatch(internalToken, INTERNAL_API_TOKEN)) {
    return { ok: true, user: "internal" };
  }

  // 2. Supabase Auth Verification
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const allowedEmail = process.env.ALLOWED_EMAIL;

  // Fail-closed: If Supabase is unconfigured and internal token is absent/invalid -> 403
  if (!supabaseUrl || !serviceRoleKey) {
    return { ok: false, status: 403, error: "Forbidden — authentication required and Supabase unconfigured" };
  }

  // Extract auth token
  const authHeader = req.headers.get("authorization");
  let token = null;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.substring(7);
  } else {
    const cookiesHeader = req.headers.get("cookie") || "";
    const match = cookiesHeader.match(/(?:^|;\s*)(?:sb-access-token|sb-token)=([^;]+)/);
    if (match) token = match[1];
  }

  if (!token) {
    return { ok: false, status: 401, error: "Unauthorized — Login required" };
  }

  try {
    const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: serviceRoleKey,
      },
      signal: AbortSignal.timeout(4000),
    });

    if (!userRes.ok) {
      return { ok: false, status: 401, error: "Invalid or expired session token" };
    }

    const userData = await userRes.json();
    if (allowedEmail && userData.email && userData.email.toLowerCase() !== allowedEmail.toLowerCase()) {
      return { ok: false, status: 403, error: "Forbidden — Email not allowed" };
    }

    return { ok: true, user: userData.email };
  } catch (err) {
    return { ok: false, status: 500, error: `Auth verification failure: ${err.message}` };
  }
}

export async function POST(req) {
  try {
    // Auth check
    const auth = await authenticateRequest(req);
    if (!auth.ok) {
      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    // Rate limiting: 1 attempt per 5s
    const now = Date.now();
    if (now - lastAttemptTimestamp < 5000) {
      return NextResponse.json(
        { ok: false, error: "Rate limit: please wait 5 seconds between session update attempts." },
        { status: 429 }
      );
    }

    // Body validation
    const body = await req.json().catch(() => ({}));
    let { session, uid } = body;

    if (typeof session !== "string") {
      return NextResponse.json({ error: "Session must be a string" }, { status: 400 });
    }
    session = session.trim();
    if (session.length < 8 || session.length > 4096) {
      return NextResponse.json(
        { error: "Session length must be between 8 and 4096 characters" },
        { status: 400 }
      );
    }

    const numUid = parseInt(String(uid).trim(), 10);
    if (!Number.isInteger(numUid) || numUid <= 0) {
      return NextResponse.json(
        { error: "UID must be a positive integer" },
        { status: 400 }
      );
    }

    lastAttemptTimestamp = now;

    // Forward to Pocket Option Gateway with 25s timeout
    try {
      const gwRes = await fetch(`${PO_GATEWAY_URL}/session`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Token": INTERNAL_API_TOKEN,
        },
        body: JSON.stringify({ session, uid: numUid }),
        signal: AbortSignal.timeout(25000),
      });

      const gwData = await gwRes.json().catch(() => ({ ok: false }));

      if (!gwRes.ok) {
        return NextResponse.json(
          { ok: false, error: gwData?.detail || `Gateway error ${gwRes.status}` },
          { status: gwRes.status }
        );
      }

      if (gwData.status === "valid" && gwData.ok === true) {
        writeAuditLog("user", "po_session_updated", { status: "valid" });
        return NextResponse.json({ ok: true, status: "valid", connected: gwData.connected });
      } else {
        return NextResponse.json(
          { ok: false, status: gwData.status || "disconnected", connected: Boolean(gwData.connected) },
          { status: 422 }
        );
      }
    } catch (err) {
      return NextResponse.json(
        { ok: false, error: `Gateway unreachable or request timed out: ${err.message}` },
        { status: 504 }
      );
    }
  } catch (err) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
