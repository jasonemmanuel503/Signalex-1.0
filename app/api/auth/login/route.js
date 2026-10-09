import { NextResponse } from "next/server";
import { getSupabaseAdmin, isSupabaseConfigured } from "../../../../lib/store/supabaseClient.js";

export async function POST(req) {
  try {
    const { email, password } = await req.json();

    if (!email || !password) {
      return NextResponse.json({ error: "Email and password are required" }, { status: 400 });
    }

    const allowedEmail = process.env.ALLOWED_EMAIL;
    if (allowedEmail && email.toLowerCase() !== allowedEmail.toLowerCase()) {
      return NextResponse.json({ error: "Access denied — Email is not authorized" }, { status: 403 });
    }

    if (!isSupabaseConfigured) {
      // In local dev without Supabase, set a dummy session cookie so user can proceed
      const res = NextResponse.json({ ok: true, note: "Dev mode login" });
      res.cookies.set("sb-access-token", "dev_token", {
        path: "/",
        httpOnly: true,
        maxAge: 86400 * 7,
      });
      return res;
    }

    const sb = getSupabaseAdmin();
    const { data, error } = await sb.auth.signInWithPassword({ email, password });

    if (error || !data.session) {
      return NextResponse.json({ error: error?.message || "Invalid credentials" }, { status: 401 });
    }

    const res = NextResponse.json({ ok: true, user: data.user.email });
    res.cookies.set("sb-access-token", data.session.access_token, {
      path: "/",
      httpOnly: true,
      maxAge: data.session.expires_in || 86400 * 7,
      sameSite: "lax",
    });

    return res;
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
