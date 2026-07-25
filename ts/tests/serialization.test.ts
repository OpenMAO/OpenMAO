import { describe, expect, it } from "vitest";

import { dumpJson } from "../src/persistence/serialization.js";

describe("dumpJson (canonical serializer sealing the event hash chain)", () => {
  // Record-typed zod fields (payload.data, metadata, BoundedWorkEnvelope.input)
  // admit undefined values in-process: zod retains the key, JSON.stringify drops
  // it, so {a: undefined} and {} collapse to one digest — a silent collision in
  // the artifact the tamper-evidence claim rests on. The serializer must refuse
  // any value it cannot represent faithfully.
  it("rejects an undefined record value instead of silently dropping the key", () => {
    expect(() => dumpJson({ a: undefined })).toThrowError(/undefined/);
  });

  it("rejects undefined nested deep inside record values", () => {
    expect(() => dumpJson({ data: { nested: { a: undefined } } })).toThrowError(/undefined/);
  });

  it("rejects an undefined array element instead of coercing it to null", () => {
    expect(() => dumpJson({ items: [undefined] })).toThrowError(/undefined/);
  });

  it("rejects an undefined root value", () => {
    expect(() => dumpJson(undefined)).toThrowError(/undefined/);
  });

  it("serializes null values and absent keys as distinct canonical forms", () => {
    expect(dumpJson({ b: null, a: 1 })).toBe('{"a":1,"b":null}');
    expect(dumpJson({})).toBe("{}");
  });
});
