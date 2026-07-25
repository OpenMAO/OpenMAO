import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  EventPayloadSchema,
  MemoryEntrySchema,
  newId,
  utcNow,
  WorkspaceSchema,
} from "../src/contracts/index.js";
import { OrgChangeService } from "../src/org/index.js";
import {
  Database,
  EventStore,
  MemoryEntryStore,
  OrgChangeApplicationStore,
  OrgChangeProposalStore,
  WorkspaceStore,
} from "../src/persistence/index.js";
import { dumpJson } from "../src/persistence/serialization.js";
import { createApprovalServiceWithApplications } from "../src/runtime/approvals.js";

const fixturePath = new URL("../../tests/fixtures/canonical_v0.json", import.meta.url);

// The legacy marker-era proposal the migration must relabel.
const MARKER_PROPOSAL_ID = `orgchg_${"1".repeat(32)}`;
const MARKER_APPROVAL_ID = `approval_${"1".repeat(32)}`;
const MARKER_APPLIED_AT = "2026-05-28T10:00:00Z";

let tmpRoot: string;
let dbPath: string;
let database: Database;
let workspaceId: string;
let realProposalId: string;
let realApplicationId: string;
// payload_json captured before the migration for every row it must NOT touch.
let realProposalBefore: string;
let realApplicationBefore: string;
let eventsBefore: Map<string, string>;

async function seedWorkspace(): Promise<string> {
  const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as Record<string, unknown>;
  return new WorkspaceStore(database).save(WorkspaceSchema.parse(fixture.workspace)).id;
}

/**
 * A REAL applied change produced by the live engine: stale memory entry → memory_cleanup
 * proposal → approve → markApplied. Leaves the proposal `applied`, a `verified`
 * OrgChangeApplication row, and a real `org_change.applied` event. The migration must leave
 * all of it byte-identical.
 */
function seedRealAppliedChange(): void {
  const entry = new MemoryEntryStore(database).save(
    MemoryEntrySchema.parse({
      id: newId("mem"),
      workspace_id: workspaceId,
      scope: "individual",
      owner_id: null,
      kind: "semantic",
      content: "an old fact nobody trusts anymore",
      provenance: {},
      confidence: 0.2,
      status: "stale",
      created_at: utcNow(),
    }),
  );
  const service = new OrgChangeService(database);
  const { proposal, approval_id } = service.propose({
    id: newId("orgchg"),
    workspace_id: workspaceId,
    proposed_by: "learning_service",
    change_type: "memory_cleanup",
    source_signal: "stale_memory",
    rationale: "These stale memory entries should be retired.",
    evidence: [{ kind: "memory_entry", ref_id: entry.id, summary: "confirmed stale", weight: 1 }],
    patch_json: { memory_entries: [entry.id] },
  });
  createApprovalServiceWithApplications(database).approve(approval_id, {
    workspace_id: workspaceId,
    actor: "human",
  });
  service.markApplied(proposal.id, { workspace_id: workspaceId, actor: "operator" });
  realProposalId = proposal.id;
  const application = new OrgChangeApplicationStore(database).getForProposal(
    workspaceId,
    realProposalId,
  );
  if (!application) {
    throw new Error("expected a real application record");
  }
  realApplicationId = application.id;
}

/**
 * A legacy marker-era row, persisted exactly as the pre-#105 writer left it: the proposal
 * row carries status `applied` (with `applied_at` stamped and no acknowledged/withdrawn keys —
 * those did not exist yet), and the event log carries `org_change.applied` stamped
 * `applied_as_marker_only: true`. Today's store refuses to create rows born `applied`, so the
 * row is inserted directly — which is precisely how a real legacy database file presents
 * itself to the migration.
 */
function seedLegacyMarkerRow(): void {
  const legacyPayload = {
    id: MARKER_PROPOSAL_ID,
    workspace_id: workspaceId,
    proposed_by: "learning_service",
    change_type: "policy",
    source_signal: "approval_bottleneck",
    rationale: "Approval queue needs policy review.",
    evidence: [
      { kind: "approval", ref_id: MARKER_APPROVAL_ID, summary: "queue evidence", weight: 1 },
    ],
    patch_json: { recommendation: "Review policy." },
    confidence: 0.5,
    impact: "medium",
    review_approval_id: MARKER_APPROVAL_ID,
    status: "applied",
    created_at: "2026-05-28T09:00:00Z",
    resolved_at: "2026-05-28T09:30:00Z",
    applied_at: MARKER_APPLIED_AT,
  };
  database.connection
    .prepare(
      `INSERT INTO org_change_proposals (id, workspace_id, status, payload_json)
       VALUES (?, ?, 'applied', ?)`,
    )
    .run(MARKER_PROPOSAL_ID, workspaceId, dumpJson(legacyPayload));
  // The marker event is appended through the live EventStore (hash-chained), exactly as the
  // legacy markApplied emitted it. The migration must read it — and must NOT rewrite it.
  new EventStore(database).append({
    workspace_id: workspaceId,
    kind: "org_change.applied",
    actor: "operator",
    payload: EventPayloadSchema.parse({
      data: { org_change_proposal: legacyPayload, applied_as_marker_only: true },
      refs: [MARKER_PROPOSAL_ID],
    }),
    idempotency_key: `${MARKER_PROPOSAL_ID}:applied`,
  });
}

/**
 * A forged marker event naming the REAL proposal. The application-row guard must keep the
 * real proposal `applied` even when such an event exists.
 */
