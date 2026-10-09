export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";

const PO_GATEWAY_URL = process.env.PO_GATEWAY_URL || "http://127.0.0.1:8002";
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN || "dev_internal_token_signalex_2026";

export async function POST(req) {
  try {
    let body = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    if (body.account && body.account.toLowerCase() !== "demo") {
      return NextResponse.json(
        { error: `Test trade is strictly demo-only. Rejected account: ${body.account}` },
        { status: 400 }
      );
    }

    const gatewayRes = await fetch(`${PO_GATEWAY_URL}/test-trade`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Token": INTERNAL_API_TOKEN,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });

    const data = await gatewayRes.json();
    if (!gatewayRes.ok) {
      return NextResponse.json(
        { error: data.detail || data.error || "Gateway test trade rejected" },
        { status: gatewayRes.status }
      );
    }

    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
