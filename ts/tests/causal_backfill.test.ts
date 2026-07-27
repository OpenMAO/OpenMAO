import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type BoundedWorkEnvelope,
  BoundedWorkEnvelopeSchema,
  type Event,
  RunSchema,
  type WorkerIdentity,
  WorkerIdentitySchema,
  type WorkerOutcome,
  WorkerOutcomeSchema,
  type WorkItem,
  WorkItemSchema,
  WorkspaceSchema,
} from "../src/contracts/index.js";
import { DiagnosisService } from "../src/diagnosis/index.js";
import {
  BoundedWorkEnvelopeStore,
  Database,
  EventStore,
  RunStore,
  WorkerIdentityStore,
  WorkerOutcomeStore,
  WorkItemStore,
  WorkspaceStore,
} from "../src/persistence/index.js";
import { dumpJson } from "../src/persistence/serialization.js";
import { WorkService } from "../src/work/index.js";

const fixturePath = new URL("../../tests/fixtures/canonical_v0.json", import.meta.url);

const W1 = "work_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const W2 = "work_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const EVT_W1_CREATED = "evt_00000000000000000000000000000001";
const EVT_W2_CREATED = "evt_00000000000000000000000000000002";
const EVT_W2_ASSIGNED = "evt_00000000000000000000000000000003";
const EVT_W2_FAILED = "evt_00000000000000000000000000000004";
const EVT_ENVELOPE = "evt_00000000000000000000000000000005";
const EVT_OUTCOME = "evt_00000000000000000000000000000006";
const EVT_DEGRADED = "evt_00000000000000000000000000000007";
const EVT_UNINSTRUMENTED = "evt_00000000000000000000000000000008";
const EVT_CHAINED = "evt_00000000000000000000000000000009";
const EVT_ALREADY_INSTRUMENTED = "evt_00000000000000000000000000000010";

let tmpRoot: string;
let dbPath: string;
let database: Database;
let workspaceId: string;
let w1: WorkItem;
let worker: WorkerIdentity;
let envelope: BoundedWorkEnvelope;
let outcome: WorkerOutcome;
// payload_json captured at insert time for the rows the migration must not touch.
let untouchedBefore: Map<string, string>;

async function loadFixture(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(fixturePath, "utf8")) as Record<string, unknown>;
}

type LegacyEventInput = {
  id: string;
  seq: number;
  kind: string;
  actor: string;
  data: Record<string, unknown>;
  refs: string[];
  timestamp: string;
  run_id?: string | undefined;
  run_seq?: number | undefined;
  idempotency_key?: string;
  // Pre-M0 rows never carry these; a row that does postdates the tamper-evident
  // chain (and therefore the M0 instrumentation) and must be left alone.
  prev_hash?: string;
  hash?: string;
  // Extra payload keys for simulating a row that is already (partially) instrumented.
  causal?: Record<string, unknown>;
};

/**
 * Insert an event row exactly as the pre-M0 EventStore serialized it: the full
 * event JSON with only `data` and `refs` inside the payload — no causal keys, no
 * hash keys. INSERTs are permitted by the append-only triggers, so this is also
 * how a real pre-M0 database file looks to the migration.
 */
