/**
 * `POST /v1/ingest` — `SPEC.md#7`.
 *
 * Returns `{accepted, rejected[], flags[]}` exactly as the spec's API surface
 * specifies.
 *
 * Note what this endpoint does *not* require: a bearer token. The ed25519
 * signature already proves the sender holds the device's private key, and
 * `device_id` in the payload says which key to check. A second shared secret
 * would add a credential to store, rotate, and leak without proving anything
 * the signature does not. Registration is the only step that needs a bearer
 * secret, and that is the one-time enrollment code.
 */

import { payloadSchema } from "@usurp/protocol";
import { getDb, ingest } from "@usurp/db";
import { NextResponse } from "next/server";
import {
  bodyError,
  limitRequest,
  readJson,
  reportError,
} from "../../../lib/request";

/** Reject oversized bodies before parsing. 2000 buckets is roughly 700KB. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const limited = await limitRequest("ingest", "deployment", 3000);
  if (limited) return limited;
  const declared = request.headers.get("content-length");
  if (declared && Number(declared) > MAX_BODY_BYTES) {
    return NextResponse.json(
      {
        error: "payload_too_large",
        detail: `body exceeds ${MAX_BODY_BYTES} bytes`,
      },
      { status: 413 },
    );
  }

  let body: unknown;
  try {
    body = await readJson(request, MAX_BODY_BYTES);
  } catch (error) {
    return bodyError(error);
  }

  const parsed = payloadSchema.safeParse(body);
  if (!parsed.success) {
    // Field-level detail, because the client is our own CLI and a vague 400
    // turns a schema drift into a debugging session.
    return NextResponse.json(
      {
        error: "invalid_payload",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
      { status: 400 },
    );
  }

  let result;
  try {
    result = await ingest(getDb(), parsed.data);
  } catch (err) {
    reportError("ingest");
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }

  if (!result.ok) {
    // 401 for "we don't know or trust you", 409 for a replay, 422 for content
    // the gates refused. A client can tell from the status whether to re-login,
    // resync with a fresh seq, or fix its data.
    const status =
      result.failure === "unknown_device" || result.failure === "bad_signature"
        ? 401
        : result.failure === "device_revoked"
          ? 403
          : result.failure === "stale_seq"
            ? 409
            : 422;

    return NextResponse.json(
      {
        error: result.failure ?? "rejected",
        accepted: result.accepted,
        rejected: result.rejected,
        flags: result.flags,
        // Lets the CLI recover a drifted counter instead of being wedged.
        ...(result.lastSeq !== undefined ? { last_seq: result.lastSeq } : {}),
      },
      { status },
    );
  }

  return NextResponse.json({
    accepted: result.accepted,
    rejected: result.rejected,
    flags: result.flags,
  });
}
