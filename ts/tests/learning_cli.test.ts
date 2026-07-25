import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import { MemoryEntrySchema, newId, utcNow } from "../src/contracts/index.js";
import {
  Database,
  EventStore,
  MemoryEntryStore,
  OrgChangeApplicationStore,
  OrgChangeProposalStore,
} from "../src/persistence/index.js";
import { WORKSPACE_ID } from "../src/spine/index.js";

let tmpRoot: string;
let dbPath: string;

function capture(): { lines: string[]; write: (message: string) => void } {
  const lines: string[] = [];
  return { lines, write: (message: string) => lines.push(message) };
}

/** Run a read-only assertion against the CLI's database file. */
function withDatabase<T>(fn: (database: Database) => T): T {
  const database = new Database(dbPath);
  database.initialize();
  try {
    return fn(database);
  } finally {
    database.close();
  }
}

function seedStaleMemory(): string {
  return withDatabase(
    (database) =>
      new MemoryEntryStore(database).save(
        MemoryEntrySchema.parse({
          id: newId("mem"),
          workspace_id: WORKSPACE_ID,
          scope: "individual",
          owner_id: null,
          kind: "semantic",
          content: "an old fact nobody trusts anymore",
          provenance: {},
          confidence: 0.2,
          status: "stale",
          created_at: utcNow(),
        }),
      ).id,
  );
}

async function seedBlockedWork(): Promise<void> {
  for (const [id, title] of [
    ["work_11111111111111111111111111111111", "Blocked research"],
    ["work_22222222222222222222222222222222", "Blocked brief"],
  ] as const) {
    expect(
      await runCli(
        [
          "work",
          "create",
          "--id",
          id,
          "--title",
          title,
          "--objective",
          `${title}.`,
          "--owner",
          "worker:research",
        ],
        { dbPath },
      ),
    ).toBe(0);
    expect(await runCli(["work", "status", id, "blocked"], { dbPath })).toBe(0);
  }
}

type ScannedProposal = { approval_id: string; proposal: { id: string; source_signal: string } };

/** `learning scan` through the CLI, returning the proposal for one source signal. */
async function scanFor(sourceSignal: string): Promise<ScannedProposal> {
  const output = capture();
  expect(await runCli(["learning", "scan"], { dbPath, write: output.write })).toBe(0);
  const scan = JSON.parse(output.lines[0] ?? "{}") as { proposals: ScannedProposal[] };
  const match = scan.proposals.find((item) => item.proposal.source_signal === sourceSignal);
  expect(match).toBeDefined();
  if (!match) {
    throw new Error(`expected a ${sourceSignal} proposal`);
  }
  return match;
}

async function approveAndApply(item: ScannedProposal): Promise<Record<string, unknown>> {
  expect(await runCli(["approvals", "approve", item.approval_id], { dbPath })).toBe(0);
  const output = capture();
  expect(
    await runCli(["learning", "apply", item.proposal.id], { dbPath, write: output.write }),
  ).toBe(0);
  return JSON.parse(output.lines[0] ?? "{}") as Record<string, unknown>;
}

