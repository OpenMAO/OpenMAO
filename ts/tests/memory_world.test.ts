import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ApprovalPayloadSchema,
  ApprovalRequestSchema,
  ArtifactSchema,
  CapabilitySchema,
  CorroborationSchema,
  GoalSchema,
  IngestionRecordSchema,
  MemoryEntrySchema,
  ModelRequestSchema,
  OrgChangeProposalSchema,
  PromotionCandidateSchema,
  type Run,
  RunSchema,
  TaskEnvelopeSchema,
  TraceSchema,
  WorkerIdentitySchema,
  WorkItemSchema,
  WorkspaceSchema,
} from "../src/contracts/index.js";
import { ApprovalService } from "../src/governance/index.js";
import { PromotionService } from "../src/memory/index.js";
import { ModelRouterService } from "../src/modeling/index.js";
import { OrgChangeService } from "../src/org/index.js";
import {
  ApprovalStore,
  ArtifactStore,
  CapabilityStore,
  CorroborationStore,
  Database,
  EventStore,
  GoalStore,
  IngestionRecordStore,
  MemoryEntryStore,
  OrgChangeProposalStore,
  PromotionCandidateStore,
  RunStore,
  TaskEnvelopeStore,
  TraceStore,
  WorkerIdentityStore,
  WorkItemStore,
  WorkspaceStore,
  WorldModelSnapshotStore,
} from "../src/persistence/index.js";
import { WorldModelService, WorldModelServiceError } from "../src/world/index.js";

const fixturePath = new URL("../../tests/fixtures/canonical_v0.json", import.meta.url);

let tmpRoot: string;
let database: Database;

async function loadFixture(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(fixturePath, "utf8")) as Record<string, unknown>;
}

async function seedWorkspace(): Promise<string> {
  const fixture = await loadFixture();
  const workspace = WorkspaceSchema.parse(fixture.workspace);
  new WorkspaceStore(database).save(workspace);
  return workspace.id;
}

async function seedRunningRun(): Promise<Run> {
  await seedWorkspace();
  const fixture = await loadFixture();
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

async function seedWorldInputs(run: Run): Promise<void> {
  const fixture = await loadFixture();
  new GoalStore(database).save(GoalSchema.parse(fixture.goal));
  new WorkItemStore(database).save(WorkItemSchema.parse(fixture.work_item));
  new TaskEnvelopeStore(database).save(
    TaskEnvelopeSchema.parse({
      ...(fixture.task_envelope as Record<string, unknown>),
      run_id: run.id,
    }),
  );
  new WorkerIdentityStore(database).save(WorkerIdentitySchema.parse(fixture.worker_identity));
  new IngestionRecordStore(database).record(IngestionRecordSchema.parse(fixture.ingestion_record));
  new CapabilityStore(database).save(CapabilitySchema.parse(fixture.capability));
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "openmao-ts-memory-"));
  database = new Database(join(tmpRoot, "openmao.sqlite3"));
  database.initialize();
});

