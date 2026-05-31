import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Database } from "../src/persistence/index.js";
import { runHermesDogfoodDemo } from "../src/workers/index.js";

let tmpRoot: string;
let database: Database;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "openmao-hermes-demo-"));
  database = new Database(join(tmpRoot, "openmao.sqlite3"));
  database.initialize();
});

afterEach(() => {
  database.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("hermes dogfood demo", () => {
  it("governs an in-scope side effect, blocks an out-of-scope one, and diagnoses the failure", async () => {
    const result = await runHermesDogfoodDemo(database);

    // The granted, in-scope side effect is governed: it suspends for approval and then executes once.
    expect(result.granted_call.outcome).toBe("require_approval");
    expect(result.granted_call.executed).toBe(true);

    // The out-of-scope resource is blocked by the bounded envelope's resource grant.
    expect(result.out_of_scope_call.outcome).toBe("block");

    // The resulting failure is diagnosable end to end.
    expect(result.diagnosis_traces_to_creation).toBe(true);

    // The whole story is in the audit trail.
    expect(result.event_kinds).toContain("work.created");
    expect(result.event_kinds).toContain("capability.completed");
    expect(result.event_kinds).toContain("diagnosis.suggested");
  });
});
