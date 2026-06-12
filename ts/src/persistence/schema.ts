import type { Database as SqliteDatabase } from "better-sqlite3";

import { dumpJson } from "./serialization.js";

/**
 * Current schema version. v7 is data-only: a one-time backfill of the M0 causal
 * envelope onto legacy (pre-instrumentation) work-lifecycle events (#109). The
 * table shapes are identical to v6.
 *
 * The version bumps ONLY for a gated, one-time data migration. The
 * `worker_credentials` table (#102) is created by idempotent `CREATE TABLE IF
 * NOT EXISTS` DDL in the unconditional schema-creation path, so it carries no
 * data migration and does not bump the version — adding a fresh table to the
 * DDL is safe on every open regardless of the recorded version.
 */
const SCHEMA_VERSION = 7;

// Defined once so the v7 migration (which must temporarily lift the update
// guard) recreates exactly the trigger the schema declares.
const EVENTS_NO_UPDATE_TRIGGER = `
CREATE TRIGGER IF NOT EXISTS events_no_update
BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;`;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
);

CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
);

CREATE TABLE IF NOT EXISTS tools (
  name TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (workspace_id, name),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
);

CREATE TABLE IF NOT EXISTS worker_identities (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_worker_identities_workspace_id
ON worker_identities(workspace_id, id);

CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
);

