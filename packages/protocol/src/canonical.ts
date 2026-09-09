/**
 * Deterministic JSON serialization for signing.
 *
 * A signature is only meaningful if signer and verifier agree byte-for-byte on
 * what was signed. `JSON.stringify` does not guarantee that: key order follows
 * insertion order, so a payload that round-trips through a proxy, a different
 * JSON library, or a reordered object literal produces different bytes and a
 * signature that fails to verify on data nobody tampered with.
 *
 * This is the JCS (RFC 8785) subset we actually need: recursively sorted object
 * keys, no insignificant whitespace, and a hard rejection of values whose
 * serialization is ambiguous. We deliberately do NOT implement JCS number
 * formatting (ES6 double serialization) — instead we reject any non-integer
 * number outright. Every numeric field on the wire is an integer counter
 * (tokens, calls, cost in micros), so this trades an unused capability for the
 * guarantee that no float ever reaches the signing input.
 */

export class CanonicalJsonError extends Error {
  constructor(message: string, readonly path: string) {
    super(`${message} (at ${path || "$"})`);
    this.name = "CanonicalJsonError";
  }
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function write(value: unknown, path: string, out: string[]): void {
  if (value === null) {
    out.push("null");
    return;
  }

  switch (typeof value) {
    case "boolean":
      out.push(value ? "true" : "false");
      return;

    case "number":
      if (!Number.isInteger(value)) {
        // Catches NaN, Infinity and every float. Cost is carried as integer
        // micros precisely so this restriction is never load-bearing.
        throw new CanonicalJsonError(
          `only integer numbers may be signed, got ${value}`,
          path,
        );
      }
      // Integers within the safe range have exactly one decimal form.
      if (!Number.isSafeInteger(value)) {
        throw new CanonicalJsonError(
          `integer ${value} exceeds Number.MAX_SAFE_INTEGER and cannot be canonicalized`,
          path,
        );
      }
      out.push(String(value));
      return;

    case "string":
      out.push(JSON.stringify(value));
      return;

    case "undefined":
      throw new CanonicalJsonError("undefined cannot be signed", path);

    case "bigint":
      throw new CanonicalJsonError("bigint cannot be signed", path);

    case "function":
    case "symbol":
      throw new CanonicalJsonError(`${typeof value} cannot be signed`, path);
  }

  if (Array.isArray(value)) {
    out.push("[");
    value.forEach((item, i) => {
      if (i > 0) out.push(",");
      write(item, `${path}[${i}]`, out);
    });
    out.push("]");
    return;
  }

  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    // Dates, Maps, class instances: their JSON shape is library-dependent.
    throw new CanonicalJsonError(
      `only plain objects may be signed, got ${value.constructor?.name ?? "unknown"}`,
      path,
    );
  }

  const record = value as Record<string, unknown>;
  // Sort by UTF-16 code unit, matching RFC 8785. All our keys are ASCII
  // snake_case, so this coincides with byte order.
  const keys = Object.keys(record).sort();

  out.push("{");
  let first = true;
  for (const key of keys) {
    const child = record[key];
    // Mirror JSON.stringify: an explicit `undefined` property is absent, not an
    // error. This keeps `{a: 1, b: undefined}` and `{a: 1}` signing identically,
    // which is what an optional field compiles to in TypeScript.
    if (child === undefined) continue;
    if (!first) out.push(",");
    first = false;
    out.push(JSON.stringify(key), ":");
    write(child, path ? `${path}.${key}` : key, out);
  }
  out.push("}");
}

/** Serialize `value` to its one canonical string form. Throws on ambiguity. */
export function canonicalJson(value: Json | unknown): string {
  const out: string[] = [];
  write(value, "", out);
  return out.join("");
}

/** Canonical bytes, ready to hand to `crypto.sign`. */
export function canonicalBytes(value: Json | unknown): Buffer {
  return Buffer.from(canonicalJson(value), "utf8");
}
