import { newId, utcNow } from "../contracts/index.js";
import type { DecisionSigner } from "../governance/decision-signing.js";
import {
  type ChainHeadAttestation,
  ChainHeadAttestationStore,
  type Database,
  EventStore,
  GovernanceSignatureStore,
  PrincipalKeyStore,
  PrincipalStore,
} from "../persistence/index.js";
import { dumpJson } from "../persistence/serialization.js";
import { assertAuthenticatedPrincipal } from "./authenticated-principal.js";
import { assertNoSensitiveMaterial } from "./sensitive-material.js";
import {
  buildProtectedHeader,
  buildSigningInput,
  encodeSegment,
  mediaTypeForClass,
  payloadBytesForBody,
  type VerifyFailureReason,
  verifyObject,
} from "./signing.js";

/**
 * Signed chain-head attestation (M6): the operator key pins the current event-
 * chain head — sequence, hash, event count — in a signed, append-only,
 * self-chaining `chain_head_attestations` row, closing the truncation gap
 * `EventStore.verifyChain` documented: a chain whose newest events were
 * deleted is internally consistent and used to verify ok.
 *
 * The pattern is decision-signing's, under one constraint principal-authority
 * did not have: the attested facts must be read from stored state INSIDE the
 * writing transaction (the head cannot be attested from a caller-supplied or
 * stale read), and better-sqlite3 transactions are synchronous — so signing
 * happens inside the transaction with synchronous custody, and a broker that
 * answers asynchronously is refused with a typed error.
 *
 * Every value in the signed body comes from stored state, never from the
 * caller and never from a clock the caller can move:
 *
 *   - head sequence / head hash / event count are read from the event log in
 *     the transaction;
 *   - previous_attestation_id is read from the attestation store in the same
 *     transaction (the self-chain link);
 *   - attested_at is the STORED TIMESTAMP OF THE HEAD EVENT, deliberately not
 *     the wall-clock moment of attesting: the signed claim is "the chain head
 *     at stored position (seq, hash, count, head-event time)", and keeping
 *     every byte stored-derived is what makes a replay at the same head a
 *     byte-identical no-op (deterministic Ed25519 + the unique index) instead
 *     of a conflict. The wall-clock moment of the attesting ACT is recorded
 *     only on the appended event's own timestamp, outside the signed body.
 *
 * Who signed is resolved from STORED rows: the principal must be an
 * AuthenticatedPrincipal (identity-branded — a spread or cast copy is
 * refused), active, and human per its stored row; the key must be the one the
 * identity carries, active, and enrolled to that principal in this workspace.
 * The produced envelope must verify against the stored enrolled key through
 * verifyObject — a broker not holding the key it claims fails here — and the
 * attestation row, the governance_signatures row, and the audit event commit
 * in ONE transaction: on any failure nothing is written.
 *
 * HONEST SCOPE: the attestation lives in the same database as the events, so
 * it does not make truncation impossible — an attacker with direct file write
 * access can delete attestation rows beside the events. It detects truncation
 * only relative to an attestation that survives or was exported. Export/copy
 * of the attestation (or its signed bytes) is how an operator turns this into
 * durable evidence; nothing here claims more.
 */
export class ChainAttestationError extends Error {}

export const CHAIN_HEAD_ATTESTED_EVENT = "chain.head_attested";

export const CHAIN_ATTESTATION_OBJECT_TYPE = "chain_attestation";

export type AttestChainHeadResult = {
  attestation: ChainHeadAttestation;
  /** False when the current head was already attested — the replay no-op. */
  created: boolean;
};

/**
 * Produces a signed attestation of the workspace's current event-chain head.
 * Idempotent: the attestation's own audit event advances the head, so "an
 * unchanged head" means every event after the attested head is itself an
 * attestation event. In that case the surviving attestation is returned and
 * NOTHING is signed or written — but only after the attested position is
 * re-validated, so a no-op can never paper over a rewritten chain: if the
 * event at the attested sequence no longer matches, the act refuses loudly
 * instead of attesting over contradictory state.
 */