function eventKinds(): string[] {
  return withDatabase((database) =>
    new EventStore(database).listForWorkspace(WORKSPACE_ID).map((event) => event.kind),
  );
}

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "openmao-ts-learning-cli-"));
  dbPath = join(tmpRoot, "openmao.sqlite3");
  expect(await runCli(["init"], { dbPath, write: capture().write })).toBe(0);
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("learning revert / withdraw through the CLI (#105)", () => {
  it("reverts a real applied change (memory_cleanup) and refuses to withdraw it", async () => {
    const entryId = seedStaleMemory();
    const cleanup = await scanFor("stale_memory");
    const applied = await approveAndApply(cleanup);

    // The real-applier path still reaches `applied`, with a verified application row.
    expect(applied.status).toBe("applied");
    withDatabase((database) => {
      expect(new MemoryEntryStore(database).get(entryId)?.status).toBe("rejected");
      expect(
        new OrgChangeApplicationStore(database).getForProposal(WORKSPACE_ID, cleanup.proposal.id)
          ?.status,
      ).toBe("verified");
    });

    // Withdraw is only for acknowledged records; a real apply must be reverted instead.
    await expect(
      runCli(["learning", "withdraw", cleanup.proposal.id], { dbPath, write: capture().write }),
    ).rejects.toThrow("only acknowledged org change proposals can be withdrawn");

    const revertOutput = capture();
    expect(
      await runCli(["learning", "revert", cleanup.proposal.id], {
        dbPath,
        write: revertOutput.write,
      }),
    ).toBe(0);
    const reverted = JSON.parse(revertOutput.lines[0] ?? "{}") as { status: string };
    expect(reverted.status).toBe("reverted");
    expect(eventKinds()).toContain("org_change.reverted");
    withDatabase((database) => {
      expect(new MemoryEntryStore(database).get(entryId)?.status).toBe("stale");
      // The proposal record keeps its honest `applied` status; the reversal lives on the
      // application record.
      expect(new OrgChangeProposalStore(database).get(cleanup.proposal.id)?.status).toBe("applied");
    });
  });

  it("acknowledges an applier-less change; revert fails with a pointer at withdraw", async () => {
    await seedBlockedWork();
    const workflow = await scanFor("repeated_blocker");
    const acknowledged = await approveAndApply(workflow);

    // No applier for `workflow`: honest status, honest event, no application row.
    expect(acknowledged.status).toBe("acknowledged");
    expect(acknowledged.applied_at).toBeNull();
    expect(acknowledged.acknowledged_at).not.toBeNull();
    expect(eventKinds()).toContain("org_change.acknowledged");
    expect(eventKinds()).not.toContain("org_change.applied");
    withDatabase((database) => {
      expect(
        new OrgChangeApplicationStore(database).getForProposal(WORKSPACE_ID, workflow.proposal.id),
      ).toBeNull();
    });

    // Nothing was applied, so there is nothing to revert — the failure names the remedy.
    await expect(
      runCli(["learning", "revert", workflow.proposal.id], { dbPath, write: capture().write }),
    ).rejects.toThrow(`learning withdraw ${workflow.proposal.id}`);
    withDatabase((database) => {
      expect(new OrgChangeProposalStore(database).get(workflow.proposal.id)?.status).toBe(
        "acknowledged",
      );
    });
  });

  it("withdraws an acknowledged change through the CLI, idempotently", async () => {
    await seedBlockedWork();
    const workflow = await scanFor("repeated_blocker");
    expect((await approveAndApply(workflow)).status).toBe("acknowledged");

    const withdrawOutput = capture();
    expect(
      await runCli(["learning", "withdraw", workflow.proposal.id], {
        dbPath,
        write: withdrawOutput.write,
      }),
    ).toBe(0);
    const withdrawn = JSON.parse(withdrawOutput.lines[0] ?? "{}") as {
      status: string;
      withdrawn_at: string | null;
    };
    expect(withdrawn.status).toBe("withdrawn");
    expect(withdrawn.withdrawn_at).not.toBeNull();

    // Idempotent replay: same record back, still exactly one withdrawal event.
    const replayOutput = capture();
    expect(
      await runCli(["learning", "withdraw", workflow.proposal.id], {
        dbPath,
        write: replayOutput.write,
      }),
    ).toBe(0);
    expect(JSON.parse(replayOutput.lines[0] ?? "{}")).toEqual(
      JSON.parse(withdrawOutput.lines[0] ?? "{}"),
    );
    expect(eventKinds().filter((kind) => kind === "org_change.withdrawn")).toHaveLength(1);

    // A withdrawn record has no application either: revert still finds nothing to reverse.
    await expect(
      runCli(["learning", "revert", workflow.proposal.id], { dbPath, write: capture().write }),
    ).rejects.toThrow(`no applied change found for proposal: ${workflow.proposal.id}`);
  });
});
