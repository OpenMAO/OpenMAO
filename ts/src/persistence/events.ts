import { createHash } from "node:crypto";
import {
  type Event,
  type EventPayload,
  EventPayloadSchema,
  EventSchema,
  newId,
  utcNow,
} from "../contracts/index.js";
import type { Database } from "./database.js";
import { dumpJson, jsonEqual } from "./serialization.js";

/**
 * Chain anchor for the first event in a workspace. Every workspace event log
 * starts from this fixed value, so a missing or replaced genesis event is
 * detectable rather than silently valid.
 */
const GENESIS_HASH = "0".repeat(64);

/**
 * Deterministic content hash of an event, excluding the `hash` field itself.
 * Relies on `dumpJson` emitting canonical (sorted-key) output, so the digest is
 * stable across processes. Any change to any field — `prev_hash` included —
 * changes the digest.
 */
function hashEvent(event: Event): string {
  const { hash: _hash, ...content } = event;
  return createHash("sha256").update(dumpJson(content)).digest("hex");
}

/** Result of walking a workspace event chain; `broken_at` localizes the first failure. */
export type EventChainVerification =
  | { ok: true }
  | { ok: false; broken_at: string; reason: string };

type PayloadRow = { payload_json: string };
type SequenceRow = { next_seq: number };

export class EventIdempotencyConflictError extends Error {}

export type AppendEventInput = {
  workspace_id: string;
  kind: string;
  actor: string;
  run_id?: string | null;
  payload?: EventPayload | null;
  idempotency_key?: string | null;
  event_id?: string | null;
  timestamp?: string | null;
};

export class EventStore {
  constructor(private readonly database: Database) {}

  append(input: AppendEventInput): Event {
    return this.database.transaction(() => {
      const payload = EventPayloadSchema.parse(input.payload ?? {});
      if (input.idempotency_key) {
        const existing = this.getByIdempotencyKey(input.workspace_id, input.idempotency_key);
        if (existing) {
          if (
            existing.kind !== input.kind ||
            existing.actor !== input.actor ||
            (existing.run_id ?? null) !== (input.run_id ?? null) ||
            !jsonEqual(existing.payload, payload) ||
            (input.event_id && existing.id !== input.event_id) ||
            (input.timestamp && existing.timestamp !== input.timestamp)
          ) {
            throw new EventIdempotencyConflictError(
              "idempotency key was already used for a different event",
            );
          }

          return existing;
        }
      }

      const parsed = EventSchema.parse({
        id: input.event_id ?? newId("evt"),
        workspace_id: input.workspace_id,
        run_id: input.run_id ?? null,
        seq: this.nextWorkspaceSeq(input.workspace_id),
        run_seq: input.run_id ? this.nextRunSeq(input.workspace_id, input.run_id) : null,
        kind: input.kind,
        actor: input.actor,
        payload,
        timestamp: input.timestamp ?? utcNow(),
        idempotency_key: input.idempotency_key ?? null,
        prev_hash: this.latestHash(input.workspace_id) ?? GENESIS_HASH,
      });
      // Seal the event by chaining its content hash onto the previous one.
      const event: Event = { ...parsed, hash: hashEvent(parsed) };

      this.database.connection
        .prepare(
          `INSERT INTO events (
            id, workspace_id, run_id, seq, run_seq, kind, actor, payload_json,
            timestamp, idempotency_key
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          event.id,
          event.workspace_id,
          event.run_id,
          event.seq,
          event.run_seq,
          event.kind,
          event.actor,
          dumpJson(event),
          event.timestamp,
          event.idempotency_key,
        );
      return event;
    });
  }

  get(eventId: string): Event | null {
    const row = this.database.connection
      .prepare("SELECT payload_json FROM events WHERE id = ?")
      .get(eventId) as PayloadRow | undefined;

    return row ? EventSchema.parse(JSON.parse(row.payload_json)) : null;
  }

  getByIdempotencyKey(workspaceId: string, idempotencyKey: string): Event | null {
    const row = this.database.connection
      .prepare(
        `SELECT payload_json
         FROM events
         WHERE workspace_id = ? AND idempotency_key = ?`,
      )
      .get(workspaceId, idempotencyKey) as PayloadRow | undefined;

    return row ? EventSchema.parse(JSON.parse(row.payload_json)) : null;
  }

  listForWorkspace(workspaceId: string): Event[] {
    const rows = this.database.connection
      .prepare("SELECT payload_json FROM events WHERE workspace_id = ? ORDER BY seq")
      .all(workspaceId) as PayloadRow[];

    return rows.map((row) => EventSchema.parse(JSON.parse(row.payload_json)));
  }

  listForRun(workspaceId: string, runId: string): Event[] {
    const rows = this.database.connection
      .prepare(
        "SELECT payload_json FROM events WHERE workspace_id = ? AND run_id = ? ORDER BY run_seq",
      )
      .all(workspaceId, runId) as PayloadRow[];

    return rows.map((row) => EventSchema.parse(JSON.parse(row.payload_json)));
  }

  /**
   * Walks the workspace event chain in sequence order and re-derives every hash.
   * Detects payload tampering (hash mismatch), insertion or reordering (prev_hash
   * mismatch), and an unchained event (missing hash), returning the first break.
   *
   * This proves the chain is internally consistent. Detecting truncation of the
   * most recent events additionally requires anchoring the head hash in storage
   * not reconstructed from the events themselves — a natural follow-up.
   */
  verifyChain(workspaceId: string): EventChainVerification {
    let previousHash = GENESIS_HASH;
    for (const event of this.listForWorkspace(workspaceId)) {
      if (event.hash === null || event.prev_hash === null) {
        return { ok: false, broken_at: event.id, reason: "event is not hash-chained" };
      }
      if (event.prev_hash !== previousHash) {
        return {
          ok: false,
          broken_at: event.id,
          reason: "prev_hash does not match the preceding event (insertion or reorder)",
        };
      }
      if (hashEvent(event) !== event.hash) {
        return {
          ok: false,
          broken_at: event.id,
          reason: "event hash does not match its contents (tampering)",
        };
      }
      previousHash = event.hash;
    }
    return { ok: true };
  }

  private latestHash(workspaceId: string): string | null {
    const row = this.database.connection
      .prepare("SELECT payload_json FROM events WHERE workspace_id = ? ORDER BY seq DESC LIMIT 1")
      .get(workspaceId) as PayloadRow | undefined;

    return row ? EventSchema.parse(JSON.parse(row.payload_json)).hash : null;
  }

  private nextWorkspaceSeq(workspaceId: string): number {
    const row = this.database.connection
      .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM events WHERE workspace_id = ?")
      .get(workspaceId) as SequenceRow;

    return row.next_seq;
  }

  private nextRunSeq(workspaceId: string, runId: string): number {
    const row = this.database.connection
      .prepare(
        `SELECT COALESCE(MAX(run_seq), 0) + 1 AS next_seq
         FROM events
         WHERE workspace_id = ? AND run_id = ?`,
      )
      .get(workspaceId, runId) as SequenceRow;

    return row.next_seq;
  }
}
