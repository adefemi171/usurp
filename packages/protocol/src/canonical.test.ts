import { describe, expect, it } from "vitest";
import { canonicalJson, CanonicalJsonError } from "./canonical.js";

describe("canonicalJson", () => {
  it("sorts object keys so insertion order cannot change the signed bytes", () => {
    // This is the property the whole signing scheme rests on: two objects that
    // are equal but built in a different order must serialize identically.
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: 2, b: 1 })).toBe('{"a":2,"b":1}');
  });

  it("sorts keys recursively", () => {
    expect(canonicalJson({ z: { y: 1, x: 2 }, a: [{ d: 1, c: 2 }] })).toBe(
      '{"a":[{"c":2,"d":1}],"z":{"x":2,"y":1}}',
    );
  });

  it("preserves array order, which is semantic", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  it("emits no insignificant whitespace", () => {
    expect(canonicalJson({ a: [1, 2], b: {} })).toBe('{"a":[1,2],"b":{}}');
  });

  it("treats an undefined property as absent, matching JSON.stringify", () => {
    // An optional TypeScript field compiles to exactly this, so it must sign
    // the same as an object that omits the key entirely.
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalJson({ a: 1 })).toBe('{"a":1}');
  });

  it("escapes strings per JSON", () => {
    expect(canonicalJson({ s: 'a"b\\c\nd' })).toBe('{"s":"a\\"b\\\\c\\nd"}');
  });

  it("handles unicode keys and values", () => {
    expect(canonicalJson({ "é": "ü" })).toBe('{"é":"ü"}');
  });

  it("rejects floats, so no float can ever reach a signing input", () => {
    expect(() => canonicalJson({ cost: 1.5 })).toThrow(CanonicalJsonError);
  });

  it("rejects NaN and Infinity", () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ n: Number.POSITIVE_INFINITY })).toThrow(CanonicalJsonError);
  });

  it("rejects integers beyond the safe range, where the decimal form is lossy", () => {
    expect(() => canonicalJson({ n: 2 ** 53 })).toThrow(CanonicalJsonError);
  });

  it("rejects values whose JSON shape is library-dependent", () => {
    expect(() => canonicalJson({ d: new Date() })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ m: new Map() })).toThrow(CanonicalJsonError);
  });

  it("rejects bigint and undefined at the top level", () => {
    expect(() => canonicalJson(10n)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(undefined)).toThrow(CanonicalJsonError);
  });

  it("names the failing path so a bad bucket is findable", () => {
    try {
      canonicalJson({ buckets: [{ cost_micros: 0.5 }] });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CanonicalJsonError);
      expect((err as CanonicalJsonError).path).toBe("buckets[0].cost_micros");
    }
  });

  it("serializes null, booleans and empty containers", () => {
    expect(canonicalJson({ a: null, b: true, c: false, d: [], e: {} })).toBe(
      '{"a":null,"b":true,"c":false,"d":[],"e":{}}',
    );
  });
});
