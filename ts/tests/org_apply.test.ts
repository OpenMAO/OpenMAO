import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type MemoryEntry,
  MemoryEntrySchema,
  newId,
  utcNow,
  WorkspaceSchema,
} from "../src/contracts/index.js";
import { LearningService } from "../src/learning/index.js";
import {
  EvidenceRequiredError,
  OrgChangeApplyError,
  OrgChangeApplyPausedError,
  OrgChangeApplyService,
  OrgChangeBlastRadiusError,
  OrgChangeRevertConflictError,
  OrgChangeService,
  OrgChangeServiceError,
  OrgControlService,
  ProposerApplierSeparationError,
} from "../src/org/index.js";
import {
  Database,
  EventStore,
  MemoryEntryStatusConflictError,
  MemoryEntryStore,
  OrgChangeApplicationStore,
  OrgChangeProposalStore,
  OrgControlStore,
  WorkspaceStore,
} from "../src/persistence/index.js";
import { createApprovalServiceWithApplications } from "../src/runtime/approvals.js";

const fixturePath = new URL("../../tests/fixtures/canonical_v0.json", import.meta.url);

let tmpRoot: string;
let database: Database;

async function seedWorkspace(): Promise<string> {
  const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as Record<string, unknown>;
  return new WorkspaceStore(database).save(WorkspaceSchema.parse(fixture.workspace)).id;
}

async function seedSecondWorkspace(): Promise<string> {
  const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as Record<string, unknown>;
  const base = WorkspaceSchema.parse(fixture.workspace);
  const second = WorkspaceSchema.parse({
    ...base,
    id: `ws_${"f".repeat(32)}`,
    name: "Second Workspace",
    default_org_id: null,
  });
  return new WorkspaceStore(database).save(second).id;
}

function makeEntry(
  workspaceId: string,
  options: { status?: MemoryEntry["status"]; content?: string } = {},
): MemoryEntry {
  return new MemoryEntryStore(database).save(
    MemoryEntrySchema.parse({
      id: newId("mem"),
      workspace_id: workspaceId,
      scope: "individual",
      owner_id: null,
      kind: "semantic",
      content: options.content ?? "an old fact nobody trusts anymore",
      provenance: {},
      confidence: 0.2,
      status: options.status ?? "stale",
      created_at: utcNow(),
    }),
  );
}

function proposeCleanup(
  workspaceId: string,
  targetRefs: string[],
  options: { proposed_by?: string; withEvidence?: boolean } = {},
): { proposalId: string; approvalId: string } {
  const withEvidence = options.withEvidence ?? true;
  const { proposal, approval_id } = new OrgChangeService(database).propose({
    id: newId("orgchg"),
    workspace_id: workspaceId,
    proposed_by: options.proposed_by ?? "learning_service",
    change_type: "memory_cleanup",
    source_signal: "stale_memory",
    rationale: "These stale memory entries should be retired.",
    evidence: withEvidence
      ? [
          {
            kind: "memory_entry",
            ref_id: targetRefs[0] ?? "",
            summary: "confirmed stale",
            weight: 1,
          },
        ]
      : [],
    patch_json: { memory_entries: targetRefs },
    confidence: 0.8,
    impact: "low",
  });
  return { proposalId: proposal.id, approvalId: approval_id };
}

function approve(workspaceId: string, approvalId: string): void {
  createApprovalServiceWithApplications(database).approve(approvalId, {
    workspace_id: workspaceId,
    actor: "human",
  });
}

/** A stale memory_cleanup proposal, approved and ready to apply. */
function approvedCleanup(
  workspaceId: string,
  entries: string[],
  options: { proposed_by?: string; withEvidence?: boolean } = {},
): string {
  const { proposalId, approvalId } = proposeCleanup(workspaceId, entries, options);
  approve(workspaceId, approvalId);
  return proposalId;
}

function eventKinds(workspaceId: string): string[] {
  return new EventStore(database).listForWorkspace(workspaceId).map((event) => event.kind);
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "openmao-ts-apply-"));
  database = new Database(join(tmpRoot, "openmao.sqlite3"));
  database.initialize();
});