function insertLegacyEvent(input: LegacyEventInput): string {
  const event: Record<string, unknown> = {
    id: input.id,
    workspace_id: workspaceId,
    run_id: input.run_id ?? null,
    seq: input.seq,
    run_seq: input.run_seq ?? null,
    kind: input.kind,
    actor: input.actor,
    payload: { data: input.data, refs: input.refs, ...(input.causal ?? {}) },
    timestamp: input.timestamp,
    idempotency_key: input.idempotency_key ?? null,
  };
  if (input.prev_hash !== undefined) {
    event.prev_hash = input.prev_hash;
  }
  if (input.hash !== undefined) {
    event.hash = input.hash;
  }
  const payloadJson = dumpJson(event);
  database.connection
    .prepare(
      `INSERT INTO events (
        id, workspace_id, run_id, seq, run_seq, kind, actor, payload_json,
        timestamp, idempotency_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      workspaceId,
      input.run_id ?? null,
      input.seq,
      input.run_seq ?? null,
      input.kind,
      input.actor,
      payloadJson,
      input.timestamp,
      input.idempotency_key ?? null,
    );
  return payloadJson;
}

/**
 * Build a pre-M0 database file: real workspace/work/worker/envelope/outcome rows
 * plus work-lifecycle events whose payloads carry the causal fields at their
 * schema defaults — exactly what the pre-instrumentation emitters wrote.
 */
async function seedPreM0Fixture(): Promise<void> {
  const fixture = await loadFixture();
  const workspace = WorkspaceSchema.parse(fixture.workspace);
  new WorkspaceStore(database).save(workspace);
  workspaceId = workspace.id;

  const workItems = new WorkItemStore(database);

  // W1: still queued; its creation is the canonical enriched-replay case.
  w1 = WorkItemSchema.parse({
    id: W1,
    workspace_id: workspaceId,
    title: "Ship the thing",
    objective: "Do the thing well",
    owner: "agent_worker",
  });
  workItems.save(w1);

  // W2: a full legacy lifecycle that ended failed.
  const w2Created = WorkItemSchema.parse({
    id: W2,
    workspace_id: workspaceId,
    title: "Research the topic",
    objective: "Produce a defensible answer",
    owner: "agent_worker",
  });
  workItems.save(w2Created);
  workItems.update(WorkItemSchema.parse({ ...w2Created, status: "in_progress" }));
  workItems.setStatus(W2, "failed");

  // The fixture envelope/outcome pair (and the run + work item they reference).
  const fixtureRun = RunSchema.parse(fixture.run);
  new RunStore(database).create(
    RunSchema.parse({
      ...fixtureRun,
      status: "queued",
      active_node: null,
      suspended_approval_id: null,
      updated_at: fixtureRun.created_at,
    }),
  );
  workItems.save(WorkItemSchema.parse(fixture.work_item));
  worker = new WorkerIdentityStore(database).save(
    WorkerIdentitySchema.parse(fixture.worker_identity),
  );
  envelope = new BoundedWorkEnvelopeStore(database).save(
    BoundedWorkEnvelopeSchema.parse(fixture.bounded_work_envelope),
  );
  outcome = new WorkerOutcomeStore(database).record(
    WorkerOutcomeSchema.parse(fixture.worker_outcome),
  );

  untouchedBefore = new Map();

  insertLegacyEvent({
    id: EVT_W1_CREATED,
    seq: 1,
    kind: "work.created",
    actor: "agent_planner",
    data: { work_item: w1 },
    refs: [W1],
    timestamp: "2026-05-27T15:20:01Z",
    idempotency_key: `work:${W1}:created`,
  });
  insertLegacyEvent({
    id: EVT_W2_CREATED,
    seq: 2,
    kind: "work.created",
    actor: "agent_planner",
    data: { work_item: w2Created },
    refs: [W2],
    timestamp: "2026-05-27T15:20:02Z",
    idempotency_key: `work:${W2}:created`,
  });
  insertLegacyEvent({
    id: EVT_W2_ASSIGNED,
    seq: 3,
    kind: "work.assigned",
    actor: "agent_planner",
    data: { work_item_id: W2, owner: "agent_worker", reviewer: null, status: "in_progress" },
    refs: [W2],
    timestamp: "2026-05-27T15:20:03Z",
    idempotency_key: `work:${W2}:assigned:agent_worker`,
  });
  insertLegacyEvent({
    id: EVT_W2_FAILED,
    seq: 4,
    kind: "work.failed",
    actor: "agent_worker",
    data: { work_item_id: W2, status: "failed", reason: "the worker could not complete it" },
    refs: [W2],
    timestamp: "2026-05-27T15:20:04Z",
    idempotency_key: `work:${W2}:status:failed`,
  });
  insertLegacyEvent({
    id: EVT_ENVELOPE,
    seq: 5,
    run_id: envelope.run_id ?? undefined,
    run_seq: 1,
    kind: "work.envelope.created",
    actor: `${envelope.issued_by.actor_type}:${envelope.issued_by.actor_id}`,
    data: {
      envelope_id: envelope.id,
      work_item_id: envelope.work_item_id,
      worker_id: envelope.worker_id,
      allowed_capabilities: envelope.allowed_capabilities,
    },
    refs: [envelope.id, envelope.work_item_id, envelope.worker_id],
    timestamp: "2026-05-27T15:20:05Z",
    idempotency_key: `work:${envelope.work_item_id}:envelope:${envelope.id}`,
  });
  insertLegacyEvent({
    id: EVT_OUTCOME,
    seq: 6,
    run_id: envelope.run_id ?? undefined,
    run_seq: 2,
    kind: "work.outcome_submitted",
    actor: `worker:${outcome.worker_id}`,
    data: { worker_outcome: outcome, work_item_status: "review" },
    refs: [outcome.id, outcome.work_item_id, outcome.envelope_id, outcome.worker_id],
    timestamp: "2026-05-27T15:20:06Z",
    idempotency_key: `${outcome.id}:event`,
  });
  // Pre-M0 but NOT emitter-shaped (the raw-append shape wedge_diagnosis uses):
  // work.created without a work_item object. Reconstruction must refuse and mark.
  insertLegacyEvent({
    id: EVT_DEGRADED,
    seq: 7,
    kind: "work.created",
    actor: "agent_planner",
    data: { work_item_id: "work_44444444444444444444444444444444" },
    refs: ["work_44444444444444444444444444444444"],
    timestamp: "2026-05-27T15:20:07Z",
    idempotency_key: "legacy:create:degraded",
  });
  // An uninstrumented kind: the live emitter leaves its causal fields at the
  // defaults today, so the defaults are already exactly right — no rewrite.
  untouchedBefore.set(
    EVT_UNINSTRUMENTED,
    insertLegacyEvent({
      id: EVT_UNINSTRUMENTED,
      seq: 8,
      kind: "worker.registered",
      actor: "operator:local",
      data: { worker_identity: worker },
      refs: [worker.id],
      timestamp: "2026-05-27T15:20:08Z",
      idempotency_key: `worker:${worker.id}:registered`,
    }),
  );
  // A hash-chained row with default causal fields: it postdates the chain (and
  // therefore M0), so it is not legacy and rewriting it would read as tampering.
  untouchedBefore.set(
    EVT_CHAINED,
    insertLegacyEvent({
      id: EVT_CHAINED,
      seq: 9,
      kind: "work.failed",
      actor: "agent_worker",
      data: { work_item_id: W2, status: "failed", reason: null },
      refs: [W2],
      timestamp: "2026-05-27T15:20:09Z",
      prev_hash: "ab".repeat(32),
      hash: "cd".repeat(32),
    }),
  );
  // A row whose causal fields are already (partially) populated is not at the
  // schema defaults and therefore not legacy.
  untouchedBefore.set(
    EVT_ALREADY_INSTRUMENTED,
    insertLegacyEvent({
      id: EVT_ALREADY_INSTRUMENTED,
      seq: 10,
      kind: "work.assigned",
      actor: "agent_planner",
      data: { work_item_id: W2, owner: "agent_worker", reviewer: null, status: "in_progress" },
      refs: [W2],
      timestamp: "2026-05-27T15:20:10Z",
      causal: {
        actor_ref: { actor_type: "agent", actor_id: "agent_planner", display_name: null },
      },
    }),
  );
}

/**
 * Re-stamp the file as schema v6. v7 changed no table shapes (it is a data-only
 * backfill); the worker_credentials table (#102) is added by idempotent DDL that
 * runs on every open without bumping the version, so it is present on both sides
 * of the migration and irrelevant to the backfill. A freshly initialized file
 * with the v6 stamp is therefore byte-equivalent to a real pre-M0 database for
 * the migration's purposes.
 */
function stampAsV6(): void {
  database.connection.prepare("DELETE FROM schema_version WHERE version = 7").run();
  database.connection
    .prepare(
      `INSERT OR IGNORE INTO schema_version (version, applied_at)
       VALUES (6, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    )
    .run();
  database.connection.pragma("user_version = 6");
}

function reopenDatabase(): void {
  database.close();
  database = new Database(dbPath);
  database.initialize();
}

function allPayloadJson(): Map<string, string> {
  const rows = database.connection
    .prepare("SELECT id, payload_json FROM events ORDER BY seq")
    .all() as Array<{ id: string; payload_json: string }>;
  return new Map(rows.map((row) => [row.id, row.payload_json]));
}

function eventById(id: string): Event {
  const event = new EventStore(database)
    .listForWorkspace(workspaceId)
    .find((candidate) => candidate.id === id);
  if (!event) {
    throw new Error(`expected event to exist: ${id}`);
  }
  return event;
}

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "openmao-ts-backfill-"));
  dbPath = join(tmpRoot, "openmao.sqlite3");
  database = new Database(dbPath);
  database.initialize();
  await seedPreM0Fixture();
  stampAsV6();
  // Reopen: initialize() must run the one-time v7 backfill on open, exactly as it
  // would for a real pre-M0 database file.
  reopenDatabase();
});

