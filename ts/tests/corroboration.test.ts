import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MemoryEntrySchema,
  type PromotionCandidate,
  PromotionCandidateSchema,
  type Run,
  RunSchema,
  WorkspaceSchema,
} from "../src/contracts/index.js";
import { ApprovalService } from "../src/governance/index.js";
import { PromotionService } from "../src/memory/index.js";
import {
  CorroborationStore,
  Database,
  EventStore,
  PromotionCandidateStore,
  RunStore,
  WorkspaceStore,
} from "../src/persistence/index.js";
import { createApprovalServiceWithApplications } from "../src/runtime/approvals.js";

const fixturePath = new URL("../../tests/fixtures/canonical_v0.json", import.meta.url);
const REQUESTED_BY = "agent_55555555555555555555555555555555";
const APPROVAL_ID = "approval_11111111111111111111111111111111";
const CORROBORATOR_ID = "mem_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const CORROBORATION_ID = "corrob_11111111111111111111111111111111";
const CORROBORATOR_ACTOR = "agent_77777777777777777777777777777777";
const CORROBORATOR_ID_2 = "mem_88888888888888888888888888888888";

let tmpRoot: string;
let database: Database;

function loadFixture(): Record<string, unknown> {
  return JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, unknown>;
}

function seedRunningRun(): Run {
  const fixture = loadFixture();
  new WorkspaceStore(database).save(WorkspaceSchema.parse(fixture.workspace));
  const fixtureRun = RunSchema.parse(fixture.run);
  const queued = RunSchema.parse({
    ...fixtureRun,
    status: "queued",
    active_node: null,
    suspended_approval_id: null,
    updated_at: fixtureRun.created_at,
  });
  const runStore = new RunStore(database);
  runStore.create(queued);
  return runStore.setStatus(queued.id, "running", {
    active_node: "run_started",
    updated_at: "2026-05-27T15:20:02Z",
  });
}

/**
 * Seeds the candidate's own source memory plus a distinct, independent
 * corroborating memory entry, and returns a pending candidate with a clean
 * (zero) corroboration count so assertions read 0 -> 1 -> 2.
 */
function seedPromotionFixtures(service: PromotionService, run: Run): PromotionCandidate {
  const fixture = loadFixture();
  service.writeIndividual(MemoryEntrySchema.parse(fixture.memory_entry));
  service.writeIndividual(
    MemoryEntrySchema.parse({
      ...(fixture.memory_entry as Record<string, unknown>),
      id: CORROBORATOR_ID,
      content: "an independent run reached the same conclusion",
    }),
  );
  return PromotionCandidateSchema.parse({
    ...(fixture.promotion_candidate as Record<string, unknown>),
    corroboration_count: 0,
  });
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "openmao-ts-corroboration-"));
  database = new Database(join(tmpRoot, "openmao.sqlite3"));
  database.initialize();
});