export function attestChainHead(input: {
  database: Database;
  workspaceId: string;
  signer: DecisionSigner;
}): AttestChainHeadResult {
  // The brand check happens BEFORE the transaction opens: a spread or cast
  // copy of an AuthenticatedPrincipal is refused here, so the identity the
  // whole act binds is the unforgeable one the credential path minted.
  assertAuthenticatedPrincipal(input.signer.principal);
  return input.database.transaction(() => {
    const signer = resolveStoredSigner(input.database, input.workspaceId, input.signer);

    // The attested facts, from stored state inside the transaction: the chain
    // head is the highest-seq event of the workspace, the count the surviving
    // rows. An empty log has nothing to anchor — refuse rather than attest a
    // genesis the log does not yet commit to.
    const headRow = input.database.connection
      .prepare(
        `SELECT payload_json FROM events
         WHERE workspace_id = ? ORDER BY seq DESC LIMIT 1`,
      )
      .get(input.workspaceId) as { payload_json: string } | undefined;
    if (!headRow) {
      throw new ChainAttestationError(
        `attestation refused; workspace ${input.workspaceId} has no events to attest`,
      );
    }
    const head = JSON.parse(headRow.payload_json) as {
      seq: number;
      hash: string | null;
      timestamp: string;
    };
    if (typeof head.hash !== "string" || head.hash.length === 0) {
      throw new ChainAttestationError(
        `attestation refused; the chain head (seq ${head.seq}) is not hash-chained — an unchained head cannot be anchored`,
      );
    }
    const eventCount = (
      input.database.connection
        .prepare("SELECT COUNT(*) AS count FROM events WHERE workspace_id = ?")
        .get(input.workspaceId) as { count: number }
    ).count;

    const store = new ChainHeadAttestationStore(input.database);
    const previous = store.latestForWorkspace(input.workspaceId);
    if (previous) {
      // Idempotency, precisely: the attestation's own audit event advances the
      // chain head, so a naive "head == attested head" check can never replay.
      // The head is UNCHANGED for attestation purposes when every event after
      // the attested head is itself an attestation event — no new attested
      // fact exists, and the surviving attestation IS this attestation.
      const laterKinds = input.database.connection
        .prepare("SELECT kind FROM events WHERE workspace_id = ? AND seq > ? ORDER BY seq")
        .all(input.workspaceId, previous.head_sequence) as Array<{ kind: string }>;
      if (laterKinds.every((row) => row.kind === CHAIN_HEAD_ATTESTED_EVENT)) {
        // A no-op must never paper over a rewrite: the event AT the attested
        // position must still survive with the attested hash. If it does not,
        // the chain was rewritten after attestation — refuse loudly rather
        // than attest (or silently keep) over contradictory state.
        const attestedRow = input.database.connection
          .prepare("SELECT payload_json FROM events WHERE workspace_id = ? AND seq = ?")
          .get(input.workspaceId, previous.head_sequence) as { payload_json: string } | undefined;
        const attestedEvent = attestedRow
          ? (JSON.parse(attestedRow.payload_json) as { hash: string | null })
          : null;
        if (!attestedEvent || attestedEvent.hash !== previous.head_hash) {
          throw new ChainAttestationError(
            `attestation refused; attestation ${previous.id} pins head seq ${previous.head_sequence} but the surviving event there does not match — the chain was rewritten after attestation; refusing to attest over it`,
          );
        }
        // Byte-identical by construction: nothing is signed or written — no
        // new row, no new event.
        return { attestation: previous, created: false };
      }
    }

    const attestedAt = head.timestamp;
    const attestationId = newId("chainatt");
    const objectClass = "chain_attestation";
    // The signed body, explicitly enumerated — every value from stored state.
    const body: Record<string, unknown> = {
      workspace_id: input.workspaceId,
      object_id: attestationId,
      signer: signer.principalId,
      signer_key_id: signer.keyId,
      head_sequence: head.seq,
      head_hash: head.hash,
      event_count: eventCount,
      previous_attestation_id: previous?.id ?? null,
      attested_at: attestedAt,
    };
    const headerSegment = encodeSegment(
      Buffer.from(dumpJson(buildProtectedHeader(objectClass, signer.keyId)), "utf8"),
    );
    const payloadSegment = encodeSegment(payloadBytesForBody(body));
    const signingInput = buildSigningInput(headerSegment, payloadSegment);
    const signature = input.signer.broker.sign(
      input.signer.handle,
      Buffer.from(signingInput, "utf8"),
    );
    if (signature instanceof Promise) {
      throw new ChainAttestationError(
        "attestation refused; signing custody must be synchronous — the attested head is read and signed inside one transaction, which cannot await",
      );
    }
    if (!signature) {
      throw new ChainAttestationError("attestation refused; signing custody returned no signature");
    }
    const envelope = {
      protectedHeaderSegment: headerSegment,
      payloadSegment,
      signatureSegment: encodeSegment(signature),
    };
    // Substantiate before recording: the produced envelope must verify against
    // the signer's ENROLLED key through the registry-backed verifier, with
    // substrate time as the authority clock (key validity windows are
    // evaluated here, never against the stored head time). A broker holding
    // material other than the claimed enrolled key fails here, and the
    // transaction rolls back: no attestation row, no signature row, no event.
    const verdict = verifyObject({
      database: input.database,
      workspaceId: input.workspaceId,
      expectedClass: objectClass,
      expectedObjectId: attestationId,
      envelope,
      now: utcNow(),
    });
    if (!verdict.ok) {
      throw new ChainAttestationError(
        `attestation refused; the produced signature failed registry-backed verification (${verdict.reason}) — signing custody does not hold the claimed enrolled key`,
      );
    }
    const signatureRow = new GovernanceSignatureStore(input.database).record({
      id: newId("govsig"),
      workspace_id: input.workspaceId,
      object_type: CHAIN_ATTESTATION_OBJECT_TYPE,
      object_id: attestationId,
      signer_key_id: signer.keyId,
      signer_principal_id: signer.principalId,
      // The exact signed byte string (header.payload segments): verification
      // later runs over these literal bytes, never a re-serialization.
      signed_bytes: signingInput,
      signature: envelope.signatureSegment,
      domain_tag: mediaTypeForClass(objectClass),
      signed_at: attestedAt,
    });
    const attestation = store.record({
      id: attestationId,
      workspace_id: input.workspaceId,
      head_sequence: head.seq,
      head_hash: head.hash,
      event_count: eventCount,
      previous_attestation_id: previous?.id ?? null,
      signer_key_id: signer.keyId,
      signer_principal_id: signer.principalId,
      signature_id: signatureRow.id,
      attested_at: attestedAt,
    });
    const eventData = {
      attestation_id: attestation.id,
      head_sequence: attestation.head_sequence,
      head_hash: attestation.head_hash,
      event_count: attestation.event_count,
      previous_attestation_id: attestation.previous_attestation_id,
      signature_id: signatureRow.id,
      signer_key_id: signer.keyId,
      attested_at: attestedAt,
      trust: verdict.trust,
    };
    assertNoSensitiveMaterial(eventData, CHAIN_HEAD_ATTESTED_EVENT);
    new EventStore(input.database).append({
      workspace_id: input.workspaceId,
      kind: CHAIN_HEAD_ATTESTED_EVENT,
      actor: signer.principalId,
      payload: {
        data: eventData,
        refs: [attestation.id],
        actor_ref: null,
        produced_refs: [],
        consumed_refs: [],
        causal_parent_id: null,
      },
      // The attesting ACT's wall-clock moment lives here — on the event's own
      // timestamp, outside the signed body, where a clock can never rewrite
      // the attested facts.
      timestamp: utcNow(),
    });
    return { attestation, created: true };
  });
}