afterEach(() => {
  database.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("TypeScript memory promotion and world model", () => {
  it("gates collective memory promotion and writes approved collective markdown", async () => {
    const run = await seedRunningRun();
    const fixture = await loadFixture();
    const service = new PromotionService(database, {
      collective_memory_dir: join(tmpRoot, "collective_memory"),
      min_corroboration: 0,
    });
    const individual = service.writeIndividual(MemoryEntrySchema.parse(fixture.memory_entry));
    const candidate = PromotionCandidateSchema.parse(fixture.promotion_candidate);
    const proposed = service.propose(candidate, {
      requested_by: "agent_55555555555555555555555555555555",
      run_id: run.id,
      approval_id: "approval_11111111111111111111111111111111",
    });
    const suspended = new RunStore(database).get(run.id);

    expect(individual.scope).toBe("individual");
    expect(proposed.approval_id).toBe("approval_11111111111111111111111111111111");
    expect(suspended?.status).toBe("suspended_approval");
    expect(suspended?.suspended_approval_id).toBe(proposed.approval_id);

    new ApprovalService(database).approve(proposed.approval_id, { workspace_id: run.workspace_id });
    const collective = service.ratifyAndWriteCollective(candidate.id, {
      workspace_id: run.workspace_id,
      approval_id: proposed.approval_id,
      resolved_at: "2026-05-27T15:20:12Z",
    });
    const collectiveEvent = new EventStore(database)
      .listForRun(run.workspace_id, run.id)
      .find((event) => event.kind === "memory.collective_written");
    const contentRef = collectiveEvent?.payload.data.content_ref;

    expect(collective.scope).toBe("collective");
    expect(collective.id).toBe("mem_cccccccccccccccccccccccccccccccc");
    expect(contentRef).toEqual(expect.any(String));
    expect(existsSync(contentRef as string)).toBe(true);
    expect(new RunStore(database).get(run.id)?.status).toBe("running");
  });

  it("surfaces collective memory with corroboration evidence in a rebuildable world model", async () => {
    const run = await seedRunningRun();
    const fixture = await loadFixture();
    const service = new PromotionService(database, {
      collective_memory_dir: join(tmpRoot, "collective_memory"),
    });
    service.writeIndividual(MemoryEntrySchema.parse(fixture.memory_entry));
    service.writeIndividual(
      MemoryEntrySchema.parse({
        ...(fixture.memory_entry as Record<string, unknown>),
        id: "mem_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        content: "an independent run reached the same conclusion",
      }),
    );
    const candidate = PromotionCandidateSchema.parse({
      ...(fixture.promotion_candidate as Record<string, unknown>),
      corroboration_count: 0,
    });
    const proposed = service.propose(candidate, {
      requested_by: "agent_55555555555555555555555555555555",
      run_id: run.id,
      approval_id: "approval_11111111111111111111111111111111",
    });
    service.recordCorroboration(candidate.id, {
      source_memory_entry: "mem_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      corroborated_by: "agent_77777777777777777777777777777777",
      run_id: run.id,
    });
    new ApprovalService(database).approve(proposed.approval_id, { workspace_id: run.workspace_id });
    const collective = service.ratifyAndWriteCollective(candidate.id, {
      workspace_id: run.workspace_id,
      approval_id: proposed.approval_id,
      resolved_at: "2026-05-27T15:20:12Z",
    });

    const worldService = new WorldModelService(database);
    const snapshot = worldService.rebuild(run.workspace_id, run.id);
    const summary = snapshot.collective_memory.find((entry) => entry.id === collective.id);
    expect(summary).toBeDefined();
    expect(summary?.corroboration_count).toBe(1);

    // The projection stays rebuildable: deleting and rebuilding reproduces it exactly.
    new WorldModelSnapshotStore(database).delete(snapshot.id);
    const rebuilt = worldService.rebuild(run.workspace_id, run.id);
    expect(rebuilt).toEqual(snapshot);
  });

  it("makes the snapshot id sensitive to collective-memory content, not just length", async () => {
    const run = await seedRunningRun();
    const prov = {
      agent_id: null,
      role_id: null,
      task_id: null,
      run_id: null,
      source_event_id: null,
      note: "source_promotion:promo_cccccccccccccccccccccccccccccccc",
    };
    new PromotionCandidateStore(database).save(
      PromotionCandidateSchema.parse({
        id: "promo_cccccccccccccccccccccccccccccccc",
        workspace_id: run.workspace_id,
        source_memory_entry: "mem_dddddddddddddddddddddddddddddddd",
        proposed_by: "agent_55555555555555555555555555555555",
        proposed_content: "knowledge",
        rationale: "seen across runs",
        corroboration_count: 0,
        status: "pending",
        created_at: "2026-05-27T15:20:00Z",
      }),
    );
    new MemoryEntryStore(database).save(
      MemoryEntrySchema.parse({
        id: "mem_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        workspace_id: run.workspace_id,
        scope: "collective",
        owner_id: null,
        kind: "semantic",
        content: "knowledge",
        provenance: prov,
        confidence: 0.9,
        status: "confirmed",
        created_at: "2026-05-27T15:20:00Z",
      }),
    );

    const worldService = new WorldModelService(database);
    const before = worldService.rebuild(run.workspace_id, run.id);
    expect(before.collective_memory[0]?.corroboration_count).toBe(0);

    // Direct store write (no new event) changes only the corroboration count.
    new CorroborationStore(database).save(
      CorroborationSchema.parse({
        id: "corrob_11111111111111111111111111111111",
        workspace_id: run.workspace_id,
        candidate_id: "promo_cccccccccccccccccccccccccccccccc",
        source_memory_entry: "mem_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        corroborated_by: "agent_77777777777777777777777777777777",
        strength: 1,
        note: null,
        created_at: "2026-05-27T15:20:05Z",
      }),
    );
    const after = worldService.rebuild(run.workspace_id, run.id);

    expect(after.collective_memory[0]?.corroboration_count).toBe(1);
    // Same events, same entry count — only the nested content changed, so the id must change.
    expect(after.id).not.toBe(before.id);
  });

  it("excludes rejected or stale collective memory from the world model", async () => {
    const run = await seedRunningRun();
    const prov = {
      agent_id: null,
      role_id: null,
      task_id: null,
      run_id: null,
      source_event_id: null,
      note: null,
    };
    const entries = new MemoryEntryStore(database);
    entries.save(
      MemoryEntrySchema.parse({
        id: "mem_a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
        workspace_id: run.workspace_id,
        scope: "collective",
        owner_id: null,
        kind: "semantic",
        content: "trusted knowledge",
        provenance: prov,
        confidence: 0.9,
        status: "confirmed",
        created_at: "2026-05-27T15:20:00Z",
      }),
    );
    entries.save(
      MemoryEntrySchema.parse({
        id: "mem_b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2",
        workspace_id: run.workspace_id,
        scope: "collective",
        owner_id: null,
        kind: "semantic",
        content: "discredited knowledge",
        provenance: prov,
        confidence: 0.4,
        status: "stale",
        created_at: "2026-05-27T15:20:00Z",
      }),
    );

    const snapshot = new WorldModelService(database).rebuild(run.workspace_id, run.id);
    const ids = snapshot.collective_memory.map((entry) => entry.id);
    expect(ids).toContain("mem_a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1");
    expect(ids).not.toContain("mem_b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2");
  });

  it("round-trips artifact and trace metadata", async () => {
    const run = await seedRunningRun();
    await seedWorldInputs(run);
    const fixture = await loadFixture();
    const artifact = ArtifactSchema.parse(fixture.artifact);
    const trace = TraceSchema.parse(fixture.trace);
    const artifactStore = new ArtifactStore(database);
    const traceStore = new TraceStore(database);

    artifactStore.save(artifact);
    traceStore.save(trace);

    expect(artifactStore.get(artifact.id)).toEqual(artifact);
    expect(traceStore.listForRun(trace.run_id)).toEqual([trace]);
  });

  it("records deterministic mock model requests through the model router", async () => {
    const run = await seedRunningRun();
    const request = ModelRequestSchema.parse({
      id: "modelreq_11111111111111111111111111111111",
      workspace_id: run.workspace_id,
      run_id: run.id,
      requested_by: "agent_55555555555555555555555555555555",
      purpose: "draft_summary",
      model_binding: "mock",
      input_ref: "memory:seed",
      idempotency_key: `${run.id}:draft_summary`,
    });
    const router = new ModelRouterService(database);

    const response = router.generate(request);
    const replayed = router.generate(request);
    const events = new EventStore(database).listForRun(run.workspace_id, run.id);
    const trace = new TraceStore(database)
      .listForRun(run.id)
      .find((item) => item.node === "model:draft_summary");

    expect(replayed).toEqual(response);
    expect(response.status).toBe("ok");
    expect(response.workspace_id).toBe(run.workspace_id);
    expect(response.output_ref).toBe("mock:draft_summary");
    expect(events.map((event) => event.kind)).toEqual(["model.requested", "model.completed"]);
    expect(trace?.event_ids).toEqual(events.map((event) => event.id));
  });

  it("persists org change proposals and applies approval without autonomous mutation", async () => {
    const workspaceId = await seedWorkspace();
    const proposal = new OrgChangeProposalStore(database).save(
      OrgChangeProposalSchema.parse({
        id: "orgchg_11111111111111111111111111111111",
        workspace_id: workspaceId,
        proposed_by: "human",
        change_type: "policy",
        rationale: "Record a future governance change.",
        patch_json: { add: "policy placeholder" },
        status: "pending",
        created_at: "2026-05-27T15:20:00Z",
      }),
    );
    const service = new ApprovalService(database, {
      applyWithoutRun: (approval) => new OrgChangeService(database).approveFromApproval(approval),
    });
    const approval = service.request({
      workspace_id: workspaceId,
      action: "org_change.approve",
      requested_by: "human",
      payload: {
        target_type: "org_change_proposal",
        target_id: proposal.id,
        reason: proposal.rationale,
        data: {},
      },
      on_approve: "apply_without_run",
      on_reject: "no_op",
    });

    expect(() => new OrgChangeService(database).approveFromApproval(approval)).toThrow(
      "approval must be approved",
    );
    expect(() =>
      new OrgChangeService(database).approveFromApproval({
        ...approval,
        status: "approved",
        resolved_at: "2026-05-27T15:20:01Z",
      }),
    ).toThrow("approval must be approved");
    const wrongModeApproval = new ApprovalStore(database).create(
      ApprovalRequestSchema.parse({
        ...approval,
        id: "approval_22222222222222222222222222222222",
        status: "approved",
        on_approve: "resume_run",
        resolved_at: "2026-05-27T15:20:01Z",
      }),
    );
    expect(() => new OrgChangeService(database).approveFromApproval(wrongModeApproval)).toThrow(
      "apply_without_run",
    );
    expect(new OrgChangeProposalStore(database).get(proposal.id)?.status).toBe("pending");

    service.approve(approval.id, { workspace_id: workspaceId });
    const approved = new OrgChangeProposalStore(database).get(proposal.id);
    const eventKinds = new EventStore(database)
      .listForWorkspace(workspaceId)
      .map((event) => event.kind);

    expect(approved?.status).toBe("approved");
    expect(eventKinds).toEqual([
      "approval.requested",
      "approval.approved",
      "org_change.approved",
      "approval.applied",
    ]);
  });

  it("rebuilds deterministic world-model snapshots from authoritative state", async () => {
    const run = await seedRunningRun();
    await seedWorldInputs(run);
    const approval = new ApprovalService(database).request({
      workspace_id: run.workspace_id,
      run_id: run.id,
      action: "memory.promote",
      requested_by: "agent_55555555555555555555555555555555",
      payload: ApprovalPayloadSchema.parse({
        target_type: "promotion_candidate",
        target_id: "promo_cccccccccccccccccccccccccccccccc",
        reason: "Promote memory",
      }),
    });
    const service = new WorldModelService(database);

    const suspended = service.rebuild(run.workspace_id, run.id);
    const deleted = new WorldModelSnapshotStore(database).delete(suspended.id);
    const rebuilt = service.rebuild(run.workspace_id, run.id);

    expect(deleted).toBe(true);
    expect(rebuilt).toEqual(suspended);
    expect(suspended.cache_only).toBe(true);
    expect(suspended.latest_run_status).toBe("suspended_approval");
    expect(suspended.source_workspace_seq).toBe(
      new EventStore(database).listForWorkspace(run.workspace_id).at(-1)?.seq,
    );
    expect(suspended.active_goals).toEqual(["goal_77777777777777777777777777777777"]);
    expect(suspended.active_work).toEqual(["work_88888888888888888888888888888888"]);
    expect(suspended.pending_approvals).toEqual([approval.id]);
    expect(suspended.external_workers).toEqual(["worker_12121212121212121212121212121212"]);
    expect(suspended.pending_reviews).toEqual([]);
    expect(suspended.recent_ingestions).toEqual(["ingest_34343434343434343434343434343434"]);
    expect(suspended.capability_gaps).toEqual([]);
    expect(suspended.recent_events.at(-1)).toBe(
      new EventStore(database).listForRun(run.workspace_id, run.id).at(-1)?.id,
    );

    new WorkItemStore(database).setStatus("work_88888888888888888888888888888888", "review");
    const review = service.rebuild(run.workspace_id, run.id);

    expect(review.pending_reviews).toEqual(["work_88888888888888888888888888888888"]);

    new ApprovalService(database).approve(approval.id, { workspace_id: run.workspace_id });
    new WorkItemStore(database).setStatus("work_88888888888888888888888888888888", "done");
    new RunStore(database).setStatus(run.id, "completed", {
      active_node: "run_completed",
      updated_at: "2026-05-27T15:20:13Z",
    });

    const completed = service.rebuild(run.workspace_id, run.id);
    const workspaceSnapshot = service.rebuild(run.workspace_id);

    expect(completed.id).not.toBe(suspended.id);
    expect(completed.latest_run_status).toBe("completed");
    expect(completed.active_work).toEqual([]);
    expect(completed.pending_approvals).toEqual([]);
    expect(completed.pending_reviews).toEqual([]);
    expect(workspaceSnapshot.run_id).toBeNull();
    expect(workspaceSnapshot.latest_run_status).toBe("completed");
    expect(workspaceSnapshot.source_run_seq).toBeNull();
  });

  it("rejects cross-workspace run scopes", async () => {
    const run = await seedRunningRun();
    new WorkspaceStore(database).save({
      id: "ws_22222222222222222222222222222222",
      name: "Other workspace",
      created_at: "2026-05-27T15:20:00Z",
      default_org_id: null,
    });

    expect(() =>
      new WorldModelService(database).rebuild("ws_22222222222222222222222222222222", run.id),
    ).toThrow(WorldModelServiceError);
  });
});
