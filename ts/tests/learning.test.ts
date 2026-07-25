import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CapabilitySchema,
  MemoryEntrySchema,
  WorkerIdentitySchema,
  WorkspaceSchema,
} from "../src/contracts/index.js";
import { ApprovalService } from "../src/governance/index.js";
import { LearningService } from "../src/learning/index.js";
import { OrgChangeService } from "../src/org/index.js";
import {
  CapabilityStore,
  Database,
  EventStore,
  MemoryEntryStore,
  OrgChangeProposalStore,
  WorkerIdentityStore,
  WorkspaceStore,
} from "../src/persistence/index.js";
import { createApprovalServiceWithApplications } from "../src/runtime/approvals.js";
import { SensitiveMaterialError } from "../src/security/sensitive-material.js";
import { WorkService } from "../src/work/index.js";
import { WorldModelService } from "../src/world/index.js";

const fixturePath = new URL("../../tests/fixtures/canonical_v0.json", import.meta.url);

let tmpRoot: string;
let database: Database;

async function loadFixture(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(fixturePath, "utf8")) as Record<string, unknown>;
}

async function seedWorkspace(): Promise<string> {
  const fixture = await loadFixture();
  const workspace = WorkspaceSchema.parse(fixture.workspace);
  return new WorkspaceStore(database).save(workspace).id;
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "openmao-ts-learning-"));
  database = new Database(join(tmpRoot, "openmao.sqlite3"));
  database.initialize();
});