afterEach(() => {
  database.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("corroboration-based ratification", () => {
  it("records corroboration evidence, maintains the count, and raises ratified confidence", () => {
    const run = seedRunningRun();
    const service = new PromotionService(database, {
      collective_memory_dir: join(tmpRoot, "collective_memory"),
    });
    const candidate = seedPromotionFixtures(service, run);
    service.propose(candidate, {
      requested_by: REQUESTED_BY,
      run_id: run.id,
      approval_id: APPROVAL_ID,
    });

    const result = service.recordCorroboration(candidate.id, {
      source_memory_entry: CORROBORATOR_ID,
      corroborated_by: CORROBORATOR_ACTOR,
      run_id: run.id,
      corroboration_id: CORROBORATION_ID,
    });

    expect(result.corroboration.id).toBe(CORROBORATION_ID);
    expect(result.corroboration.source_memory_entry).toBe(CORROBORATOR_ID);
    expect(result.candidate.corroboration_count).toBe(1);

    const stored = new CorroborationStore(database).listForCandidate(candidate.id);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.source_memory_entry).toBe(CORROBORATOR_ID);

    const recorded = new EventStore(database)
      .listForRun(run.workspace_id, run.id)
      .find((event) => event.kind === "memory.corroboration_recorded");
    expect(recorded?.payload.data.corroboration_count).toBe(1);
    // The resolved secret/content is never required here; the evidence is the link, not the text.
    expect(JSON.stringify(recorded)).not.toContain(
      "an independent run reached the same conclusion",
    );

    new ApprovalService(database).approve(APPROVAL_ID, { workspace_id: run.workspace_id });
    const collective = service.ratifyAndWriteCollective(candidate.id, {
      workspace_id: run.workspace_id,
      approval_id: APPROVAL_ID,
      resolved_at: "2026-05-27T15:20:12Z",
    });
    // source confidence 0.8 + 0.05 * 1 corroboration.
    expect(collective.confidence).toBeCloseTo(0.85, 5);
  });

  it("requires independent corroboration to ratify through the production apply path", () => {
    const run = seedRunningRun();
    const service = new PromotionService(database, {
      collective_memory_dir: join(tmpRoot, "collective_memory"),
    });
    const candidate = seedPromotionFixtures(service, run);
    // Non-run promotion: approving routes through the apply_without_run handler
    // (createApprovalServiceWithApplications) — the production path Fix B guards.
    // (A run-bound promotion would resume the run instead and skip the handler.)
    service.propose(candidate, {
      requested_by: REQUESTED_BY,
      approval_id: APPROVAL_ID,
    });

    // The production apply path wires min_corroboration: 1, so approving with zero
    // corroborations rolls back and leaves the candidate unratified.
    expect(() =>
      createApprovalServiceWithApplications(database).approve(APPROVAL_ID, {
        workspace_id: run.workspace_id,
        actor: "operator",
      }),
    ).toThrow(/corroboration/);
    expect(new PromotionCandidateStore(database).get(candidate.id)?.status).toBe("pending");

    // One independent corroboration satisfies the production threshold.
    service.recordCorroboration(candidate.id, {
      source_memory_entry: CORROBORATOR_ID,
      corroborated_by: CORROBORATOR_ACTOR,
      run_id: run.id,
      corroboration_id: CORROBORATION_ID,
    });
    const approved = createApprovalServiceWithApplications(database).approve(APPROVAL_ID, {
      workspace_id: run.workspace_id,
      actor: "operator",
    });

    expect(approved.status).toBe("approved");
    expect(new PromotionCandidateStore(database).get(candidate.id)?.status).toBe("ratified");
  });

  it("rejects a promotion whose requested_by does not match the candidate's proposed_by", () => {
    const run = seedRunningRun();
    const service = new PromotionService(database, {
      collective_memory_dir: join(tmpRoot, "collective_memory"),
    });
    const candidate = seedPromotionFixtures(service, run);
    // The fixture candidate is proposed_by REQUESTED_BY. A divergent requester would let the
    // proposer self-approve past the approver != requester guard, so propose() must reject it.
    expect(() =>
      service.propose(candidate, {
        requested_by: "operator_someone_else",
        approval_id: APPROVAL_ID,
      }),
    ).toThrow(/proposed_by/);
  });

  it("rejects corroboration by the candidate's own source memory entry", () => {
    const run = seedRunningRun();
    const service = new PromotionService(database, {
      collective_memory_dir: join(tmpRoot, "collective_memory"),
    });
    const candidate = seedPromotionFixtures(service, run);
    service.propose(candidate, {
      requested_by: REQUESTED_BY,
      run_id: run.id,
      approval_id: APPROVAL_ID,
    });

    expect(() =>
      service.recordCorroboration(candidate.id, {
        source_memory_entry: candidate.source_memory_entry,
        corroborated_by: CORROBORATOR_ACTOR,
        run_id: run.id,
      }),
    ).toThrow(/its own source/);
  });

  it("rejects a duplicate corroboration from the same memory entry", () => {
    const run = seedRunningRun();
    const service = new PromotionService(database, {
      collective_memory_dir: join(tmpRoot, "collective_memory"),
    });
    const candidate = seedPromotionFixtures(service, run);
    service.propose(candidate, {
      requested_by: REQUESTED_BY,
      run_id: run.id,
      approval_id: APPROVAL_ID,
    });

    service.recordCorroboration(candidate.id, {
      source_memory_entry: CORROBORATOR_ID,
      corroborated_by: CORROBORATOR_ACTOR,
      run_id: run.id,
      corroboration_id: CORROBORATION_ID,
    });
    expect(() =>
      service.recordCorroboration(candidate.id, {
        source_memory_entry: CORROBORATOR_ID,
        corroborated_by: CORROBORATOR_ACTOR,
        run_id: run.id,
      }),
    ).toThrow(/already corroborated/);
  });

  it("rejects an unknown corroborating memory entry", () => {
    const run = seedRunningRun();
    const service = new PromotionService(database, {
      collective_memory_dir: join(tmpRoot, "collective_memory"),
    });
    const candidate = seedPromotionFixtures(service, run);
    service.propose(candidate, {
      requested_by: REQUESTED_BY,
      run_id: run.id,
      approval_id: APPROVAL_ID,
    });

    expect(() =>
      service.recordCorroboration(candidate.id, {
        source_memory_entry: "mem_ffffffffffffffffffffffffffffffff",
        corroborated_by: CORROBORATOR_ACTOR,
        run_id: run.id,
      }),
    ).toThrow(/not found/);
  });

  it("rejects corroboration of a resolved promotion candidate", () => {
    const run = seedRunningRun();
    const service = new PromotionService(database, {
      collective_memory_dir: join(tmpRoot, "collective_memory"),
      min_corroboration: 0,
    });
    const candidate = seedPromotionFixtures(service, run);
    service.propose(candidate, {
      requested_by: REQUESTED_BY,
      run_id: run.id,
      approval_id: APPROVAL_ID,
    });
    new ApprovalService(database).approve(APPROVAL_ID, { workspace_id: run.workspace_id });
    service.ratifyAndWriteCollective(candidate.id, {
      workspace_id: run.workspace_id,
      approval_id: APPROVAL_ID,
      resolved_at: "2026-05-27T15:20:12Z",
    });

    expect(() =>
      service.recordCorroboration(candidate.id, {
        source_memory_entry: CORROBORATOR_ID,
        corroborated_by: CORROBORATOR_ACTOR,
        run_id: run.id,
      }),
    ).toThrow(/only pending/);
  });

  it("blocks ratification below the configured corroboration minimum, then allows it once met", () => {
    const run = seedRunningRun();
    const service = new PromotionService(database, {
      collective_memory_dir: join(tmpRoot, "collective_memory"),
      min_corroboration: 1,
    });
    const candidate = seedPromotionFixtures(service, run);
    service.propose(candidate, {
      requested_by: REQUESTED_BY,
      run_id: run.id,
      approval_id: APPROVAL_ID,
    });
    new ApprovalService(database).approve(APPROVAL_ID, { workspace_id: run.workspace_id });

    expect(() =>
      service.ratifyAndWriteCollective(candidate.id, {
        workspace_id: run.workspace_id,
        approval_id: APPROVAL_ID,
        resolved_at: "2026-05-27T15:20:12Z",
      }),
    ).toThrow(/at least 1 corroboration/);

    service.recordCorroboration(candidate.id, {
      source_memory_entry: CORROBORATOR_ID,
      corroborated_by: CORROBORATOR_ACTOR,
      run_id: run.id,
      corroboration_id: CORROBORATION_ID,
    });
    const collective = service.ratifyAndWriteCollective(candidate.id, {
      workspace_id: run.workspace_id,
      approval_id: APPROVAL_ID,
      resolved_at: "2026-05-27T15:20:12Z",
    });
    expect(collective.scope).toBe("collective");
  });

  it("rejects corroboration from a rejected memory entry", () => {
    const run = seedRunningRun();
    const service = new PromotionService(database, {
      collective_memory_dir: join(tmpRoot, "collective_memory"),
    });
    const candidate = seedPromotionFixtures(service, run);
    service.propose(candidate, {
      requested_by: REQUESTED_BY,
      run_id: run.id,
      approval_id: APPROVAL_ID,
    });
    const fixture = loadFixture();
    service.writeIndividual(
      MemoryEntrySchema.parse({
        ...(fixture.memory_entry as Record<string, unknown>),
        id: "mem_99999999999999999999999999999999",
        status: "rejected",
        content: "a discredited observation",
      }),
    );

    expect(() =>
      service.recordCorroboration(candidate.id, {
        source_memory_entry: "mem_99999999999999999999999999999999",
        corroborated_by: CORROBORATOR_ACTOR,
        run_id: run.id,
      }),
    ).toThrow(/rejected or stale/);
  });

  it("counts actual corroboration rows for the minimum gate, ignoring a pre-set field value", () => {
    const run = seedRunningRun();
    const service = new PromotionService(database, {
      collective_memory_dir: join(tmpRoot, "collective_memory"),
      min_corroboration: 1,
    });
    const fixture = loadFixture();
    service.writeIndividual(MemoryEntrySchema.parse(fixture.memory_entry));
    // The candidate claims a corroboration_count of 5, but no evidence rows back it.
    const candidate = PromotionCandidateSchema.parse({
      ...(fixture.promotion_candidate as Record<string, unknown>),
      corroboration_count: 5,
    });
    service.propose(candidate, {
      requested_by: REQUESTED_BY,
      run_id: run.id,
      approval_id: APPROVAL_ID,
    });
    new ApprovalService(database).approve(APPROVAL_ID, { workspace_id: run.workspace_id });

    expect(() =>
      service.ratifyAndWriteCollective(candidate.id, {
        workspace_id: run.workspace_id,
        approval_id: APPROVAL_ID,
        resolved_at: "2026-05-27T15:20:12Z",
      }),
    ).toThrow(/at least 1 corroboration/);
  });

  it("rejects corroboration by the candidate's proposer", () => {
    const run = seedRunningRun();
    const service = new PromotionService(database, {
      collective_memory_dir: join(tmpRoot, "collective_memory"),
    });
    const candidate = seedPromotionFixtures(service, run);
    service.propose(candidate, {
      requested_by: REQUESTED_BY,
      run_id: run.id,
      approval_id: APPROVAL_ID,
    });

    // proposed_by in the fixture is REQUESTED_BY; a proposer cannot self-corroborate.
    expect(() =>
      service.recordCorroboration(candidate.id, {
        source_memory_entry: CORROBORATOR_ID,
        corroborated_by: REQUESTED_BY,
        run_id: run.id,
      }),
    ).toThrow(/corroborated by its proposer/);
  });

  it("rejects a second corroboration from the same actor so the count tracks independent actors", () => {
    const run = seedRunningRun();
    const service = new PromotionService(database, {
      collective_memory_dir: join(tmpRoot, "collective_memory"),
    });
    const candidate = seedPromotionFixtures(service, run);
    const fixture = loadFixture();
    service.writeIndividual(
      MemoryEntrySchema.parse({
        ...(fixture.memory_entry as Record<string, unknown>),
        id: CORROBORATOR_ID_2,
        content: "a third, distinct observation",
      }),
    );
    service.propose(candidate, {
      requested_by: REQUESTED_BY,
      run_id: run.id,
      approval_id: APPROVAL_ID,
    });
    service.recordCorroboration(candidate.id, {
      source_memory_entry: CORROBORATOR_ID,
      corroborated_by: CORROBORATOR_ACTOR,
      run_id: run.id,
      corroboration_id: CORROBORATION_ID,
    });

    // Same actor, different memory: rejected, so the count reflects independent actors.
    expect(() =>
      service.recordCorroboration(candidate.id, {
        source_memory_entry: CORROBORATOR_ID_2,
        corroborated_by: CORROBORATOR_ACTOR,
        run_id: run.id,
      }),
    ).toThrow(/already corroborated/);
  });

  it("rejects a run-bound corroboration whose run does not match the corroborating memory", () => {
    const run = seedRunningRun();
    const service = new PromotionService(database, {
      collective_memory_dir: join(tmpRoot, "collective_memory"),
    });
    const candidate = seedPromotionFixtures(service, run);
    service.propose(candidate, {
      requested_by: REQUESTED_BY,
      run_id: run.id,
      approval_id: APPROVAL_ID,
    });

    expect(() =>
      service.recordCorroboration(candidate.id, {
        source_memory_entry: CORROBORATOR_ID,
        corroborated_by: CORROBORATOR_ACTOR,
        run_id: "run_00000000000000000000000000000000",
      }),
    ).toThrow(/provenance run/);
  });

  it("is idempotent when retried with the same corroboration id", () => {
    const run = seedRunningRun();
    const service = new PromotionService(database, {
      collective_memory_dir: join(tmpRoot, "collective_memory"),
    });
    const candidate = seedPromotionFixtures(service, run);
    service.propose(candidate, {
      requested_by: REQUESTED_BY,
      run_id: run.id,
      approval_id: APPROVAL_ID,
    });
    const first = service.recordCorroboration(candidate.id, {
      source_memory_entry: CORROBORATOR_ID,
      corroborated_by: CORROBORATOR_ACTOR,
      run_id: run.id,
      corroboration_id: CORROBORATION_ID,
    });
    const retry = service.recordCorroboration(candidate.id, {
      source_memory_entry: CORROBORATOR_ID,
      corroborated_by: CORROBORATOR_ACTOR,
      run_id: run.id,
      corroboration_id: CORROBORATION_ID,
    });

    expect(retry.corroboration.id).toBe(first.corroboration.id);
    expect(retry.candidate.corroboration_count).toBe(1);
  });
});