CREATE TABLE IF NOT EXISTS work_items (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_work_items_workspace_id
ON work_items(workspace_id, id);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  status TEXT NOT NULL,
  active_node TEXT,
  suspended_approval_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_workspace_id
ON runs(workspace_id, id);

CREATE TABLE IF NOT EXISTS task_envelopes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
  FOREIGN KEY (workspace_id, run_id) REFERENCES runs(workspace_id, id),
  FOREIGN KEY (workspace_id, work_item_id) REFERENCES work_items(workspace_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_task_envelopes_workspace_id
ON task_envelopes(workspace_id, id);

CREATE TABLE IF NOT EXISTS bounded_work_envelopes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  run_id TEXT,
  worker_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
  FOREIGN KEY (workspace_id, work_item_id) REFERENCES work_items(workspace_id, id),
  FOREIGN KEY (workspace_id, run_id) REFERENCES runs(workspace_id, id),
  FOREIGN KEY (workspace_id, worker_id) REFERENCES worker_identities(workspace_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bounded_work_envelopes_workspace_id
ON bounded_work_envelopes(workspace_id, id);

CREATE INDEX IF NOT EXISTS idx_bounded_work_envelopes_work_item
ON bounded_work_envelopes(workspace_id, work_item_id);

CREATE TABLE IF NOT EXISTS worker_outcomes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  envelope_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
  FOREIGN KEY (workspace_id, work_item_id) REFERENCES work_items(workspace_id, id),
  FOREIGN KEY (workspace_id, envelope_id) REFERENCES bounded_work_envelopes(workspace_id, id),
  FOREIGN KEY (workspace_id, worker_id) REFERENCES worker_identities(workspace_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_worker_outcomes_workspace_idempotency
ON worker_outcomes(workspace_id, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_worker_outcomes_work_item
ON worker_outcomes(workspace_id, work_item_id);

CREATE TABLE IF NOT EXISTS checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  node TEXT NOT NULL,
  run_status TEXT NOT NULL,
  state_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
  FOREIGN KEY (workspace_id, run_id) REFERENCES runs(workspace_id, id)
);

CREATE INDEX IF NOT EXISTS idx_checkpoints_run_latest
ON checkpoints(run_id, id DESC);

CREATE TABLE IF NOT EXISTS approval_requests (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  run_id TEXT,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
  FOREIGN KEY (workspace_id, run_id) REFERENCES runs(workspace_id, id)
);

CREATE TABLE IF NOT EXISTS policies (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
);

CREATE TABLE IF NOT EXISTS capabilities (
  name TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (workspace_id, name),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
);

CREATE TABLE IF NOT EXISTS capability_calls (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  capability_name TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
  FOREIGN KEY (workspace_id, run_id) REFERENCES runs(workspace_id, id),
  FOREIGN KEY (workspace_id, capability_name) REFERENCES capabilities(workspace_id, name)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_capability_calls_workspace_idempotency
ON capability_calls(workspace_id, idempotency_key);

CREATE UNIQUE INDEX IF NOT EXISTS idx_capability_calls_workspace_id
ON capability_calls(workspace_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_capability_calls_workspace_run_id
ON capability_calls(workspace_id, run_id, id);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  run_id TEXT,
  seq INTEGER NOT NULL,
  run_seq INTEGER,
  kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  idempotency_key TEXT,
  UNIQUE (workspace_id, seq),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
  FOREIGN KEY (workspace_id, run_id) REFERENCES runs(workspace_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_events_workspace_idempotency
ON events(workspace_id, idempotency_key)
WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_events_run_seq
ON events(run_id, run_seq)
WHERE run_id IS NOT NULL AND run_seq IS NOT NULL;

CREATE TABLE IF NOT EXISTS ingestion_records (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  target_run_id TEXT,
  target_work_item_id TEXT,
  payload_json TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
  FOREIGN KEY (workspace_id, target_run_id) REFERENCES runs(workspace_id, id),
  FOREIGN KEY (workspace_id, target_work_item_id) REFERENCES work_items(workspace_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ingestion_records_workspace_idempotency
ON ingestion_records(workspace_id, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_ingestion_records_target_work
ON ingestion_records(workspace_id, target_work_item_id);

CREATE TABLE IF NOT EXISTS traces (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  node TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
  FOREIGN KEY (workspace_id, run_id) REFERENCES runs(workspace_id, id)
);

CREATE INDEX IF NOT EXISTS idx_traces_run_timestamp
ON traces(run_id, timestamp, id);

${EVENTS_NO_UPDATE_TRIGGER}

CREATE TRIGGER IF NOT EXISTS events_no_delete
BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TABLE IF NOT EXISTS node_effects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  node TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  effect_type TEXT NOT NULL,
  effect_ref TEXT NOT NULL,
  content_hash TEXT,
  created_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  UNIQUE (run_id, node, idempotency_key),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
  FOREIGN KEY (workspace_id, run_id) REFERENCES runs(workspace_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_node_effects_workspace_id
ON node_effects(workspace_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_node_effects_workspace_run_id
ON node_effects(workspace_id, run_id, id);

CREATE TABLE IF NOT EXISTS capability_results (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  node_effect_id TEXT,
  payload_json TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
  FOREIGN KEY (workspace_id, run_id) REFERENCES runs(workspace_id, id),
  FOREIGN KEY (workspace_id, run_id, call_id)
    REFERENCES capability_calls(workspace_id, run_id, id),
  FOREIGN KEY (workspace_id, run_id, node_effect_id)
    REFERENCES node_effects(workspace_id, run_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_capability_results_workspace_call
ON capability_results(workspace_id, call_id);

CREATE TABLE IF NOT EXISTS model_requests (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  run_id TEXT,
  idempotency_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
  FOREIGN KEY (workspace_id, run_id) REFERENCES runs(workspace_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_model_requests_workspace_id
ON model_requests(workspace_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_model_requests_workspace_idempotency
ON model_requests(workspace_id, idempotency_key);

CREATE TABLE IF NOT EXISTS model_responses (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
  FOREIGN KEY (workspace_id, request_id) REFERENCES model_requests(workspace_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_model_responses_workspace_request
ON model_responses(workspace_id, request_id);

CREATE TABLE IF NOT EXISTS individual_memory (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  owner_id TEXT,
  payload_json TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
);

CREATE TABLE IF NOT EXISTS promotion_candidates (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
);

CREATE TABLE IF NOT EXISTS promotion_corroborations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  source_memory_entry TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
  FOREIGN KEY (candidate_id) REFERENCES promotion_candidates(id)
);

CREATE INDEX IF NOT EXISTS idx_promotion_corroborations_candidate
ON promotion_corroborations(candidate_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_promotion_corroborations_unique
ON promotion_corroborations(candidate_id, source_memory_entry);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  content_ref TEXT NOT NULL,
  content_hash TEXT,
  payload_json TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
  FOREIGN KEY (workspace_id, task_id) REFERENCES task_envelopes(workspace_id, id)
);

CREATE TABLE IF NOT EXISTS world_model_snapshots (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  run_id TEXT,
  source_workspace_seq INTEGER NOT NULL,
  source_run_seq INTEGER,
  payload_json TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
  FOREIGN KEY (workspace_id, run_id) REFERENCES runs(workspace_id, id)
);

CREATE TABLE IF NOT EXISTS org_change_proposals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
);

CREATE TABLE IF NOT EXISTS org_change_applications (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
  FOREIGN KEY (proposal_id) REFERENCES org_change_proposals(id)
);

-- One application per proposal, enforced at the DB level (not just by the derived id).
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_change_applications_proposal
  ON org_change_applications (workspace_id, proposal_id);

CREATE TABLE IF NOT EXISTS org_control (
  workspace_id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
);

CREATE TABLE IF NOT EXISTS autonomy_cases (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
  FOREIGN KEY (org_id) REFERENCES organizations(id)
);

CREATE INDEX IF NOT EXISTS idx_autonomy_cases_org
  ON autonomy_cases (workspace_id, org_id);

CREATE TABLE IF NOT EXISTS active_run_locks (
  workspace_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
  FOREIGN KEY (workspace_id, run_id) REFERENCES runs(workspace_id, id)
);

CREATE TABLE IF NOT EXISTS cadences (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  next_due_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
);

CREATE INDEX IF NOT EXISTS idx_cadences_due
ON cadences(workspace_id, enabled, next_due_at);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
);

CREATE INDEX IF NOT EXISTS idx_notifications_workspace
ON notifications(workspace_id, created_at, id);

-- Per-worker authentication tokens (#102). Only the SHA-256 of the token is stored; the
-- plaintext is shown once at mint time. A worker token authenticates a worker principal
-- (worker_id + workspace) to the loopback API with strictly fewer rights than the operator token.
CREATE TABLE IF NOT EXISTS worker_credentials (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_worker_credentials_token_hash
ON worker_credentials(token_hash);

CREATE INDEX IF NOT EXISTS idx_worker_credentials_worker
ON worker_credentials(workspace_id, worker_id);

INSERT OR IGNORE INTO schema_version (version, applied_at)
VALUES (${SCHEMA_VERSION}, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

PRAGMA user_version = ${SCHEMA_VERSION};
`;

export function initializeSchema(connection: SqliteDatabase): void {
  // Capture the version BEFORE the idempotent DDL stamps the current one, then run
  // the DDL and any one-time data migration atomically: a failed migration rolls
  // the version stamp back too, so it is retried on the next open instead of being
  // silently recorded as done.
  const previousVersion = Number(connection.pragma("user_version", { simple: true }));
  connection.transaction(() => {
    connection.exec(SCHEMA_SQL);
    if (previousVersion < 7) {
      backfillPreM0CausalEnvelope(connection);
    }
  })();
}

// ---------------------------------------------------------------------------
// v7 one-time backfill: M0 causal envelope for legacy (pre-instrumentation)
// work-lifecycle events (#109).
// ---------------------------------------------------------------------------
//
// Events appended before the M0 wedge carry the causal fields at their schema
// defaults (actor_ref null, produced_refs/consumed_refs [], causal_parent_id
// null). The enriched emitters now populate them, so an idempotent replay of a
// legacy event is a genuine payload difference and fails loud-safe with
// EventIdempotencyConflictError (ts/tests/wedge_diagnosis.test.ts documents the
// boundary). The sanctioned remedy is this audited, one-time backfill — NOT a
// relaxation of EventStore's security-relevant idempotency comparison, which
// stays untouched.
//
// Soundness rules:
//   - Only the work-lifecycle kinds the live emitter instruments are touched;
//     every other kind legitimately carries the defaults today.
//   - Only rows WITHOUT a hash chain are touched. The tamper-evident chain
//     landed after the M0 instrumentation, so every genuine pre-M0 row is
//     unchained; a chained row with default causal fields is a post-M0 append
//     that bypassed the emitter, not a legacy row. Rewriting a chained row
//     would (correctly) read as tampering, and fabricating hashes for legacy
//     rows would forge tamper-evidence — both are forbidden, so backfilled
//     rows keep hash/prev_hash null and verifyChain semantics are unchanged.
//   - A causal field is reconstructed only when it is deterministically
//     derivable from stored data exactly as the live emitter computed it: the
//     event's own actor column and data/refs, plus the write-once
//     bounded_work_envelopes row for `work.envelope.created`'s typed issued_by.
//     Reconstructed rows carry no marker — their payload becomes exactly what
//     the enriched emitter produces, so an idempotent replay returns the stored
//     event; any extra key would itself re-create the mismatch.
//   - Anything else gets `data.pre_m0_legacy = true` and NOTHING else: causal
//     parents are never guessed. Diagnosis can recognize such rows as
//     pre-instrumentation; replays of them keep failing loud-safe as before.
//
// The helpers below are deliberately frozen copies of the emitter logic in
// ts/src/work/service.ts as of this migration. If the live emitter evolves, a
// later migration owns that delta — v7 must keep producing v7-era values.

const PRE_M0_MARKER_KEY = "pre_m0_legacy";

// The exact kinds ts/src/work/service.ts instruments with causal fields.
const BACKFILL_WORK_KINDS = [
  "work.created",
  "work.assigned",
  "work.in_progress",
  "work.blocked",
  "work.review",
  "work.done",
  "work.failed",
  "work.reviewed",
  "work.outcome_submitted",
  "work.envelope.created",
];

type JsonRecord = Record<string, unknown>;

type BackfillActorRef = {
  actor_type: "agent" | "worker" | "operator" | "system" | "provider";
  actor_id: string;
  display_name: string | null;
};

type CausalEnvelope = {
  actor_ref: BackfillActorRef;
  produced_refs: string[];
  consumed_refs: string[];
};

type EventRow = { id: string; kind: string; actor: string; payload_json: string };

function asJsonRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function isDefaultRefList(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.length === 0);
}

// Frozen copy of `asActorRef` in ts/src/work/service.ts (prefix inference).
function inferredActorRef(actor: string): BackfillActorRef {
  const hasPrefix = (kind: string): boolean =>
    actor.startsWith(`${kind}:`) || actor.startsWith(`${kind}_`);
  const actorType = hasPrefix("worker")
    ? "worker"
    : hasPrefix("agent")
      ? "agent"
      : hasPrefix("operator")
        ? "operator"
        : "system";
  return { actor_type: actorType, actor_id: actor, display_name: null };
}

// The emitter always recorded the ids it instrumented in the event's own refs; a
// row that disagrees was not emitter-written, so we refuse to reconstruct from it.
function emitterRecordedRef(value: unknown, refs: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  return Array.isArray(refs) && refs.includes(value) ? value : null;
}

// The live emitter stamped `actor_ref: saved.issued_by` — the typed ref on the
// bounded envelope, including a display_name the bare actor string cannot carry.
// Envelope rows are write-once (BoundedWorkEnvelopeStore.save conflicts on any
// change), so the stored row IS the object the emitter used. The row must also
// agree with the event (work item id and the frozen `actorString` rendering of
// issued_by) before it is trusted; any disagreement means the event was not
// emitter-written.
function storedIssuedBy(
  connection: SqliteDatabase,
  envelopeId: string,
  workItemId: string,
  eventActor: string,
): BackfillActorRef | null {
  const row = connection
    .prepare("SELECT payload_json FROM bounded_work_envelopes WHERE id = ?")
    .get(envelopeId) as { payload_json: string } | undefined;
  if (!row) {
    return null;
  }
  let envelope: JsonRecord | null = null;
  try {
    envelope = asJsonRecord(JSON.parse(row.payload_json));
  } catch {
    return null;
  }
  if (!envelope || envelope.work_item_id !== workItemId) {
    return null;
  }
  const issuedBy = asJsonRecord(envelope.issued_by);
  const actorType = issuedBy?.actor_type;
  const actorId = issuedBy?.actor_id;
  if (
    typeof actorId !== "string" ||
    (actorType !== "agent" &&
      actorType !== "worker" &&
      actorType !== "operator" &&
      actorType !== "system" &&
      actorType !== "provider")
  ) {
    return null;
  }
  if (`${actorType}:${actorId}` !== eventActor) {
    return null;
  }
  const displayName = issuedBy?.display_name;
  return {
    actor_type: actorType,
    actor_id: actorId,
    display_name: typeof displayName === "string" ? displayName : null,
  };
}

// Reproduce, per kind, exactly the causal fields the live work-lifecycle emitter
// stamps (ts/src/work/service.ts), from the same inputs it derived them from.
// Returns null when any input is missing or inconsistent — those rows get the
// pre-M0 marker instead; we never guess.
function deriveCausalEnvelope(
  connection: SqliteDatabase,
  kind: string,
  actor: string,
  payload: JsonRecord,
): CausalEnvelope | null {
  const data = asJsonRecord(payload.data) ?? {};
  const refs = payload.refs;
  if (kind === "work.created") {
    const workItemId = emitterRecordedRef(asJsonRecord(data.work_item)?.id, refs);
    if (!workItemId) {
      return null;
    }
    return { actor_ref: inferredActorRef(actor), produced_refs: [workItemId], consumed_refs: [] };
  }
  if (kind === "work.outcome_submitted") {
    const outcome = asJsonRecord(data.worker_outcome);
    const workItemId = emitterRecordedRef(outcome?.work_item_id, refs);
    const envelopeId = emitterRecordedRef(outcome?.envelope_id, refs);
    if (!workItemId || !envelopeId) {
      return null;
    }
    return {
      actor_ref: inferredActorRef(actor),
      produced_refs: [],
      consumed_refs: [workItemId, envelopeId],
    };
  }
  if (kind === "work.envelope.created") {
    const envelopeId = emitterRecordedRef(data.envelope_id, refs);
    const workItemId = emitterRecordedRef(data.work_item_id, refs);
    if (!envelopeId || !workItemId) {
      return null;
    }
    const issuedBy = storedIssuedBy(connection, envelopeId, workItemId, actor);
    if (!issuedBy) {
      return null;
    }
    return { actor_ref: issuedBy, produced_refs: [envelopeId], consumed_refs: [workItemId] };
  }
  // Remaining instrumented kinds — work.assigned, work.reviewed, and the
  // setStatus family — all consume the work item referenced by data.work_item_id.
  const workItemId = emitterRecordedRef(data.work_item_id, refs);
  if (!workItemId) {
    return null;
  }
  return { actor_ref: inferredActorRef(actor), produced_refs: [], consumed_refs: [workItemId] };
}

// Decide a single row's rewrite: the reconstructed payload JSON, the marker-only
// payload JSON, or null to leave the row untouched.
function backfilledPayloadJson(connection: SqliteDatabase, row: EventRow): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload_json);
  } catch {
    // Unreadable row: leave it for the read paths to fail loudly on, as they
    // already would. A migration must not mask corruption.
    return null;
  }
  const event = asJsonRecord(parsed);
  const payload = event ? asJsonRecord(event.payload) : null;
  if (!event || !payload) {
    return null;
  }
  // Hash-chained rows postdate the M0 instrumentation and must never be rewritten
  // — catching exactly such edits is what the chain exists for.
  if (event.hash != null || event.prev_hash != null) {
    return null;
  }
  // Only rows still at the causal schema defaults are legacy; anything populated
  // was written by (or after) the instrumented emitters.
  if (payload.actor_ref != null || payload.causal_parent_id != null) {
    return null;
  }
  if (!isDefaultRefList(payload.produced_refs) || !isDefaultRefList(payload.consumed_refs)) {
    return null;
  }
  const data = asJsonRecord(payload.data) ?? {};
  if (data[PRE_M0_MARKER_KEY] !== undefined) {
    return null;
  }

  const causal = deriveCausalEnvelope(connection, row.kind, row.actor, payload);
  if (causal) {
    payload.actor_ref = causal.actor_ref;
    payload.produced_refs = causal.produced_refs;
    payload.consumed_refs = causal.consumed_refs;
    payload.causal_parent_id = null;
  } else {
    data[PRE_M0_MARKER_KEY] = true;
    payload.data = data;
  }
  event.payload = payload;
  return dumpJson(event);
}

function backfillPreM0CausalEnvelope(connection: SqliteDatabase): void {
  const placeholders = BACKFILL_WORK_KINDS.map(() => "?").join(", ");
  const rows = connection
    .prepare(
      `SELECT id, kind, actor, payload_json FROM events WHERE kind IN (${placeholders})
       ORDER BY workspace_id, seq`,
    )
    .all(...BACKFILL_WORK_KINDS) as EventRow[];

  const rewrites: Array<{ id: string; payload_json: string }> = [];
  for (const row of rows) {
    const payloadJson = backfilledPayloadJson(connection, row);
    if (payloadJson !== null) {
      rewrites.push({ id: row.id, payload_json: payloadJson });
    }
  }
  if (rewrites.length === 0) {
    return;
  }

  // The events table is append-only by trigger; this audited one-time migration
  // is the sanctioned exception. Drop + rewrites + recreate all run inside the
  // single initializeSchema transaction, so any failure restores the trigger.
  connection.exec("DROP TRIGGER IF EXISTS events_no_update;");
  const update = connection.prepare("UPDATE events SET payload_json = ? WHERE id = ?");
  for (const rewrite of rewrites) {
    update.run(rewrite.payload_json, rewrite.id);
  }
  connection.exec(EVENTS_NO_UPDATE_TRIGGER);
}
