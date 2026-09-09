import { NextResponse } from "next/server";
import { getDb, startPairing, pollPairing, cancelPairing } from "@usurp/db";
import { baseUrl } from "../../../lib/env";

export async function POST(request: Request) {
  if (!request.headers.get("content-type")?.startsWith("application/json")) return NextResponse.json({ error: "json_required" }, { status: 415 });
  const reader = request.body?.getReader();
  let text = "", bytes = 0;
  const decoder = new TextDecoder();
  if (reader) {
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 1024) { await reader.cancel(); return NextResponse.json({ error: "body_too_large" }, { status: 413 }); }
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } finally { reader.releaseLock(); }
  }
  let body: Record<string, unknown>;
  try { body = JSON.parse(text); if (!body || typeof body !== "object") throw new Error(); }
  catch { return NextResponse.json({ error: "invalid_request" }, { status: 400 }); }
  const headers = { "Cache-Control": "no-store" };
  if (body.action === "cancel" && typeof body.token === "string" && /^[A-Za-z0-9_-]{43}$/.test(body.token)) {
    return NextResponse.json({ cancelled: await cancelPairing(getDb(), body.token) }, { headers });
  }
  if (body.action === "poll" && typeof body.token === "string" && /^[A-Za-z0-9_-]{43}$/.test(body.token)) {
    const result = await pollPairing(getDb(), body.token);
    return NextResponse.json(result, { headers, status: result.status === "slow_down" ? 429 : 200 });
  }
  if (body.action !== "start" || typeof body.publicKey !== "string" || typeof body.label !== "string") return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  try {
    const result = await startPairing(getDb(), body.publicKey, body.label);
    return NextResponse.json({ ...result, verificationUri: `${baseUrl()}/connect/approve?code=${encodeURIComponent(result.code)}` }, { status: 201, headers });
  } catch (error) {
    const known = ["invalid_public_key", "invalid_label", "pairing_busy", "pairing_exists", "key_registered"];
    const reason = error instanceof Error && known.includes(error.message) ? error.message : "pairing_unavailable";
    return NextResponse.json({ error: reason }, { status: reason === "pairing_busy" ? 429 : reason === "pairing_unavailable" ? 503 : 400, headers });
  }
}
