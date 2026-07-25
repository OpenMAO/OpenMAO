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
  if (Array.isArray(value)) {
    return value.map((item) => stabilize(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stabilize(item)]),
  );
}
