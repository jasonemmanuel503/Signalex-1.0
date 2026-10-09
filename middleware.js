import { NextResponse } from "next/server";

export async function middleware(req) {
  const { pathname } = req.nextUrl;

  // 1. Static and public exemptions
  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/static") ||
    pathname === "/favicon.ico" ||
    pathname === "/login" ||
    pathname === "/api/public-health"
  ) {
    return NextResponse.next();
  }

  // 2. Telegram webhook exemption (protected by TELEGRAM_WEBHOOK_SECRET)
  if (pathname === "/api/telegram") {
    const webhookToken = req.headers.get("x-telegram-bot-api-secret-token");
    const expectedToken = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (!expectedToken || webhookToken === expectedToken) {
      return NextResponse.next();
    }
  }

  // 3. Supabase Auth Verification
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const allowedEmail = process.env.ALLOWED_EMAIL;

  // If Supabase credentials are not configured yet, allow local access
  if (!supabaseUrl || !serviceRoleKey) {
    return NextResponse.next();
  }

  // Extract auth token from Authorization header or cookie
  const authHeader = req.headers.get("authorization");
  let token = null;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.substring(7);
  } else {
    // Check cookies for Supabase session token
    const tokenCookie = req.cookies.get("sb-access-token") || req.cookies.get("sb-token");
    if (tokenCookie) token = tokenCookie.value;
  }

  if (!token) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized — Login required" }, { status: 401 });
    }
    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("redirect", pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Verify token with Supabase Auth endpoint
  try {
    const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: serviceRoleKey,
      },
    });

    if (!userRes.ok) {
      if (pathname.startsWith("/api/")) {
        return NextResponse.json({ error: "Invalid or expired session token" }, { status: 401 });
      }
      return NextResponse.redirect(new URL("/login", req.url));
    }

    const userData = await userRes.json();
    if (allowedEmail && userData.email && userData.email.toLowerCase() !== allowedEmail.toLowerCase()) {
      if (pathname.startsWith("/api/")) {
        return NextResponse.json({ error: "Forbidden — Email not allowed" }, { status: 403 });
      }
      return NextResponse.redirect(new URL("/login?error=email_not_allowed", req.url));
    }

    return NextResponse.next();
  } catch (err) {
    console.error("[Middleware] Auth check error:", err.message);
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Authentication verification failed" }, { status: 500 });
    }
    return NextResponse.redirect(new URL("/login", req.url));
  }
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