afterEach(() => {
  database.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("v7 one-time causal backfill for pre-M0 events (#109)", () => {
  it("reconstructs the causal envelope on emitter-shaped legacy work-lifecycle events", () => {
    const created = eventById(EVT_W1_CREATED);
    expect(created.payload.actor_ref).toEqual({
      actor_type: "agent",
      actor_id: "agent_planner",
      display_name: null,
    });
    expect(created.payload.produced_refs).toEqual([W1]);
    expect(created.payload.consumed_refs).toEqual([]);
    expect(created.payload.causal_parent_id).toBeNull();
    // The data the original emitter wrote is preserved verbatim.
    expect(created.payload.data.work_item).toEqual(w1);

    const assigned = eventById(EVT_W2_ASSIGNED);
    expect(assigned.payload.actor_ref?.actor_id).toBe("agent_planner");
    expect(assigned.payload.produced_refs).toEqual([]);
    expect(assigned.payload.consumed_refs).toEqual([W2]);

    const failed = eventById(EVT_W2_FAILED);
    expect(failed.payload.actor_ref).toEqual({
      actor_type: "agent",
      actor_id: "agent_worker",
      display_name: null,
    });
    expect(failed.payload.consumed_refs).toEqual([W2]);

    const submitted = eventById(EVT_OUTCOME);
    expect(submitted.payload.actor_ref).toEqual({
      actor_type: "worker",
      actor_id: `worker:${outcome.worker_id}`,
      display_name: null,
    });
    expect(submitted.payload.consumed_refs).toEqual([outcome.work_item_id, outcome.envelope_id]);
    expect(submitted.payload.produced_refs).toEqual([]);

    // The backfill never fabricates tamper-evidence: legacy rows stay unchained.
    for (const id of [EVT_W1_CREATED, EVT_W2_ASSIGNED, EVT_W2_FAILED, EVT_OUTCOME]) {
      const event = eventById(id);
      expect(event.hash).toBeNull();
      expect(event.prev_hash).toBeNull();
    }
  });

  it("recovers the typed issued_by for envelope events from the write-once envelope row", () => {
    const event = eventById(EVT_ENVELOPE);
    // display_name is NOT derivable from the bare actor string — only the stored
    // envelope row carries it. Recovering it proves the join, not inference.
    expect(envelope.issued_by.display_name).not.toBeNull();
    expect(event.payload.actor_ref).toEqual(envelope.issued_by);
    expect(event.payload.consumed_refs).toEqual([envelope.work_item_id]);
    expect(event.payload.produced_refs).toEqual([envelope.id]);
  });

  it("marks non-reconstructable legacy rows pre_m0_legacy and never guesses", () => {
    const event = eventById(EVT_DEGRADED);
    expect(event.payload.data.pre_m0_legacy).toBe(true);
    // The original data is preserved; the causal fields stay at the defaults —
    // an unprovable causal envelope is never invented.
    expect(event.payload.data.work_item_id).toBe("work_44444444444444444444444444444444");
    expect(event.payload.actor_ref).toBeNull();
    expect(event.payload.produced_refs).toEqual([]);
    expect(event.payload.consumed_refs).toEqual([]);
    expect(event.payload.causal_parent_id).toBeNull();
  });

  it("leaves uninstrumented kinds, chained rows, and already-instrumented rows untouched", () => {
    const after = allPayloadJson();
    for (const [id, before] of untouchedBefore) {
      expect(after.get(id)).toBe(before);
    }
  });

  it("stamps the current schema version and re-running the migration changes nothing", () => {
    // The v6 fixture migrates straight to the CURRENT version (v8 as of the
    // truth-in-status relabel, #105); only the current version is stamped on top
    // of the fixture's own.
    expect(database.connection.pragma("user_version", { simple: true })).toBe(8);
    const versions = database.connection
      .prepare("SELECT version FROM schema_version ORDER BY version")
      .all() as Array<{ version: number }>;
    expect(versions.map((row) => row.version)).toEqual([6, 8]);

    const afterFirstRun = allPayloadJson();
    // Force a second pass (e.g. a restored backup re-running the migration):
    // every row must come out byte-identical.
    database.connection.pragma("user_version = 6");
    reopenDatabase();
    expect(allPayloadJson()).toEqual(afterFirstRun);
    expect(database.connection.pragma("user_version", { simple: true })).toBe(8);
  });

  it("lets the enriched emitter replay legacy events idempotently after the backfill", () => {
    const work = new WorkService(database);

    // Pre-backfill this replay raised EventIdempotencyConflictError (the boundary
    // wedge_diagnosis.test.ts locks loud-safe). After the backfill it is a clean
    // idempotent hit: same event, no duplicate, no conflict.
    const replayedCreate = work.createWork({
      id: W1,
      workspace_id: workspaceId,
      title: "Ship the thing",
      objective: "Do the thing well",
      owner: "agent_worker",
      actor: "agent_planner",
    });
    expect(replayedCreate.id).toBe(W1);

    const replayedStatus = work.setStatus({
      workspace_id: workspaceId,
      work_item_id: W2,
      status: "failed",
      reason: "the worker could not complete it",
      actor: "agent_worker",
    });
    expect(replayedStatus.status).toBe("failed");

    const events = new EventStore(database).listForWorkspace(workspaceId);
    expect(events.filter((event) => event.kind === "work.created")).toHaveLength(3);
    expect(events.filter((event) => event.id === EVT_W1_CREATED)).toHaveLength(1);
    // Two work.failed rows existed before the replay (the legacy one and the
    // chained one); the replay must not have added a third.
    expect(events.filter((event) => event.kind === "work.failed")).toHaveLength(2);
  });

  it("feeds M3 diagnosis on backfilled legacy history", () => {
    const diagnosis = new DiagnosisService(database).diagnose({
      workspace_id: workspaceId,
      failure_event_id: EVT_W2_FAILED,
    });
    const candidateIds = diagnosis.candidates.map((candidate) => candidate.event_id);
    // The legacy failure now traces back to the legacy creation of its work item.
    expect(candidateIds).toContain(EVT_W2_CREATED);
  });

  it("keeps the migration's frozen actor-ref derivation byte-equal to the live emitter's", () => {
    // `inferredActorRef` (ts/src/persistence/schema.ts) is a deliberately frozen,
    // module-private copy of the live emitter's `asActorRef` (ts/src/work/service.ts).
    // Both are private on purpose, so this guard compares them through their real
    // call sites — the only places their outputs are observable: the live emitter
    // stamps `actor_ref: asActorRef(actor)` on work.created, and the backfill
    // stamps `actor_ref: inferredActorRef(actor)` on a legacy work.created row.
    // That is strictly stronger than importing the two functions: it also fails if
    // the emitter ever stops routing through `asActorRef`. If the live shape
    // drifts from the frozen copy, this fails loudly NOW instead of surfacing
    // later as a silent EventIdempotencyConflictError on an enriched replay of a
    // backfilled event.
    const table: Array<{
      actor: string;
      expected_type: "agent" | "worker" | "operator" | "system";
    }> = [
      { actor: "agent_planner", expected_type: "agent" }, // plain agent id (underscore form)
      { actor: "agent:planner", expected_type: "agent" },
      { actor: `worker:${worker.id}`, expected_type: "worker" }, // the outcome emitter's default
      { actor: "worker_standalone", expected_type: "worker" },
      { actor: "operator:local", expected_type: "operator" },
      { actor: "operator_admin", expected_type: "operator" },
      // Prefix (not substring) inference: the embedded "agent" must not win.
      { actor: "operator:agent-admin", expected_type: "operator" },
      { actor: "system:scheduler", expected_type: "system" },
      { actor: "cron", expected_type: "system" }, // bare string with no known prefix
      { actor: "workerbee", expected_type: "system" }, // "worker" letters without the :/_ separator
    ];
    const pad = (fill: string, index: number): string =>
      `${fill.repeat(28)}${index.toString(16).padStart(4, "0")}`;

    // Live side: one work.created per actor shape, written by today's emitter.
    const work = new WorkService(database);
    for (const [index, row] of table.entries()) {
      work.createWork({
        id: `work_${pad("e", index)}`,
        workspace_id: workspaceId,
        title: `drift probe ${index}`,
        objective: "compare the live and frozen actor-ref derivations",
        owner: "agent_worker",
        actor: row.actor,
      });
    }
    // Migration side: a legacy work.created per actor shape, then the backfill.
    for (const [index, row] of table.entries()) {
      const workItemId = `work_${pad("d", index)}`;
      insertLegacyEvent({
        id: `evt_${pad("f", index)}`,
        seq: 200 + index,
        kind: "work.created",
        actor: row.actor,
        data: { work_item: { id: workItemId } },
        refs: [workItemId],
        timestamp: "2026-05-27T15:21:00Z",
        idempotency_key: `work:${workItemId}:created`,
      });
    }
    stampAsV6();
    reopenDatabase();

    const events = new EventStore(database);
    for (const [index, row] of table.entries()) {
      const live = events.getByIdempotencyKey(workspaceId, `work:work_${pad("e", index)}:created`);
      if (!live) {
        throw new Error(`expected a live work.created event for actor: ${row.actor}`);
      }
      const backfilled = eventById(`evt_${pad("f", index)}`);
      // Pin the live shape first so the byte-equality below can never pass
      // vacuously (null === null) if the emitter stopped stamping actor_ref.
      expect(live.payload.actor_ref?.actor_type).toBe(row.expected_type);
      expect(live.payload.actor_ref?.actor_id).toBe(row.actor);
      // dumpJson is the canonical (sorted-key) serialization both writers use for
      // payload_json, so this is byte-equality of the two derivations.
      expect(dumpJson(backfilled.payload.actor_ref)).toBe(dumpJson(live.payload.actor_ref));
    }
  });

  it("keeps both append-only triggers armed after the migration's drop-and-recreate", () => {
    // Premise check: this fixture actually took the rewrite path — the migration
    // only drops and recreates events_no_update when it has rows to rewrite.
    expect(eventById(EVT_W1_CREATED).payload.actor_ref).not.toBeNull();

    // events_no_update was dropped and recreated inside the migration's
    // transaction; events_no_delete was never dropped. Prove both are active on
    // the reopened database, not just declared.
    expect(() =>
      database.connection
        .prepare("UPDATE events SET actor = 'tamper' WHERE id = ?")
        .run(EVT_W1_CREATED),
    ).toThrow(/append-only/);
    expect(() =>
      database.connection.prepare("DELETE FROM events WHERE id = ?").run(EVT_W1_CREATED),
    ).toThrow(/append-only/);

    const triggers = database.connection
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
      .all() as Array<{ name: string }>;
    // The M6 chain_head_attestations triggers are append-only guards on the new
    // attestation table; the migration only ever touches the events triggers.
    expect(triggers.map((row) => row.name)).toEqual([
      "chain_head_attestations_no_delete",
      "chain_head_attestations_no_update",
      "events_no_delete",
      "events_no_update",
    ]);
  });

  it("changes no structural DDL, which is what makes the synthesized v6 fixture schema-accurate", () => {
    // The fixture is built by initializing the CURRENT schema and re-stamping
    // user_version=6 (stampAsV6), not by replaying a checked-in v6 DDL dump. That
    // synthesis is faithful only if the structure the backfill reads is identical
    // across versions — which is the migration's design: v7 is data-only (causal
    // backfill + drop/recreate of the byte-identical events_no_update trigger +
    // version bump), adding no table, column, index, or trigger DDL. The
    // worker_credentials table (#102) is created by idempotent DDL on every open
    // without a version bump, so it is present on BOTH sides of the comparison and
    // does not affect this check. Prove it: a freshly initialized database and
    // the fixture database that ran the full stamp-v6 → reopen → migrate cycle
    // (with real rewrites, so the trigger drop/recreate path executed) must agree
    // on every sqlite_master entry; only data and user_version may differ. If
    // this ever fails, the migration changed structure — a violation of the
    // data-only contract that also invalidates the v6 fixture synthesis — and the
    // migration, not this test, is wrong.
    const structuralDdl = (db: Database): Array<Record<string, unknown>> =>
      db.connection
        .prepare(
          `SELECT type, name, tbl_name, sql FROM sqlite_master
           WHERE type IN ('table', 'index', 'trigger')
           ORDER BY type, name`,
        )
        .all() as Array<Record<string, unknown>>;

    const fresh = new Database(join(tmpRoot, "fresh-current.sqlite3"));
    fresh.initialize();
    const freshDdl = structuralDdl(fresh);
    fresh.close();

    expect(freshDdl.length).toBeGreaterThan(0);
    expect(structuralDdl(database)).toEqual(freshDdl);
    // v8 (the truth-in-status relabel, #105) is data-only too, so the same
    // structural-identity contract carries through to the current version.
    expect(database.connection.pragma("user_version", { simple: true })).toBe(8);
  });
});
