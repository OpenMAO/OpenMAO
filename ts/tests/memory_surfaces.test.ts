import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createServer } from "../src/api/server.js";
import { runCli } from "../src/cli.js";
import {
  MemoryEntrySchema,
  PromotionCandidateSchema,
  WorkspaceSchema,
} from "../src/contracts/index.js";
import { PromotionService } from "../src/memory/index.js";
import {
  Database,
  MemoryEntryStore,
  PromotionCandidateStore,
  WorkspaceStore,
} from "../src/persistence/index.js";

const fixturePath = new URL("../../tests/fixtures/canonical_v0.json", import.meta.url);
const operatorToken = "test-operator-token";
const SOURCE = "mem_a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
const CORROBORATOR = "mem_b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";
const CANDIDATE = "promo_dddddddddddddddddddddddddddddddd";
const ACTOR = "agent_77777777777777777777777777777777";

let tmpRoot: string;
let dbPath: string;
let workspaceId: string;

function capture(): { lines: string[]; write: (message: string) => void } {
  const lines: string[] = [];
  return { lines, write: (message: string) => lines.push(message) };
}

function seed(): void {
  const db = new Database(dbPath);
  db.initialize();
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, unknown>;
  const workspace = WorkspaceSchema.parse(fixture.workspace);
  workspaceId = workspace.id;
  new WorkspaceStore(db).save(workspace);
  // Operator-attested so the seeded corpus is guidance-eligible under the
  // provenance invariant (#113) and stays visible to the default surfaces.
  const prov = {
    agent_id: null,
    role_id: null,
    task_id: null,
    run_id: null,
    source_event_id: null,
    note: null,
    capability_result_id: null,
    attested_by: "test_operator",
  };
  const entries = new MemoryEntryStore(db);
  entries.save(
    MemoryEntrySchema.parse({
      id: SOURCE,
      workspace_id: workspaceId,
      scope: "individual",
      owner_id: null,
      kind: "semantic",
      content: "cold email deliverability improves with domain warmup",
      provenance: prov,
      confidence: 0.6,
      status: "confirmed",
      created_at: "2026-05-27T15:20:00Z",
    }),
  );
  entries.save(
    MemoryEntrySchema.parse({
      id: CORROBORATOR,
      workspace_id: workspaceId,
      scope: "individual",
      owner_id: null,
      kind: "semantic",
      content: "an independent run also saw email deliverability improve",
      provenance: prov,
      confidence: 0.7,
      status: "confirmed",
      created_at: "2026-05-27T15:20:01Z",
    }),
  );
  // The bare `attested_by` confers nothing without a resolvable attestation
  // event (#113), so put the operator attestation on the record for both.
  const promotion = new PromotionService(db);
  promotion.attestMemory(SOURCE, { attested_by: prov.attested_by });
  promotion.attestMemory(CORROBORATOR, { attested_by: prov.attested_by });
  new PromotionCandidateStore(db).save(
    PromotionCandidateSchema.parse({
      id: CANDIDATE,
      workspace_id: workspaceId,
      source_memory_entry: SOURCE,
      proposed_by: "agent_55555555555555555555555555555555",
      proposed_content: "email deliverability improves with domain warmup",
      rationale: "observed across runs",
      corroboration_count: 0,
      status: "pending",
      created_at: "2026-05-27T15:20:00Z",
    }),
  );
  db.close();
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "openmao-ts-memsurf-"));
  dbPath = join(tmpRoot, "openmao.sqlite3");
  seed();
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("memory operator surfaces", () => {
  it("drives list, search, and corroborate through the CLI", async () => {
    const list = capture();
    expect(
      await runCli(["memory", "list", "--workspace", workspaceId], { dbPath, write: list.write }),
    ).toBe(0);
    expect(list.lines.join("\n")).toContain(SOURCE);

    const search = capture();
    expect(
      await runCli(["memory", "search", "deliverability", "--workspace", workspaceId], {
        dbPath,
        write: search.write,
      }),
    ).toBe(0);
    const searchOut = JSON.parse(search.lines.join("\n")) as { entry: { id: string } }[];
    expect(searchOut.map((row) => row.entry.id)).toContain(SOURCE);

    const corro = capture();
    expect(
      await runCli(
        [
          "memory",
          "corroborate",
          CANDIDATE,
          CORROBORATOR,
          "--by",
          ACTOR,
          "--workspace",
          workspaceId,
        ],
        { dbPath, write: corro.write },
      ),
    ).toBe(0);
    const corroOut = JSON.parse(corro.lines.join("\n")) as {
      candidate: { corroboration_count: number };
    };
    expect(corroOut.candidate.corroboration_count).toBe(1);
  });

  it("serves search and corroborate over the API", async () => {
    const server = createServer({ dbPath, operatorToken });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const headers = {
      "x-openmao-actor": "test_operator",
      "x-openmao-operator-token": operatorToken,
    };
    try {
      const search = (await fetch(
        `${baseUrl}/memory/search?q=deliverability&workspace_id=${workspaceId}`,
        { headers },
      ).then((response) => response.json())) as { entry: { id: string } }[];
      expect(search.map((row) => row.entry.id)).toContain(SOURCE);

      const corroborate = (await fetch(
        `${baseUrl}/memory/promotions/${CANDIDATE}/corroborate?workspace_id=${workspaceId}`,
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ source_memory_entry: CORROBORATOR, corroborated_by: ACTOR }),
        },
      ).then((response) => response.json())) as { candidate: { corroboration_count: number } };
      expect(corroborate.candidate.corroboration_count).toBe(1);

      // Idempotent retry: re-POSTing the same corroboration does not double-count.
      const retry = (await fetch(
        `${baseUrl}/memory/promotions/${CANDIDATE}/corroborate?workspace_id=${workspaceId}`,
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ source_memory_entry: CORROBORATOR }),
        },
      ).then((response) => response.json())) as { candidate: { corroboration_count: number } };
      expect(retry.candidate.corroboration_count).toBe(1);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("scopes corroborate to the candidate's workspace (404 on mismatch)", async () => {
    const server = createServer({ dbPath, operatorToken });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const headers = {
      "x-openmao-actor": "test_operator",
      "x-openmao-operator-token": operatorToken,
    };
    try {
      const response = await fetch(
        `${baseUrl}/memory/promotions/${CANDIDATE}/corroborate?workspace_id=ws_00000000000000000000000000000000`,
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ source_memory_entry: CORROBORATOR, corroborated_by: ACTOR }),
        },
      );
      expect(response.status).toBe(404);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("never surfaces untrusted individual memory in the default API read (#113)", async () => {
    const owner = "agent_99999999999999999999999999999999";
    const attestedId = "mem_c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1";
    const untrustedId = "mem_c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2";
    const blankProv = {
      agent_id: null,
      role_id: null,
      task_id: null,
      run_id: null,
      source_event_id: null,
      note: null,
      capability_result_id: null,
      attested_by: null,
    };
    const db = new Database(dbPath);
    const entries = new MemoryEntryStore(db);
    for (const [id, attested] of [
      [attestedId, true],
      [untrustedId, false],
    ] as const) {
      entries.save(
        MemoryEntrySchema.parse({
          id,
          workspace_id: workspaceId,
          scope: "individual",
          owner_id: owner,
          kind: "semantic",
          content: `owned note about deliverability ${id}`,
          provenance: attested ? { ...blankProv, attested_by: "test_operator" } : blankProv,
          confidence: 0.6,
          status: "confirmed",
          created_at: "2026-05-27T15:20:02Z",
        }),
      );
      if (attested) {
        // Proof on the record so it is guidance-eligible; the unprovenanced
        // entry stays untrusted and must not surface by default.
        new PromotionService(db).attestMemory(id, { attested_by: "test_operator" });
      }
    }
    db.close();

    const server = createServer({ dbPath, operatorToken });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const headers = {
      "x-openmao-actor": "test_operator",
      "x-openmao-operator-token": operatorToken,
    };
    try {
      const individual = (await fetch(
        `${baseUrl}/memory/individual/${owner}?workspace_id=${workspaceId}`,
        { headers },
      ).then((response) => response.json())) as { id: string }[];
      const ids = individual.map((entry) => entry.id);
      expect(ids).toContain(attestedId);
      expect(ids).not.toContain(untrustedId);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });
});
