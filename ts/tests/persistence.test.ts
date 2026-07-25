import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type ApprovalRequest,
  ApprovalRequestSchema,
  BoundedWorkEnvelopeSchema,
  EventPayloadSchema,
  IngestionRecordSchema,
  NodeEffectSchema,
  type Run,
  RunSchema,
  ToolSchema,
  WorkerIdentitySchema,
  WorkerOutcomeSchema,
  WorkItemSchema,
  type Workspace,
  WorkspaceSchema,
} from "../src/contracts/index.js";
import {
  ActiveRunExistsError,
  BoundedWorkEnvelopeStore,
  Database,
  EventIdempotencyConflictError,
  EventStore,
  IngestionRecordConflictError,
  IngestionRecordStore,
  InvalidRunTransitionError,
  NodeEffectStore,
  RunStore,
  ToolStore,
  WorkerIdentityStore,
  WorkerOutcomeConflictError,
  WorkerOutcomeStore,
  WorkItemStore,
  WorkspaceConflictError,
  WorkspaceStore,
} from "../src/persistence/index.js";

const fixturePath = new URL("../../tests/fixtures/canonical_v0.json", import.meta.url);

let tmpRoot: string;
let database: Database;

async function loadFixture(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(fixturePath, "utf8")) as Record<string, unknown>;
}

async function seedWorkspace(): Promise<Workspace> {
  const fixture = await loadFixture();
  const workspace = WorkspaceSchema.parse(fixture.workspace);
  return new WorkspaceStore(database).save(workspace);
}

async function seedQueuedRun(): Promise<Run> {
  await seedWorkspace();
  const fixture = await loadFixture();
  const fixtureRun = RunSchema.parse(fixture.run);
  const run = RunSchema.parse({
    ...fixtureRun,
    status: "queued",
    active_node: null,
    suspended_approval_id: null,
    updated_at: fixtureRun.created_at,
  });
  return new RunStore(database).create(run);
}

