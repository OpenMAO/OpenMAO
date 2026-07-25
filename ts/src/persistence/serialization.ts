export function dumpJson(value: unknown): string {
  return JSON.stringify(stabilize(value));
}

export function jsonEqual(left: unknown, right: unknown): boolean {
  return dumpJson(left) === dumpJson(right);
}

function stabilize(value: unknown): unknown {
  if (value === undefined) {
    // JSON.stringify silently drops undefined-valued keys (and nulls array
    // elements), so {a: undefined} and {} would collapse to one digest in the
    // hash chain. Refuse anything the output cannot represent faithfully.
    throw new TypeError("dumpJson: undefined is not JSON-representable");
  }
  const type = typeof value;
  if (type === "function" || type === "symbol" || type === "bigint") {
    // Function and symbol values are dropped from records and nulled in arrays
    // exactly like undefined; bigint throws from JSON.stringify but without
    // naming the serializer that sealed the value in.
    throw new TypeError(`dumpJson: ${type} is not JSON-representable`);
  }
  if (type === "number" && !Number.isFinite(value as number)) {
    // NaN and ±Infinity serialize to null, colliding with a genuine null.
    // -0 is left alone: it serializes to 0, which RFC 8785 also treats as
    // the canonical form.
    throw new TypeError(`dumpJson: non-finite number (${String(value)}) is not JSON-representable`);
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (!(index in value)) {
        // JSON.stringify coerces holes to null, colliding with a genuine null.
        throw new TypeError(
          `dumpJson: sparse array (hole at index ${index}) is not JSON-representable`,
        );
      }
    }
    if (Object.keys(value).length !== value.length) {
      // Own non-index properties on an array are dropped by JSON.stringify.
      throw new TypeError("dumpJson: array with non-index properties is not JSON-representable");
    }
    assertNoEnumerableSymbolKeys(value);
    return value.map((item) => stabilize(item));
  }
  if (!value || type !== "object") {
    return value;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    // Object.entries flattens Date/Map/Set/class instances to their own
    // enumerable properties — usually {} — colliding with a genuine empty
    // object. Producers must canonicalize (e.g. utcNow() ISO strings) before
    // the boundary.
    const name = (value as object).constructor?.name || "unknown";
    throw new TypeError(`dumpJson: non-plain object (${name}) is not JSON-representable`);
  }
  assertNoEnumerableSymbolKeys(value);
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stabilize(item)]),
  );
}

function assertNoEnumerableSymbolKeys(value: object): void {
  for (const key of Object.getOwnPropertySymbols(value)) {
    if (Object.prototype.propertyIsEnumerable.call(value, key)) {
      // Object.entries and JSON.stringify both skip symbol keys, so the
      // property would vanish from the digest without a trace.
      throw new TypeError(
        `dumpJson: symbol-keyed property (${String(key)}) is not JSON-representable`,
      );
    }
  }
}
