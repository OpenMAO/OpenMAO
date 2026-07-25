import { describe, expect, it } from "vitest";

import { EventPayloadSchema } from "../src/contracts/index.js";
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

describe("dumpJson (remaining silent-collision classes beyond undefined)", () => {
  // Same mechanism as the undefined fix: z.record(z.string(), z.unknown())
  // passes these through parse at any nesting depth, and JSON.stringify (or
  // stabilize's Object.entries flattening) silently drops or coerces them, so
  // structurally distinct payloads share a digest in the event hash chain.
  it("rejects a function record value instead of silently dropping the key", () => {
    expect(() => dumpJson({ a: () => {} })).toThrowError(/function/);
  });

  it("rejects a symbol record value instead of silently dropping the key", () => {
    expect(() => dumpJson({ a: Symbol("x") })).toThrowError(/symbol/);
  });

  it("rejects a function array element instead of coercing it to null", () => {
    expect(() => dumpJson({ items: [() => {}] })).toThrowError(/function/);
  });

  it("rejects a Date instead of flattening it to an empty object", () => {
    expect(() => dumpJson({ at: new Date(0) })).toThrowError(/non-plain object.*Date/);
  });

  it("rejects other non-plain objects (Map, class instances) for the same reason", () => {
    expect(() => dumpJson({ a: new Map([["k", 1]]) })).toThrowError(/non-plain object.*Map/);
    class Widget {
      size = 1;
    }
    expect(() => dumpJson({ a: new Widget() })).toThrowError(/non-plain object.*Widget/);
  });

  it("rejects a non-finite number instead of coercing it to null", () => {
    expect(() => dumpJson({ a: Number.NaN })).toThrowError(/non-finite/);
    expect(() => dumpJson({ a: Number.POSITIVE_INFINITY })).toThrowError(/non-finite/);
    expect(() => dumpJson({ a: Number.NEGATIVE_INFINITY })).toThrowError(/non-finite/);
  });

  it("rejects a bigint from stabilize with a locatable message", () => {
    // JSON.stringify already throws on bigint (loud, no collision), but from the
    // stringify layer with no dumpJson context; the guard fails earlier and
    // consistently with the other classes.
    expect(() => dumpJson({ a: 1n })).toThrowError(/dumpJson: bigint/);
  });

  it("rejects a sparse array instead of coercing holes to null", () => {
    expect(() => dumpJson({ items: new Array(2) })).toThrowError(/sparse array/);
  });

  it("rejects an array carrying non-index properties instead of dropping them", () => {
    const items: number[] & { note?: string } = [1, 2];
    items.note = "dropped by JSON.stringify";
    expect(() => dumpJson({ items })).toThrowError(/non-index/);
  });

  it("rejects an enumerable symbol-keyed property instead of dropping it", () => {
    expect(() => dumpJson({ a: { [Symbol("k")]: 1 } })).toThrowError(/symbol-keyed/);
  });

  it("rejects values arriving in-process through record-typed zod fields", () => {
    // z.unknown() record values survive parse untouched below the top level, so
    // the guard is the only thing between an in-process producer and a silent
    // digest collision.
    const payload = EventPayloadSchema.parse({
      data: { attachment: { render: () => "<html/>" } },
    });
    expect(() => dumpJson(payload)).toThrowError(/function/);
  });

  it("accepts null-prototype objects as plain data", () => {
    const bag: Record<string, unknown> = Object.create(null);
    bag.a = 1;
    expect(dumpJson({ bag })).toBe('{"bag":{"a":1}}');
  });

  it("canonicalizes -0 to 0 (deliberate normalization, matching RFC 8785)", () => {
    expect(dumpJson({ a: -0 })).toBe('{"a":0}');
  });
});