/**
 * Resolves the signer from STORED rows inside the writing transaction: the
 * principal must exist in this workspace, be active, and be human per its
 * stored row (a caller cannot assert kind or standing by supplying a field);
 * the key must be the one the authenticated identity carries, active, and
 * enrolled to that principal in this workspace. A principal disabled or a key
 * revoked between the boundary's authentication read and BEGIN fails the
 * write and rolls it back.
 */
function resolveStoredSigner(
  database: Database,
  workspaceId: string,
  signer: DecisionSigner,
): { principalId: string; keyId: string } {
  const stored = new PrincipalStore(database).get(signer.principal.principal_id);
  if (!stored || stored.workspace_id !== workspaceId) {
    throw new ChainAttestationError(
      `attestation refused; signer principal not found in workspace: ${signer.principal.principal_id}`,
    );
  }
  if (stored.status !== "active") {
    throw new ChainAttestationError(
      `attestation refused; signer principal is not active: ${signer.principal.principal_id}`,
    );
  }
  if (stored.kind !== "human") {
    throw new ChainAttestationError(
      `attestation refused; signer principal is not human (stored kind: ${stored.kind})`,
    );
  }
  const keyId = signer.principal.key_id;
  if (keyId === null) {
    throw new ChainAttestationError(
      "attestation refused; the authenticated principal carries no signing key",
    );
  }
  const key = new PrincipalKeyStore(database).get(keyId);
  if (!key || key.workspace_id !== workspaceId || key.principal_id !== stored.id) {
    throw new ChainAttestationError(
      `attestation refused; key ${keyId} is not an enrolled key of principal ${signer.principal.principal_id} in this workspace`,
    );
  }
  if (key.status !== "active") {
    throw new ChainAttestationError(`attestation refused; signer key is not active: ${keyId}`);
  }
  return { principalId: stored.id, keyId: key.id };
}
