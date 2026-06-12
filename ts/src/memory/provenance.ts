import type { MemoryEntry } from "../contracts/index.js";
import type { CapabilityResultStore, EventStore } from "../persistence/index.js";

/**
 * Single source of truth for the `provenance.note` marker that links a
 * collective memory entry back to the promotion that produced it. The producer
 * (PromotionService) and the consumer (MemoryRetrievalService) must agree on
 * this format, so it lives here rather than as duplicated string literals.
 */
export const SOURCE_PROMOTION_PREFIX = "source_promotion:";

/** Builds the provenance note recorded on a collective memory entry. */
export function sourcePromotionNote(candidateId: string): string {
  return `${SOURCE_PROMOTION_PREFIX}${candidateId}`;
}

/**
 * Extracts the source promotion candidate id from a provenance note, or null if
 * the note is absent, not a source-promotion marker, or carries no id.
 */
export function parseSourcePromotion(note: string | null | undefined): string | null {
  if (!note || !note.startsWith(SOURCE_PROMOTION_PREFIX)) {
    return null;
  }
  const candidateId = note.slice(SOURCE_PROMOTION_PREFIX.length).trim();
  return candidateId.length > 0 ? candidateId : null;
}

/**
 * The provenance invariant (#113): unprovenanced memory stays untrusted.
 *
 * `guidance_eligible` memory can be recalled by agents, proposed as collective
 * guidance, and counted as corroborating evidence. `untrusted` memory is still
 * recorded — anything may be remembered — but it is excluded from every agent
 * surface and only reachable through the evented operator review path.
 */
export type MemoryTrust = "guidance_eligible" | "untrusted";

/** Which provenance ref made an entry guidance-eligible. */
export type MemoryTrustBasis = "capability_result" | "source_event" | "operator_attestation";

export type MemoryTrustDerivation = {
  trust: MemoryTrust;
  /** First ref (in precedence order) that resolved; null when untrusted. */
  basis: MemoryTrustBasis | null;
  /**
   * Trust markers that were supplied but did not resolve or validate
   * (forged or dangling), as `<kind>:<value>` strings. Distinguishes "the
   * writer claimed provenance the store could not honor" from "the writer
   * supplied no provenance at all" — only the former is an integrity signal.
   */
  unresolved: string[];
};

export type MemoryTrustStores = {
  events: EventStore;
  capabilityResults: CapabilityResultStore;
};

// A canonical agent id can never stand in as an operator attestor: attestation
// is the explicitly human path into guidance, not a second self-assertion lane.
const AGENT_ID_REGEX = /^agent_[0-9a-f]{32}$/;

/** Deterministic idempotency key for an entry's operator-attestation event. */
export function operatorAttestedIdempotencyKey(entryId: string): string {
  return `${entryId}:operator_attested`;
}

/**
 * Whether a resolvable `memory.operator_attested` event proves the attestation
 * claimed by `provenance.attested_by`. Like the other two bases, operator
 * attestation only counts when the store can resolve it: the deterministic
 * attestation event must exist in the entry's workspace, name the same
 * attestor (actor), and reference the entry. A bare `attested_by` with no such
 * event does not resolve — a self-asserted string is not proof.
 */
function operatorAttestationResolves(
  entry: MemoryEntry,
  attestor: string,
  events: EventStore,
): boolean {
  const event = events.getByIdempotencyKey(
    entry.workspace_id,
    operatorAttestedIdempotencyKey(entry.id),
  );
  return (
    event !== null &&
    event.kind === "memory.operator_attested" &&
    event.actor === attestor &&
    event.payload.refs.includes(entry.id)
  );
}

/**
 * Derives the trust tier of a memory entry from its provenance refs. The tier
 * is computed, never writer-asserted: a ref only confers trust if the store
 * resolves it inside the entry's own workspace, in this precedence order:
 *
 * 1. `provenance.capability_result_id` resolves in the CapabilityResultStore;
 * 2. `provenance.source_event_id` resolves in the EventStore;
 * 3. `provenance.attested_by` is proven by a resolvable
 *    `memory.operator_attested` event (see PromotionService.attestMemory) —
 *    a bare self-asserted string is not proof.
 *
 * All supplied markers are evaluated (no short-circuit) so the derivation also
 * reports every forged/dangling/unproven ref, even ones outranked by a
 * resolving ref.
 */
export function deriveMemoryTrust(
  entry: MemoryEntry,
  stores: MemoryTrustStores,
): MemoryTrustDerivation {
  const unresolved: string[] = [];
  let basis: MemoryTrustBasis | null = null;

  const capabilityResultId = entry.provenance.capability_result_id;
  if (capabilityResultId) {
    const result = stores.capabilityResults.get(capabilityResultId);
    if (result && result.workspace_id === entry.workspace_id) {
      basis = "capability_result";
    } else {
      unresolved.push(`capability_result:${capabilityResultId}`);
    }
  }

  const sourceEventId = entry.provenance.source_event_id;
  if (sourceEventId) {
    const event = stores.events.get(sourceEventId);
    if (event && event.workspace_id === entry.workspace_id) {
      basis ??= "source_event";
    } else {
      unresolved.push(`source_event:${sourceEventId}`);
    }
  }

  const attestedBy = entry.provenance.attested_by;
  if (attestedBy !== null) {
    const attestor = attestedBy.trim();
    // The attestor must be a non-blank operator (never an agent id) AND be
    // proven by a resolvable attestation event. A claim with no event is a
    // supplied-but-unresolved marker, treated like any other dangling ref.
    if (
      attestor.length > 0 &&
      !AGENT_ID_REGEX.test(attestor) &&
      operatorAttestationResolves(entry, attestor, stores.events)
    ) {
      basis ??= "operator_attestation";
    } else {
      unresolved.push(`operator_attestation:${attestedBy}`);
    }
  }

  return basis
    ? { trust: "guidance_eligible", basis, unresolved }
    : { trust: "untrusted", basis: null, unresolved };
}
