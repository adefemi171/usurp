import { consumeRateLimit, getDb } from "@usurp/db";
import { NextResponse } from "next/server";
import { baseUrl } from "./env";

export function sameOrigin(request: Request): boolean {
  return request.headers.get("origin") === new URL(baseUrl()).origin;
}

export async function limitRequest(
  scope: string,
  subject: string,
  limit = 30,
  windowMs = 60_000,
) {
  const result = await consumeRateLimit(
    getDb(),
    scope,
    subject,
    limit,
    windowMs,
  );
  return result.allowed
    ? null
    : NextResponse.json(
        { error: "rate_limited" },
        {
          status: 429,
          headers: {
            "retry-after": String(result.retryAfter),
            "cache-control": "no-store",
          },
        },
      );
}

/** Read bytes incrementally; Content-Length is advisory, not a security boundary. */
export async function readJson(
  request: Request,
  maxBytes = 8192,
  allowEmpty = false,
): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader && allowEmpty) return {};
  if (!reader) throw new Error("invalid_json");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw new Error("payload_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    if (length === 0 && allowEmpty) return {};
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("invalid_json");
  }
}

export function bodyError(error: unknown) {
  const large = error instanceof Error && error.message === "payload_too_large";
  return NextResponse.json(
    { error: large ? "payload_too_large" : "invalid_json" },
    { status: large ? 413 : 400 },
  );
}

/** No raw exceptions: driver errors can contain SQL parameters and credentials. */
export function reportError(operation: string) {
  const incident = crypto.randomUUID();
  console.error(
    JSON.stringify({
      level: "error",
      operation,
      incident,
      at: new Date().toISOString(),
    }),
  );
  return incident;
}
