import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    status: "ok",
    app: "signalex",
    version: "10.0.0",
    time: new Date().toISOString(),
  });
}