afterEach(() => {
  database.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("M1 reversible apply — memory_cleanup", () => {
  it("flips stale → rejected, records a verified application, and emits applied + verified", async () => {
    const workspaceId = await seedWorkspace();
    const first = makeEntry(workspaceId);
    const second = makeEntry(workspaceId);
    const proposalId = approvedCleanup(workspaceId, [first.id, second.id]);

    const application = new OrgChangeApplyService(database).apply(proposalId, {
      workspace_id: workspaceId,
      actor: "operator",
    });

    expect(application.status).toBe("verified");
    expect(application.reversible).toBe(true);
    expect(application.targets).toHaveLength(2);
    expect(application.targets.map((target) => target.before_status)).toEqual(["stale", "stale"]);
    expect(application.targets.map((target) => target.after_status)).toEqual([
      "rejected",
      "rejected",
    ]);

    const memory = new MemoryEntryStore(database);
    expect(memory.get(first.id)?.status).toBe("rejected");
    expect(memory.get(second.id)?.status).toBe("rejected");
    expect(new OrgChangeProposalStore(database).get(proposalId)?.status).toBe("applied");
    expect(eventKinds(workspaceId)).toEqual(
      expect.arrayContaining(["org_change.applied", "org_change.verified"]),
    );
  });

  it("is idempotent: re-applying returns the same application and mutates only once", async () => {
    const workspaceId = await seedWorkspace();
    const entry = makeEntry(workspaceId);
    const proposalId = approvedCleanup(workspaceId, [entry.id]);

    const firstApply = new OrgChangeApplyService(database).apply(proposalId, {
      workspace_id: workspaceId,
      actor: "operator",
    });
    const replay = new OrgChangeApplyService(database).apply(proposalId, {
      workspace_id: workspaceId,
      actor: "a_different_operator",
    });

    expect(replay).toEqual(firstApply);
    expect(eventKinds(workspaceId).filter((kind) => kind === "org_change.applied")).toHaveLength(1);
  });

  it("reverts a verified application: flips rejected → stale and records the revert", async () => {
    const workspaceId = await seedWorkspace();
    const entry = makeEntry(workspaceId);
    const proposalId = approvedCleanup(workspaceId, [entry.id]);
    const service = new OrgChangeApplyService(database);
    const application = service.apply(proposalId, { workspace_id: workspaceId, actor: "operator" });

    const reverted = service.revert(application.id, {
      workspace_id: workspaceId,
      actor: "operator",
    });

    expect(reverted.status).toBe("reverted");
    expect(new MemoryEntryStore(database).get(entry.id)?.status).toBe("stale");
    expect(eventKinds(workspaceId)).toContain("org_change.reverted");
  });

  it("refuses to revert when a target drifted since it was applied (revert-conflict)", async () => {
    const workspaceId = await seedWorkspace();
    const entry = makeEntry(workspaceId);
    const proposalId = approvedCleanup(workspaceId, [entry.id]);
    const service = new OrgChangeApplyService(database);
    const application = service.apply(proposalId, { workspace_id: workspaceId, actor: "operator" });

    // Out-of-band drift: the entry is moved off the state the application left it in.
    new MemoryEntryStore(database).setStatusIfCurrent(entry.id, {
      workspace_id: workspaceId,
      expected_status: "rejected",
      next_status: "stale",
    });

    expect(() =>
      service.revert(application.id, { workspace_id: workspaceId, actor: "operator" }),
    ).toThrow(OrgChangeRevertConflictError);
  });
});

describe("M1 reversible apply — guardrails", () => {
  it("refuses to apply when the operator kill-switch is engaged, leaving state untouched", async () => {
    const workspaceId = await seedWorkspace();
    const entry = makeEntry(workspaceId);
    const proposalId = approvedCleanup(workspaceId, [entry.id]);
    new OrgControlStore(database).setApplyPaused(workspaceId, {
      paused: true,
      updated_by: "operator",
    });

    expect(() =>
      new OrgChangeApplyService(database).apply(proposalId, {
        workspace_id: workspaceId,
        actor: "operator",
      }),
    ).toThrow(OrgChangeApplyPausedError);

    expect(new MemoryEntryStore(database).get(entry.id)?.status).toBe("stale");
    expect(new OrgChangeProposalStore(database).get(proposalId)?.status).toBe("approved");
  });

  it("refuses to apply more targets than the blast-radius cap", async () => {
    const workspaceId = await seedWorkspace();
    const first = makeEntry(workspaceId);
    const second = makeEntry(workspaceId);
    const proposalId = approvedCleanup(workspaceId, [first.id, second.id]);

    expect(() =>
      new OrgChangeApplyService(database, { maxBlastRadius: 1 }).apply(proposalId, {
        workspace_id: workspaceId,
        actor: "operator",
      }),
    ).toThrow(OrgChangeBlastRadiusError);

    expect(new MemoryEntryStore(database).get(first.id)?.status).toBe("stale");
    expect(new MemoryEntryStore(database).get(second.id)?.status).toBe("stale");
  });

  it("refuses to apply when the applier is the proposer (no self-rubber-stamping)", async () => {
    const workspaceId = await seedWorkspace();
    const entry = makeEntry(workspaceId);
    const proposalId = approvedCleanup(workspaceId, [entry.id], { proposed_by: "agent_scribe" });

    expect(() =>
      new OrgChangeApplyService(database).apply(proposalId, {
        workspace_id: workspaceId,
        actor: "agent_scribe",
      }),
    ).toThrow(ProposerApplierSeparationError);
  });

  it("refuses to apply a proposal that carries no evidence", async () => {
    const workspaceId = await seedWorkspace();
    const entry = makeEntry(workspaceId);
    const proposalId = approvedCleanup(workspaceId, [entry.id], { withEvidence: false });

    expect(() =>
      new OrgChangeApplyService(database).apply(proposalId, {
        workspace_id: workspaceId,
        actor: "operator",
      }),
    ).toThrow(EvidenceRequiredError);
  });

  it("refuses to clean up a memory entry that is not stale, leaving it untouched", async () => {
    const workspaceId = await seedWorkspace();
    const confirmed = makeEntry(workspaceId, { status: "confirmed" });
    const proposalId = approvedCleanup(workspaceId, [confirmed.id]);

    expect(() =>
      new OrgChangeApplyService(database).apply(proposalId, {
        workspace_id: workspaceId,
        actor: "operator",
      }),
    ).toThrow(MemoryEntryStatusConflictError);

    expect(new MemoryEntryStore(database).get(confirmed.id)?.status).toBe("confirmed");
  });
});

describe("M1 reversible apply — markApplied integration", () => {
  it("routes memory_cleanup through the real engine, mutating org state", async () => {
    const workspaceId = await seedWorkspace();
    const entry = makeEntry(workspaceId);
    const proposalId = approvedCleanup(workspaceId, [entry.id]);

    const applied = new OrgChangeService(database).markApplied(proposalId, {
      workspace_id: workspaceId,
      actor: "operator",
    });

    expect(applied.status).toBe("applied");
    expect(new MemoryEntryStore(database).get(entry.id)?.status).toBe("rejected");
    // The real path does not stamp the marker-only flag.
    const appliedEvent = new EventStore(database)
      .listForWorkspace(workspaceId)
      .find((event) => event.kind === "org_change.applied");
    expect(appliedEvent?.payload.data.applied_as_marker_only).toBeUndefined();
  });

  it("has no applier for change types still on the marker path", () => {
    expect(new OrgChangeApplyService(database).hasApplier("policy")).toBe(false);
    expect(new OrgChangeApplyService(database).hasApplier("memory_cleanup")).toBe(true);
  });

  it("applies a real detector-generated memory_cleanup proposal end to end (scan → approve → apply)", async () => {
    const workspaceId = await seedWorkspace();
    const first = makeEntry(workspaceId);
    const second = makeEntry(workspaceId);

    // The learning detector emits the proposal (with patch_json.memory_entries); the engine must
    // consume that exact contract — this is the path that broke when the applier expected a
    // different key.
    const scan = new LearningService(database).scan(workspaceId);
    const cleanup = scan.proposals.find((item) => item.proposal.change_type === "memory_cleanup");
    expect(cleanup).toBeDefined();
    approve(workspaceId, cleanup?.approval_id ?? "");

    const applied = new OrgChangeService(database).markApplied(cleanup?.proposal.id ?? "", {
      workspace_id: workspaceId,
      actor: "operator",
    });

    expect(applied.status).toBe("applied");
    const memory = new MemoryEntryStore(database);
    expect(memory.get(first.id)?.status).toBe("rejected");
    expect(memory.get(second.id)?.status).toBe("rejected");
    expect(
      new OrgChangeApplicationStore(database).getForProposal(workspaceId, applied.id)?.status,
    ).toBe("verified");
  });

  it("the kill-switch also blocks the legacy marker path", async () => {
    const workspaceId = await seedWorkspace();
    const service = new OrgChangeService(database);
    const { proposal, approval_id } = service.propose({
      id: newId("orgchg"),
      workspace_id: workspaceId,
      proposed_by: "learning_service",
      change_type: "policy",
      rationale: "Tighten the review policy.",
      evidence: [
        { kind: "approval", ref_id: `approval_${"0".repeat(32)}`, summary: "queue", weight: 1 },
      ],
      patch_json: { recommendation: "review" },
    });
    approve(workspaceId, approval_id);
    new OrgControlService(database).pauseApply(workspaceId, { actor: "operator" });

    expect(() =>
      service.markApplied(proposal.id, { workspace_id: workspaceId, actor: "operator" }),
    ).toThrow(OrgChangeApplyPausedError);
    expect(new OrgChangeProposalStore(database).get(proposal.id)?.status).toBe("approved");
  });
});

describe("truth-in-status for applier-less change types (#105)", () => {
  /** An approved `policy` proposal — a change type with NO registered applier. */
  function approvedPolicyChange(workspaceId: string): string {
    const { proposal, approval_id } = new OrgChangeService(database).propose({
      id: newId("orgchg"),
      workspace_id: workspaceId,
      proposed_by: "learning_service",
      change_type: "policy",
      rationale: "Tighten the review policy.",
      evidence: [
        { kind: "approval", ref_id: `approval_${"0".repeat(32)}`, summary: "queue", weight: 1 },
      ],
      patch_json: { recommendation: "Review the approval policy." },
    });
    approve(workspaceId, approval_id);
    return proposal.id;
  }

  it("acknowledges instead of applying: honest status, honest event, no application row", async () => {
    const workspaceId = await seedWorkspace();
    const proposalId = approvedPolicyChange(workspaceId);

    const acknowledged = new OrgChangeService(database).markApplied(proposalId, {
      workspace_id: workspaceId,
      actor: "operator",
    });

    expect(acknowledged.status).toBe("acknowledged");
    expect(acknowledged.acknowledged_at).not.toBeNull();
    expect(acknowledged.applied_at).toBeNull();
    // No OrgChangeApplication row: nothing was applied, so nothing claims it was.
    expect(
      new OrgChangeApplicationStore(database).getForProposal(workspaceId, proposalId),
    ).toBeNull();
    // The event says honestly what happened — and never `org_change.applied`.
    const events = new EventStore(database).listForWorkspace(workspaceId);
    expect(events.map((event) => event.kind)).not.toContain("org_change.applied");
    const acknowledgedEvent = events.find((event) => event.kind === "org_change.acknowledged");
    expect(acknowledgedEvent?.payload.data.applied).toBe(false);
    expect(acknowledgedEvent?.payload.data.no_applier_registered).toBe(true);
    // The ratified recommendation stays auditable on the event payload.
    expect(
      (acknowledgedEvent?.payload.data.org_change_proposal as { patch_json: unknown }).patch_json,
    ).toEqual({ recommendation: "Review the approval policy." });
  });

  it("replaying apply on an acknowledged record is idempotent and never graduates it", async () => {
    const workspaceId = await seedWorkspace();
    const proposalId = approvedPolicyChange(workspaceId);
    const service = new OrgChangeService(database);

    const first = service.markApplied(proposalId, { workspace_id: workspaceId, actor: "operator" });
    const replay = service.markApplied(proposalId, {
      workspace_id: workspaceId,
      actor: "another_operator",
    });

    expect(replay).toEqual(first);
    expect(replay.status).toBe("acknowledged");
    expect(
      eventKinds(workspaceId).filter((kind) => kind === "org_change.acknowledged"),
    ).toHaveLength(1);
  });

  it("withdraws an acknowledged record (its defined revert semantics), idempotently", async () => {
    const workspaceId = await seedWorkspace();
    const proposalId = approvedPolicyChange(workspaceId);
    const service = new OrgChangeService(database);
    service.markApplied(proposalId, { workspace_id: workspaceId, actor: "operator" });

    const withdrawn = service.withdraw(proposalId, {
      workspace_id: workspaceId,
      actor: "operator",
    });
    const replay = service.withdraw(proposalId, { workspace_id: workspaceId, actor: "operator" });

    expect(withdrawn.status).toBe("withdrawn");
    expect(withdrawn.withdrawn_at).not.toBeNull();
    expect(replay).toEqual(withdrawn);
    expect(eventKinds(workspaceId).filter((kind) => kind === "org_change.withdrawn")).toHaveLength(
      1,
    );
    expect(new OrgChangeProposalStore(database).get(proposalId)?.status).toBe("withdrawn");
  });

  it("refuses to withdraw a really-applied change — reverting the application is the path", async () => {
    const workspaceId = await seedWorkspace();
    const entry = makeEntry(workspaceId);
    const proposalId = approvedCleanup(workspaceId, [entry.id]);
    const service = new OrgChangeService(database);
    service.markApplied(proposalId, { workspace_id: workspaceId, actor: "operator" });

    expect(() =>
      service.withdraw(proposalId, { workspace_id: workspaceId, actor: "operator" }),
    ).toThrow(OrgChangeServiceError);
    expect(new OrgChangeProposalStore(database).get(proposalId)?.status).toBe("applied");
    expect(eventKinds(workspaceId)).not.toContain("org_change.withdrawn");
  });

  it("refuses to withdraw a proposal that was never acknowledged", async () => {
    const workspaceId = await seedWorkspace();
    const proposalId = approvedPolicyChange(workspaceId);

    expect(() =>
      new OrgChangeService(database).withdraw(proposalId, {
        workspace_id: workspaceId,
        actor: "operator",
      }),
    ).toThrow(OrgChangeServiceError);
    expect(new OrgChangeProposalStore(database).get(proposalId)?.status).toBe("approved");
  });
});

describe("M1 reversible apply — isolation, atomicity, and edge cases", () => {
  it("refuses to clean up a memory entry that belongs to another workspace", async () => {
    const workspaceA = await seedWorkspace();
    const workspaceB = await seedSecondWorkspace();
    const victim = makeEntry(workspaceB); // a stale entry living in workspace B
    const proposalId = approvedCleanup(workspaceA, [victim.id]); // a proposal in A naming B's id

    expect(() =>
      new OrgChangeApplyService(database).apply(proposalId, {
        workspace_id: workspaceA,
        actor: "operator",
      }),
    ).toThrow(OrgChangeApplyError);

    expect(new MemoryEntryStore(database).get(victim.id)?.status).toBe("stale");
  });

  it("rolls the whole application back if any target fails mid-apply (atomicity)", async () => {
    const workspaceId = await seedWorkspace();
    const stale = makeEntry(workspaceId);
    const confirmed = makeEntry(workspaceId, { status: "confirmed" });
    const proposalId = approvedCleanup(workspaceId, [stale.id, confirmed.id]);

    expect(() =>
      new OrgChangeApplyService(database).apply(proposalId, {
        workspace_id: workspaceId,
        actor: "operator",
      }),
    ).toThrow(MemoryEntryStatusConflictError);

    // The first target's flip was rolled back; no application or applied event persisted.
    expect(new MemoryEntryStore(database).get(stale.id)?.status).toBe("stale");
    expect(new MemoryEntryStore(database).get(confirmed.id)?.status).toBe("confirmed");
    expect(
      new OrgChangeApplicationStore(database).getForProposal(workspaceId, proposalId),
    ).toBeNull();
    expect(eventKinds(workspaceId)).not.toContain("org_change.applied");
  });

  it("rejects a proposal that resolves no targets", async () => {
    const workspaceId = await seedWorkspace();
    const proposalId = approvedCleanup(workspaceId, []);

    expect(() =>
      new OrgChangeApplyService(database).apply(proposalId, {
        workspace_id: workspaceId,
        actor: "operator",
      }),
    ).toThrow(OrgChangeApplyError);
  });

  it("deduplicates duplicate target refs into a single application target", async () => {
    const workspaceId = await seedWorkspace();
    const entry = makeEntry(workspaceId);
    const proposalId = approvedCleanup(workspaceId, [entry.id, entry.id]);

    const application = new OrgChangeApplyService(database).apply(proposalId, {
      workspace_id: workspaceId,
      actor: "operator",
    });

    expect(application.targets).toHaveLength(1);
    expect(new MemoryEntryStore(database).get(entry.id)?.status).toBe("rejected");
  });

  it("double-revert is idempotent and records exactly one revert", async () => {
    const workspaceId = await seedWorkspace();
    const entry = makeEntry(workspaceId);
    const proposalId = approvedCleanup(workspaceId, [entry.id]);
    const service = new OrgChangeApplyService(database);
    const application = service.apply(proposalId, { workspace_id: workspaceId, actor: "operator" });

    const first = service.revert(application.id, { workspace_id: workspaceId, actor: "operator" });
    const second = service.revert(application.id, { workspace_id: workspaceId, actor: "operator" });

    expect(second).toEqual(first);
    expect(eventKinds(workspaceId).filter((kind) => kind === "org_change.reverted")).toHaveLength(
      1,
    );
  });

  it("records an audited event when the kill-switch is toggled", async () => {
    const workspaceId = await seedWorkspace();
    const service = new OrgControlService(database);

    service.pauseApply(workspaceId, { actor: "operator", reason: "incident" });
    service.resumeApply(workspaceId, { actor: "operator" });

    expect(eventKinds(workspaceId)).toEqual(
      expect.arrayContaining(["org_control.apply_paused", "org_control.apply_resumed"]),
    );
    expect(service.get(workspaceId).apply_paused).toBe(false);
  });
});
