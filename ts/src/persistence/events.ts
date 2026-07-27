import { createHash } from "node:crypto";
import {
  type Event,
  type EventPayload,
  EventPayloadSchema,
  EventSchema,
  newId,
  utcNow,
} from "../contracts/index.js";
import { type ChainHeadAttestation, ChainHeadAttestationStore } from "./chain-attestations.js";
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

/**
 * Read-time authenticity check for the attestation the truncation arm is
 * about to trust, injected by the caller because the security layer that can
 * evaluate it (verifyChainHeadAttestation) sits above persistence and
 * importing it here would cycle the module graph. verifyAllChains wires the
 * real check in; the default (omitted) is "not checked", which preserves the
 * exact pre-existing semantics for embedding callers of EventStore alone.
 */
export type AttestationAuthenticityChecker = (
  attestation: ChainHeadAttestation,
) => { ok: true } | { ok: false; reason: string };

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
   * The internal walk alone proves only that the chain is consistent with itself:
   * recomputing hashes from the events it can see cannot notice events it CANNOT
   * see. The follow-up named here previously is M6: after the internal walk
   * passes, the head is compared against the latest surviving signed chain-head
   * attestation (chain_head_attestations), which pins (head_sequence, head_hash,
   * event_count) OUTSIDE the reconstructed log. Two further break classes:
   *
   *   - truncation: the surviving head sequence is BEHIND the attested head —
   *     the newest events were deleted, leaving a shorter, self-consistent chain;
   *   - attested-head mismatch: the event AT the attested sequence carries a
   *     different hash than the attestation pinned — a sophisticated rewrite
   *     that recomputed every successor hash still fails here, because the
   *     attested value is not derivable from the rewritten events.
   *
   * HONEST SCOPE: this detects truncation/rewrite only relative to an
   * attestation that SURVIVES or was exported. An attacker with direct write
   * access to the database file can delete the attestation rows beside the
   * events (the append-only triggers guard the code path, not the file), and a
   * workspace with no attestation gets the pre-M6 semantics — internally
   * consistent truncation still verifies ok. Saying more would overclaim.
   *
   * When the caller supplies an attestation-authenticity check (verifyAllChains
   * does; the default is "not checked"), a surviving attestation whose
   * signature does NOT verify is a break with its own distinct reason — never
   * a satisfied anchor, never a silent skip: an unverifiable attestation does
   * not count as one.
   */
  verifyChain(
    workspaceId: string,
    checkAttestationAuthenticity?: AttestationAuthenticityChecker,
  ): EventChainVerification {
    // The attestation is read BEFORE the walk so the walk can also watch the
    // attested position itself: the event AT the attested sequence must
    // survive with the attested hash, even when the chain has advanced past it.
    const attestation = new ChainHeadAttestationStore(this.database).latestForWorkspace(
      workspaceId,
    );
    let previousHash = GENESIS_HASH;
    let head: Event | null = null;
    let eventCount = 0;
    let eventAtAttestedSequence: Event | null = null;
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
      head = event;
      eventCount += 1;
      if (attestation && event.seq === attestation.head_sequence) {
        eventAtAttestedSequence = event;
      }
    }
    return this.verifyHeadAgainstAttestation(
      attestation,
      head,
      eventCount,
      eventAtAttestedSequence,
      checkAttestationAuthenticity,
    );
  }

  /**
   * The truncation arm: compares the internally-consistent chain against the
   * latest SURVIVING attestation. Read-only and silent by design when no
   * attestation exists (a legacy database, or one never attested, verifies
   * exactly as before M6) — the arm runs only after the internal walk passes,
   * so it can ADD a break class, never mask one.
   *
   * Authenticity is checked FIRST, before any column comparison: the arm's
   * authority comes from the attestation being signed by an enrolled key, not
   * from the row asserting it was. An attestation whose signature does not
   * verify is a break with its own distinct reason — never a satisfied anchor,
   * never a silent skip. Fail closed: an attestation that cannot be verified
   * does not count as one.
   */
  private verifyHeadAgainstAttestation(
    attestation: ChainHeadAttestation | null,
    head: Event | null,
    eventCount: number,
    eventAtAttestedSequence: Event | null,
    checkAttestationAuthenticity?: AttestationAuthenticityChecker,
  ): EventChainVerification {
    if (!attestation) {
      return { ok: true };
    }
    if (checkAttestationAuthenticity) {
      const authenticity = checkAttestationAuthenticity(attestation);
      if (!authenticity.ok) {
        return {
          ok: false,
          broken_at: attestation.id,
          reason:
            `attestation signature invalid: attestation ${attestation.id} (attested head seq ` +
            `${attestation.head_sequence}) failed read-time verification (${authenticity.reason}) ` +
            `— a row asserting it was attested is a marker, not provenance, and an attestation ` +
            `whose signature does not verify against an enrolled key is not an anchor`,
        };
      }
    }
    const headSequence = head?.seq ?? 0;
    if (headSequence < attestation.head_sequence) {
      return {
        ok: false,
        broken_at: head?.id ?? attestation.id,
        reason:
          `truncation: chain head seq ${headSequence} is behind the latest surviving ` +
          `attestation ${attestation.id} (attested head seq ${attestation.head_sequence}, ` +
          `${attestation.event_count} events attested, ${eventCount} survive)`,
      };
    }
    if (!eventAtAttestedSequence) {
      return {
        ok: false,
        broken_at: attestation.id,
        reason:
          `truncation: no event survives at the attested head seq ${attestation.head_sequence} ` +
          `pinned by attestation ${attestation.id}, though the chain head is seq ${headSequence} ` +
          `— the attested position was deleted or renumbered and the chain re-chained`,
      };
    }
    if (
      eventAtAttestedSequence.hash !== attestation.head_hash ||
      (headSequence === attestation.head_sequence && eventCount !== attestation.event_count)
    ) {
      return {
        ok: false,
        broken_at: eventAtAttestedSequence.id,
        reason:
          `attested head mismatch: the event at the attested head seq ${attestation.head_sequence} ` +
          `does not match attestation ${attestation.id} (attested hash ${attestation.head_hash}, ` +
          `${attestation.event_count} events attested, ${eventCount} at that head now) — the ` +
          `chain was rewritten and re-chained after attestation`,
      };
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