afterEach(() => {
  database.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("institutional learning loop", () => {
  it("does not treat one blocked work item and its event as repeated blockers", async () => {
    const workspaceId = await seedWorkspace();
    const work = new WorkService(database);
    const blocked = work.createWork({
      id: "work_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      workspace_id: workspaceId,
      title: "Single blocked item",
      objective: "Block once.",
      owner: "worker:research",
      actor: "test",
    });
    work.setStatus({
      workspace_id: workspaceId,
      work_item_id: blocked.id,
      status: "blocked",
      actor: "test",
    });

    const scan = new LearningService(database).scan(workspaceId);

    expect(scan.proposals.map((item) => item.proposal.source_signal)).not.toContain(
      "repeated_blocker",
    );
  });

  it("detects learning signals and creates evidence-backed org change proposals", async () => {
    const workspaceId = await seedWorkspace();
    const fixture = await loadFixture();
    const work = new WorkService(database);

    const firstBlocked = work.createWork({
      id: "work_11111111111111111111111111111111",
      workspace_id: workspaceId,
      title: "Blocked customer research",
      objective: "Research a blocked customer workflow.",
      owner: "worker:research",
      actor: "test",
    });
    const secondBlocked = work.createWork({
      id: "work_22222222222222222222222222222222",
      workspace_id: workspaceId,
      title: "Blocked onboarding brief",
      objective: "Prepare a brief but missing source access.",
      owner: "worker:research",
      actor: "test",
    });
    work.setStatus({
      workspace_id: workspaceId,
      work_item_id: firstBlocked.id,
      status: "blocked",
      actor: "test",
      reason: "Missing source access.",
    });
    work.setStatus({
      workspace_id: workspaceId,
      work_item_id: secondBlocked.id,
      status: "blocked",
      actor: "test",
      reason: "No reviewer available.",
    });
    const worker = new WorkerIdentityStore(database).save(
      WorkerIdentitySchema.parse({
        ...(fixture.worker_identity as Record<string, unknown>),
        id: "worker_33333333333333333333333333333333",
        workspace_id: workspaceId,
      }),
    );
    const failedWork = work.createWork({
      id: "work_33333333333333333333333333333333",
      workspace_id: workspaceId,
      title: "Failed handoff",
      objective: "Demonstrate a failed worker handoff.",
      owner: worker.id,
      actor: "test",
    });
    const failedEnvelope = work.createBoundedEnvelope({
      id: "envelope_33333333333333333333333333333333",
      workspace_id: workspaceId,
      work_item_id: failedWork.id,
      worker_id: worker.id,
      issued_by: { actor_type: "operator", actor_id: "test", display_name: null },
    });
    work.submitWorkerOutcome({
      id: "outcome_33333333333333333333333333333333",
      workspace_id: workspaceId,
      envelope_id: failedEnvelope.id,
      worker_id: worker.id,
      status: "failed",
      summary: "Worker could not complete the handoff.",
      idempotency_key: "learning:failed-handoff",
    });

    const staleMemory = MemoryEntrySchema.parse({
      ...(fixture.memory_entry as Record<string, unknown>),
      id: "mem_33333333333333333333333333333333",
      workspace_id: workspaceId,
      status: "stale",
    });
    new MemoryEntryStore(database).save(staleMemory);
    new CapabilityStore(database).save(
      CapabilitySchema.parse({
        ...(fixture.capability as Record<string, unknown>),
        name: "mock.missing_provider",
        workspace_id: workspaceId,
        providers: [],
      }),
    );
    const approvalService = new ApprovalService(database);
    approvalService.request({
      approval_id: "approval_44444444444444444444444444444444",
      workspace_id: workspaceId,
      action: "test.first",
      requested_by: "test",
      payload: {
        target_type: "work_item",
        target_id: firstBlocked.id,
        reason: "Review first blocked item.",
        data: {},
      },
      on_approve: "apply_without_run",
      on_reject: "no_op",
    });
    approvalService.request({
      approval_id: "approval_55555555555555555555555555555555",
      workspace_id: workspaceId,
      action: "test.second",
      requested_by: "test",
      payload: {
        target_type: "work_item",
        target_id: secondBlocked.id,
        reason: "Review second blocked item.",
        data: {},
      },
      on_approve: "apply_without_run",
      on_reject: "no_op",
    });

    const scan = new LearningService(database).scan(workspaceId);
    const replayed = new LearningService(database).scan(workspaceId);
    const proposals = new OrgChangeProposalStore(database).listForWorkspace(workspaceId);
    const sourceSignals = proposals.map((proposal) => proposal.source_signal).sort();

    expect(scan.signal_count).toBeGreaterThanOrEqual(4);
    expect(replayed.proposals.map((item) => item.proposal.id).sort()).toEqual(
      scan.proposals.map((item) => item.proposal.id).sort(),
    );
    expect(sourceSignals).toEqual(
      expect.arrayContaining([
        "approval_bottleneck",
        "failed_handoff",
        "missing_capability",
        "repeated_blocker",
        "stale_memory",
      ]),
    );
    expect(proposals.every((proposal) => proposal.evidence.length > 0)).toBe(true);
    expect(JSON.stringify(proposals)).not.toContain("Blocked customer research");
    expect(proposals.every((proposal) => proposal.status === "proposed")).toBe(true);
    expect(
      new EventStore(database).listForWorkspace(workspaceId).map((event) => event.kind),
    ).toEqual(expect.arrayContaining(["org_change.proposed", "learning.scan.completed"]));
  });

  it("rejects sensitive proposal material before persistence", async () => {
    const workspaceId = await seedWorkspace();

    expect(() =>
      new OrgChangeService(database).propose({
        id: "orgchg_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        workspace_id: workspaceId,
        proposed_by: "learning_service",
        change_type: "policy",
        source_signal: "manual",
        rationale: "Rotate credential material.",
        evidence: [
          {
            kind: "other",
            ref_id: "external",
            summary: "operator supplied material",
            weight: 1,
          },
        ],
        patch_json: { api_key: "redacted fixture" },
      }),
    ).toThrow(SensitiveMaterialError);
    expect(new OrgChangeProposalStore(database).listForWorkspace(workspaceId)).toEqual([]);
  });

  it("acknowledges applier-less proposals without silently mutating organization state", async () => {
    const workspaceId = await seedWorkspace();
    const service = new OrgChangeService(database);
    const proposed = service.propose({
      id: "orgchg_66666666666666666666666666666666",
      workspace_id: workspaceId,
      proposed_by: "learning_service",
      change_type: "policy",
      source_signal: "approval_bottleneck",
      rationale: "Approval queue needs policy review.",
      evidence: [
        {
          kind: "approval",
          ref_id: "approval_77777777777777777777777777777777",
          summary: "Pending approval evidence.",
          weight: 1,
        },
      ],
      patch_json: { recommendation: "Review policy." },
    });

    createApprovalServiceWithApplications(database).approve(proposed.approval_id, {
      workspace_id: workspaceId,
      actor: "human",
    });
    const approved = new OrgChangeProposalStore(database).get(proposed.proposal.id);
    expect(approved?.status).toBe("approved");

    // `policy` has no real applier, so the honest terminal status is `acknowledged` — never
    // `applied` (truth-in-status, #105).
    const acknowledged = service.markApplied(proposed.proposal.id, {
      workspace_id: workspaceId,
      actor: "human",
    });
    const replayed = service.markApplied(proposed.proposal.id, {
      workspace_id: workspaceId,
      actor: "another_human",
    });
    expect(acknowledged.status).toBe("acknowledged");
    expect(acknowledged.acknowledged_at).not.toBeNull();
    expect(acknowledged.applied_at).toBeNull();
    expect(replayed).toEqual(acknowledged);
    expect(acknowledged.patch_json).toEqual({ recommendation: "Review policy." });
    const eventKinds = new EventStore(database)
      .listForWorkspace(workspaceId)
      .map((event) => event.kind);
    expect(eventKinds).toEqual(
      expect.arrayContaining(["org_change.approved", "org_change.acknowledged"]),
    );
    expect(eventKinds).not.toContain("org_change.applied");
    expect(eventKinds.filter((kind) => kind === "org_change.acknowledged")).toHaveLength(1);
  });

  it("rejects proposals through approval state and projects open proposals into the world model", async () => {
    const workspaceId = await seedWorkspace();
    const first = new OrgChangeService(database).propose({
      id: "orgchg_88888888888888888888888888888888",
      workspace_id: workspaceId,
      proposed_by: "learning_service",
      change_type: "memory_cleanup",
      source_signal: "stale_memory",
      rationale: "Stale memory needs review.",
      evidence: [
        {
          kind: "memory_entry",
          ref_id: "mem_99999999999999999999999999999999",
          summary: "Stale memory evidence.",
          weight: 1,
        },
      ],
    });
    const second = new OrgChangeService(database).propose({
      id: "orgchg_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      workspace_id: workspaceId,
      proposed_by: "learning_service",
      change_type: "workflow",
      source_signal: "failed_handoff",
      rationale: "Handoff needs review.",
      evidence: [
        {
          kind: "event",
          ref_id: "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          summary: "Failed handoff evidence.",
          weight: 1,
        },
      ],
    });

    new ApprovalService(database).reject(first.approval_id, {
      workspace_id: workspaceId,
      actor: "human",
    });
    const snapshot = new WorldModelService(database).rebuild(workspaceId);

    expect(new OrgChangeProposalStore(database).get(first.proposal.id)?.status).toBe("rejected");
    expect(snapshot.open_org_change_proposals).toEqual([second.proposal.id]);
    expect(snapshot.learning_signals).toEqual(["failed_handoff", "stale_memory"]);
  });
});