async function seedPendingApproval(run: Run): Promise<ApprovalRequest> {
  const fixture = await loadFixture();
  const approval = ApprovalRequestSchema.parse({
    ...(fixture.approval_request as Record<string, unknown>),
    workspace_id: run.workspace_id,
    run_id: run.id,
    status: "pending",
    resolved_at: null,
  });

  database.transaction(() => {
    database.connection
      .prepare(
        `INSERT INTO approval_requests (id, workspace_id, run_id, status, payload_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        approval.id,
        approval.workspace_id,
        approval.run_id,
        approval.status,
        JSON.stringify(approval),
      );
  });
  return approval;
}

function resolveApproval(
  approval: ApprovalRequest,
  status: "approved" | "rejected",
): ApprovalRequest {
  const resolved = ApprovalRequestSchema.parse({
    ...approval,
    status,
    resolved_at: "2026-05-27T15:20:09Z",
  });
  database.transaction(() => {
    database.connection
      .prepare(
        `UPDATE approval_requests
         SET status = ?, payload_json = ?
         WHERE id = ? AND workspace_id = ? AND run_id = ?`,
      )
      .run(
        resolved.status,
        JSON.stringify(resolved),
        resolved.id,
        resolved.workspace_id,
        resolved.run_id,
      );
  });
  return resolved;
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "openmao-ts-"));
  database = new Database(join(tmpRoot, "openmao.sqlite3"));
  database.initialize();
});

afterEach(() => {
  database.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("TypeScript persistence", () => {
  it("initializes the gate persistence tables", () => {
    const rows = database.connection
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    const tableNames = new Set(rows.map((row) => row.name));
    const userVersion = database.connection.pragma("user_version", { simple: true });

    expect([...tableNames]).toEqual(
      expect.arrayContaining([
        "schema_version",
        "workspaces",
        "organizations",
        "roles",
        "agents",
        "tools",
        "worker_identities",
        "goals",
        "work_items",
        "runs",
        "task_envelopes",
        "bounded_work_envelopes",
        "worker_outcomes",
        "checkpoints",
        "approval_requests",
        "policies",
        "capabilities",
        "capability_calls",
        "capability_results",
        "model_requests",
        "model_responses",
        "individual_memory",
        "promotion_candidates",
        "artifacts",
        "world_model_snapshots",
        "org_change_proposals",
        "org_change_applications",
        "org_control",
        "autonomy_cases",
        "events",
        "ingestion_records",
        "traces",
        "node_effects",
        "active_run_locks",
        "worker_credentials",
      ]),
    );
    expect(userVersion).toBe(8);
  });

  it("saves workspaces idempotently and rejects conflicting overwrites", async () => {
    const workspace = await seedWorkspace();
    const store = new WorkspaceStore(database);

    expect(store.save(workspace)).toEqual(workspace);
    expect(store.get(workspace.id)).toEqual(workspace);
    expect(store.listAll()).toEqual([workspace]);
    expect(() => store.save({ ...workspace, name: "Changed Workspace" })).toThrow(
      WorkspaceConflictError,
    );
  });

  it("persists worker, tool, bounded envelope, outcome, and ingestion records idempotently", async () => {
    const run = await seedQueuedRun();
    const fixture = await loadFixture();
    const workItem = new WorkItemStore(database).save(WorkItemSchema.parse(fixture.work_item));
    const tool = ToolSchema.parse(fixture.tool);
    const worker = WorkerIdentitySchema.parse(fixture.worker_identity);
    const envelope = BoundedWorkEnvelopeSchema.parse(fixture.bounded_work_envelope);
    const outcome = WorkerOutcomeSchema.parse(fixture.worker_outcome);
    const ingestion = IngestionRecordSchema.parse(fixture.ingestion_record);

    const tools = new ToolStore(database);
    const workers = new WorkerIdentityStore(database);
    const envelopes = new BoundedWorkEnvelopeStore(database);
    const outcomes = new WorkerOutcomeStore(database);
    const ingestionRecords = new IngestionRecordStore(database);

    expect(tools.save(tool)).toEqual(tool);
    expect(workers.save(worker)).toEqual(worker);
    expect(envelopes.save(envelope)).toEqual(envelope);
    expect(outcomes.record(outcome)).toEqual(outcome);
    expect(ingestionRecords.record(ingestion)).toEqual(ingestion);

    expect(envelope.run_id).toBe(run.id);
    expect(tools.listForWorkspace(tool.workspace_id)).toEqual([tool]);
    expect(workers.listForWorkspace(worker.workspace_id)).toEqual([worker]);
    expect(envelopes.listForWorkItem(workItem.workspace_id, workItem.id)).toEqual([envelope]);
    expect(outcomes.listForWorkItem(workItem.workspace_id, workItem.id)).toEqual([outcome]);
    expect(outcomes.record(outcome)).toEqual(outcome);
    expect(() =>
      outcomes.record(
        WorkerOutcomeSchema.parse({
          ...outcome,
          id: "outcome_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          summary: "Changed",
        }),
      ),
    ).toThrow(WorkerOutcomeConflictError);
    expect(ingestionRecords.listForWorkItem(workItem.workspace_id, workItem.id)).toEqual([
      ingestion,
    ]);
    expect(ingestionRecords.listForWorkspace(workItem.workspace_id)).toEqual([ingestion]);
    expect(ingestionRecords.record(ingestion)).toEqual(ingestion);
    expect(() =>
      ingestionRecords.record(
        IngestionRecordSchema.parse({
          ...ingestion,
          id: "ingest_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          payload: { changed: true },
        }),
      ),
    ).toThrow(IngestionRecordConflictError);
  });

  it("allocates event sequences, enforces idempotency, and keeps events append-only", async () => {
    const run = await seedQueuedRun();
    const runStore = new RunStore(database);
    runStore.setStatus(run.id, "running", {
      active_node: "started",
      updated_at: "2026-05-27T15:20:02Z",
    });
    const eventStore = new EventStore(database);
    const payload = EventPayloadSchema.parse({ data: { run_id: run.id }, refs: [run.id] });

    const workspaceEvent = eventStore.append({
      workspace_id: run.workspace_id,
      kind: "workspace.created",
      actor: "test",
      idempotency_key: "workspace:init",
    });
    const runEvent = eventStore.append({
      workspace_id: run.workspace_id,
      run_id: run.id,
      kind: "run.started",
      actor: "spine",
      payload,
      idempotency_key: `${run.id}:started`,
    });
    const repeated = eventStore.append({
      workspace_id: run.workspace_id,
      run_id: run.id,
      kind: "run.started",
      actor: "spine",
      payload,
      idempotency_key: `${run.id}:started`,
    });

    expect(workspaceEvent.seq).toBe(1);
    expect(workspaceEvent.run_seq).toBeNull();
    expect(runEvent.seq).toBe(2);
    expect(runEvent.run_seq).toBe(1);
    expect(repeated.id).toBe(runEvent.id);
    expect(eventStore.listForWorkspace(run.workspace_id).map((event) => event.id)).toEqual([
      workspaceEvent.id,
      runEvent.id,
    ]);
    expect(() =>
      eventStore.append({
        workspace_id: run.workspace_id,
        run_id: run.id,
        kind: "run.completed",
        actor: "spine",
        idempotency_key: `${run.id}:started`,
      }),
    ).toThrow(EventIdempotencyConflictError);
    expect(() =>
      database.connection
        .prepare("UPDATE events SET kind = 'mutated' WHERE id = ?")
        .run(runEvent.id),
    ).toThrow();
    expect(() =>
      database.connection.prepare("DELETE FROM events WHERE id = ?").run(runEvent.id),
    ).toThrow();
  });

  it("rolls back nested event and effect writes on transaction failure", async () => {
    const run = await seedQueuedRun();
    const eventStore = new EventStore(database);
    const effectStore = new NodeEffectStore(database);
    const fixture = await loadFixture();
    const effect = NodeEffectSchema.parse(fixture.node_effect);

    expect(() =>
      database.transaction(() => {
        eventStore.append({
          workspace_id: run.workspace_id,
          run_id: run.id,
          kind: "agent.invoked",
          actor: "spine",
        });
        effectStore.record(effect);
        throw new Error("simulated crash");
      }),
    ).toThrow("simulated crash");

    expect(eventStore.listForRun(run.workspace_id, run.id)).toEqual([]);
    expect(effectStore.get(effect.id)).toBeNull();
  });

  it("enforces active run locking and approval-gated resume", async () => {
    const run = await seedQueuedRun();
    const store = new RunStore(database);
    const running = store.setStatus(run.id, "running", {
      active_node: "approval_requested",
      updated_at: "2026-05-27T15:20:03Z",
    });
    const approval = await seedPendingApproval(running);

    const suspended = store.setStatus(run.id, "suspended_approval", {
      suspended_approval_id: approval.id,
      updated_at: "2026-05-27T15:20:08Z",
    });
    const nextRun = RunSchema.parse({
      ...run,
      id: "run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });

    expect(store.activeRunId(run.workspace_id)).toBe(run.id);
    expect(suspended.suspended_approval_id).toBe(approval.id);
    expect(() => store.create(nextRun)).toThrow(ActiveRunExistsError);
    expect(() => store.setStatus(run.id, "running")).toThrow(InvalidRunTransitionError);

    resolveApproval(approval, "approved");
    const resumed = store.setStatus(run.id, "running", {
      active_node: "approval_resolved",
      updated_at: "2026-05-27T15:20:09Z",
    });
    const completed = store.setStatus(run.id, "completed", {
      active_node: "run_completed",
      updated_at: "2026-05-27T15:20:10Z",
    });

    expect(resumed.suspended_approval_id).toBeNull();
    expect(completed.status).toBe("completed");
    expect(store.activeRunId(run.workspace_id)).toBeNull();
    expect(store.create(nextRun).id).toBe(nextRun.id);
  });

  it("records node effects idempotently by run node and key", async () => {
    await seedQueuedRun();
    const fixture = await loadFixture();
    const effect = NodeEffectSchema.parse(fixture.node_effect);
    const duplicate = NodeEffectSchema.parse({
      ...effect,
      id: "effect_66666666666666666666666666666666",
      effect_ref: "artifact_changed",
    });
    const store = new NodeEffectStore(database);

    const recorded = store.record(effect);
    const repeated = store.record(effect);

    expect(recorded.id).toBe(effect.id);
    expect(repeated.id).toBe(effect.id);
    expect(repeated.effect_ref).toBe(effect.effect_ref);
    expect(() => store.record(duplicate)).toThrow("idempotency key reused");
  });
});
