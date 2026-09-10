/**
 * `POST /v1/devices` — register a device public key. `SPEC.md#7`.
 *
 * Trades a one-time enrollment code for a `device_id`. Only the public half of
 * the keypair is ever sent; the private key is generated on the device and
 * stays in its OS keychain.
 */

import { z } from "zod";
import { PUBLIC_KEY_BYTES } from "@usurp/protocol";
import { getDb, redeemEnrollment } from "@usurp/db";
import { NextResponse } from "next/server";
import {
  bodyError,
  limitRequest,
  readJson,
  reportError,
} from "../../../lib/request";

const bodySchema = z
  .object({
    code: z.string().min(1).max(64),
    /** Raw 32-byte ed25519 public key, base64url. */
    public_key: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/, "public_key must be base64url")
      .refine(
        (v) => Buffer.from(v, "base64url").length === PUBLIC_KEY_BYTES,
        `public_key must decode to ${PUBLIC_KEY_BYTES} bytes`,
      ),
    label: z.string().max(64).optional(),
  })
  .strict();

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const limited = await limitRequest("device-register", "deployment", 120);
  if (limited) return limited;
  let body: unknown;
  try {
    body = await readJson(request);
  } catch (error) {
    return bodyError(error);
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "invalid_request",
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
    result = await redeemEnrollment(
      getDb(),
      parsed.data.code,
      parsed.data.public_key,
      parsed.data.label ? { label: parsed.data.label } : {},
    );
  } catch (err) {
    reportError("device-register");
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }

  if (!result.ok) {
    // All three failures are 401: distinguishing "wrong code" from "expired
    // code" to an unauthenticated caller turns the endpoint into an oracle for
    // probing which codes exist. The CLI shows one actionable message.
    return NextResponse.json(
      { error: result.failure, detail: "enrollment code is not valid" },
      { status: 401 },
    );
  }

  return NextResponse.json(
    {
      device_id: result.device.id,
      trust_tier: result.device.trustTier,
      // True when this key was already registered, so the CLI can say "already
      // enrolled" instead of implying it created something.
      reused: result.reused,
    },
    { status: result.reused ? 200 : 201 },
  );
}
