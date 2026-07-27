import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import { type Workspace, WorkspaceSchema } from "../src/contracts/index.js";
import { Database, EventStore, verifyAllChains, WorkspaceStore } from "../src/persistence/index.js";
import { dumpJson } from "../src/persistence/serialization.js";

const fixturePath = new URL("../../tests/fixtures/canonical_v0.json", import.meta.url);
const SECOND_WORKSPACE_ID = "ws_22222222222222222222222222222222";

describe("verifyAllChains", () => {
  let database: Database;
  let events: EventStore;
  let workspace: Workspace;

  beforeEach(async () => {
    database = new Database();
    database.initialize();
    const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as Record<string, unknown>;
    workspace = WorkspaceSchema.parse(fixture.workspace);
    new WorkspaceStore(database).save(workspace);
    events = new EventStore(database);
  });

  afterEach(() => {
    database.close();
  });

  it("reports ok per workspace with event counts", () => {
    events.append({ workspace_id: workspace.id, kind: "demo.first", actor: "alice" });
    events.append({ workspace_id: workspace.id, kind: "demo.second", actor: "bob" });

    const report = verifyAllChains(database);

    expect(report.ok).toBe(true);
    expect(report.workspaces).toEqual([
      { workspace_id: workspace.id, events: 2, verification: { ok: true } },
    ]);
  });

  it("names the first broken event after out-of-band tampering", () => {
    events.append({ workspace_id: workspace.id, kind: "demo.first", actor: "alice" });
    const target = events.append({
      workspace_id: workspace.id,
      kind: "demo.second",
      actor: "bob",
    });

    // Same out-of-band tamper as event_chain.test.ts: drop the append-only
    // trigger and rewrite a row without recomputing its hash.
    database.connection.exec("DROP TRIGGER events_no_update");
    const tampered = { ...target, actor: "intruder" };
    database.connection
      .prepare("UPDATE events SET payload_json = ? WHERE id = ?")
      .run(dumpJson(tampered), target.id);

    const report = verifyAllChains(database);

    expect(report.ok).toBe(false);
    const verification = report.workspaces[0]?.verification;
    expect(verification).toBeDefined();
    if (verification && !verification.ok) {
      expect(verification.broken_at).toBe(target.id);
      expect(verification.reason).toContain("tampering");
    }
  });

  it("verifies each workspace independently", () => {
    const second = WorkspaceSchema.parse({
      ...workspace,
      id: SECOND_WORKSPACE_ID,
      name: "Second Workspace",
    });
    new WorkspaceStore(database).save(second);
    events.append({ workspace_id: workspace.id, kind: "demo.first", actor: "alice" });
    const target = events.append({
      workspace_id: second.id,
      kind: "demo.second",
      actor: "bob",
    });

    database.connection.exec("DROP TRIGGER events_no_update");
    const tampered = { ...target, actor: "intruder" };
    database.connection
      .prepare("UPDATE events SET payload_json = ? WHERE id = ?")
      .run(dumpJson(tampered), target.id);

    const report = verifyAllChains(database);

    expect(report.ok).toBe(false);
    const byWorkspace = new Map(
      report.workspaces.map((entry) => [entry.workspace_id, entry.verification]),
    );
    expect(byWorkspace.get(workspace.id)).toEqual({ ok: true });
    expect(byWorkspace.get(second.id)?.ok).toBe(false);
  });
});

describe("cli verify-chain", () => {
  let tmpRoot: string;
  let dbPath: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "openmao-ts-verify-"));
    dbPath = join(tmpRoot, "openmao.sqlite3");
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("exits 0 on an intact chain and prints the report", async () => {
    const lines: string[] = [];
    expect(await runCli(["init"], { dbPath, write: (m) => lines.push(m) })).toBe(0);

    const code = await runCli(["verify-chain"], { dbPath, write: (m) => lines.push(m) });

    expect(code).toBe(0);
    const report = JSON.parse(lines.at(-1) ?? "{}") as { ok: boolean; workspaces: unknown[] };
    expect(report.ok).toBe(true);
    expect(report.workspaces.length).toBeGreaterThan(0);
  });

  it("exits 1 when the chain is broken and names the first break", async () => {
    expect(await runCli(["init"], { dbPath, write: () => {} })).toBe(0);

    const database = new Database(dbPath);
    database.initialize();
    const row = database.connection
      .prepare("SELECT id, payload_json FROM events ORDER BY seq LIMIT 1")
      .get() as { id: string; payload_json: string };
    database.connection.exec("DROP TRIGGER events_no_update");
    const tampered = JSON.parse(row.payload_json) as Record<string, unknown>;
    tampered.actor = "intruder";
    database.connection
      .prepare("UPDATE events SET payload_json = ? WHERE id = ?")
      .run(dumpJson(tampered), row.id);
    database.close();

    const lines: string[] = [];
    const code = await runCli(["verify-chain"], { dbPath, write: (m) => lines.push(m) });

    expect(code).toBe(1);
    const report = JSON.parse(lines.at(-1) ?? "{}") as {
      ok: boolean;
      workspaces: Array<{ verification: { ok: boolean; broken_at?: string } }>;
    };
    expect(report.ok).toBe(false);
    expect(report.workspaces[0]?.verification.broken_at).toBe(row.id);
  });

  it("opens the database read-only: journal mode and sidecar files are untouched", async () => {
    expect(await runCli(["init"], { dbPath, write: () => {} })).toBe(0);

    // Pre-existing state the verifier must preserve exactly: a database whose
    // journal mode is NOT wal. The old writable open ran journal_mode = WAL in
    // its constructor, persistently flipping this and creating sidecars.
    const flip = new Database(dbPath);
    flip.connection.pragma("journal_mode = DELETE");
    flip.close();

    const journalMode = (): unknown => {
      const probe = new Database(dbPath, { readonly: true });
      try {
        return probe.connection.pragma("journal_mode", { simple: true });
      } finally {
        probe.close();
      }
    };
    expect(journalMode()).toBe("delete");
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);

    const lines: string[] = [];
    const code = await runCli(["verify-chain"], { dbPath, write: (m) => lines.push(m) });
    expect(code).toBe(0);
    expect((JSON.parse(lines.at(-1) ?? "{}") as { ok: boolean }).ok).toBe(true);

    expect(journalMode()).toBe("delete");
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
  });
});