function seedForgedMarkerEvent(): void {
  const realProposal = new OrgChangeProposalStore(database).get(realProposalId);
  new EventStore(database).append({
    workspace_id: workspaceId,
    kind: "org_change.applied",
    actor: "operator",
    payload: EventPayloadSchema.parse({
      data: { org_change_proposal: realProposal, applied_as_marker_only: true },
      refs: [realProposalId],
    }),
    idempotency_key: `${realProposalId}:applied:forged-marker`,
  });
}

/**
 * Re-stamp the file as schema v7. v8 changed no table shapes (it is a data-only relabel), so a
 * v8-initialized file with the v7 stamp is equivalent to a real pre-#105 database for the
 * migration's purposes.
 */
function stampAsV7(): void {
  database.connection.prepare("DELETE FROM schema_version WHERE version = 8").run();
  database.connection.pragma("user_version = 7");
}

function reopenDatabase(): void {
  database.close();
  database = new Database(dbPath);
  database.initialize();
}

function proposalRow(proposalId: string): { status: string; payload_json: string } {
  const row = database.connection
    .prepare("SELECT status, payload_json FROM org_change_proposals WHERE id = ?")
    .get(proposalId) as { status: string; payload_json: string } | undefined;
  if (!row) {
    throw new Error(`expected proposal row: ${proposalId}`);
  }
  return row;
}

function applicationPayloadJson(applicationId: string): string {
  const row = database.connection
    .prepare("SELECT payload_json FROM org_change_applications WHERE id = ?")
    .get(applicationId) as { payload_json: string } | undefined;
  if (!row) {
    throw new Error(`expected application row: ${applicationId}`);
  }
  return row.payload_json;
}

function allEventPayloadJson(): Map<string, string> {
  const rows = database.connection
    .prepare("SELECT id, payload_json FROM events ORDER BY workspace_id, seq")
    .all() as Array<{ id: string; payload_json: string }>;
  return new Map(rows.map((row) => [row.id, row.payload_json]));
}

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "openmao-ts-truth-status-"));
  dbPath = join(tmpRoot, "openmao.sqlite3");
  database = new Database(dbPath);
  database.initialize();
  workspaceId = await seedWorkspace();
  seedRealAppliedChange();
  seedLegacyMarkerRow();
  seedForgedMarkerEvent();
  realProposalBefore = proposalRow(realProposalId).payload_json;
  realApplicationBefore = applicationPayloadJson(realApplicationId);
  eventsBefore = allEventPayloadJson();
  stampAsV7();
  // Reopen: initialize() must run the one-time v8 relabel on open, exactly as it would for a
  // real pre-#105 database file.
  reopenDatabase();
});

afterEach(() => {
  database.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("v8 one-time truth-in-status relabel of marker-only applied org changes (#105)", () => {
  it("relabels a legacy marker-applied proposal to acknowledged, moving applied_at to acknowledged_at", () => {
    expect(proposalRow(MARKER_PROPOSAL_ID).status).toBe("acknowledged");
    const relabeled = new OrgChangeProposalStore(database).get(MARKER_PROPOSAL_ID);
    expect(relabeled?.status).toBe("acknowledged");
    expect(relabeled?.acknowledged_at).toBe(MARKER_APPLIED_AT);
    expect(relabeled?.applied_at).toBeNull();
    // The ratified recommendation stays fully auditable on the relabeled record.
    expect(relabeled?.patch_json).toEqual({ recommendation: "Review policy." });
    expect(relabeled?.resolved_at).toBe("2026-05-28T09:30:00Z");
  });

  it("leaves real applied/verified rows byte-identical — even against a forged marker event", () => {
    expect(proposalRow(realProposalId).status).toBe("applied");
    expect(proposalRow(realProposalId).payload_json).toBe(realProposalBefore);
    expect(applicationPayloadJson(realApplicationId)).toBe(realApplicationBefore);
    expect(new OrgChangeApplicationStore(database).get(realApplicationId)?.status).toBe("verified");
  });

  it("never rewrites the event log: marker events remain the append-only audit trail", () => {
    expect(allEventPayloadJson()).toEqual(eventsBefore);
    expect(new EventStore(database).verifyChain(workspaceId)).toEqual({ ok: true });
  });

  it("stamps schema version 8, and re-running the relabel changes nothing", () => {
    expect(database.connection.pragma("user_version", { simple: true })).toBe(8);

    const markerAfterFirstRun = proposalRow(MARKER_PROPOSAL_ID).payload_json;
    stampAsV7();
    reopenDatabase();

    expect(proposalRow(MARKER_PROPOSAL_ID).payload_json).toBe(markerAfterFirstRun);
    expect(proposalRow(realProposalId).payload_json).toBe(realProposalBefore);
    expect(allEventPayloadJson()).toEqual(eventsBefore);
    expect(database.connection.pragma("user_version", { simple: true })).toBe(8);
  });

  it("gives relabeled records working revert semantics: withdrawal", () => {
    const withdrawn = new OrgChangeService(database).withdraw(MARKER_PROPOSAL_ID, {
      workspace_id: workspaceId,
      actor: "operator",
    });
    expect(withdrawn.status).toBe("withdrawn");
    expect(withdrawn.withdrawn_at).not.toBeNull();
    const kinds = new EventStore(database).listForWorkspace(workspaceId).map((event) => event.kind);
    expect(kinds).toContain("org_change.withdrawn");
  });
});
