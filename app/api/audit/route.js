import { NextResponse } from "next/server";
import { getAuditLogs } from "../../../lib/store/index.js";

export async function GET(req) {
  try {
    const url = new URL(req.url);
    const limit = parseInt(url.searchParams.get("limit") || "50", 10);
    const logs = getAuditLogs(limit);
    return NextResponse.json({ ok: true, logs, count: logs.length });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
