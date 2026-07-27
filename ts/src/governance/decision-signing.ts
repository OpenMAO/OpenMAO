import type { ApprovalRequest, AutonomyCase, OrgChangeApplication } from "../contracts/index.js";
import { newId, utcNow } from "../contracts/index.js";
import {
  type Database,
  type GovernanceSignature,
  GovernanceSignatureStore,
  PrincipalKeyStore,
  PrincipalStore,
} from "../persistence/index.js";
import { dumpJson } from "../persistence/serialization.js";
import {
  type AuthenticatedPrincipal,
  assertAuthenticatedPrincipal,
} from "../security/authenticated-principal.js";
import {
  buildProtectedHeader,
  buildSigningInput,
  encodeSegment,
  mediaTypeForClass,
  payloadBytesForBody,
  type SignatureTrust,
  verifyObject,
} from "../security/signing.js";
import type { SigningBroker } from "../security/signing-broker.js";

/**
 * Signed governance decisions (M5). The four authority-moving transitions —
 * approval approve/reject, autonomy ratification, org-change apply/revert —
 * each carry the decider's Ed25519 signature, recorded in the
 * `governance_signatures` sibling table INSIDE the state-transition
 * transaction: state change, signature row, and event commit together or not
 * at all. Signatures never enter an event payload; the event carries only a
 * reference plus the verifier's trust decision inside the opaque
 * `payload.data`.
 *
 * The pattern is principal-authority's, adapted to one constraint that module
 * did not have: the state-transition transaction cannot await (better-sqlite3
 * transactions are synchronous), and the signed body must carry timestamps
 * FROM THE STORED ROW — so signing happens inside the transaction, after the
 * state change, with synchronous custody. A broker that answers
 * asynchronously cannot serve this path and is refused with a typed error.
 *
 * Who signed is resolved from STORED rows, never from caller claims: the
 * principal must be an AuthenticatedPrincipal (identity-branded — a spread or
 * cast copy is refused), active, and human per its stored row; the key must
 * be the one the identity carries, active, and enrolled to that principal in
 * this workspace. The produced envelope must then verify against the stored
 * enrolled key through verifyObject — a broker that does not hold the key it
 * claims produces a signature that fails here, and the transaction rolls
 * back: no state change, no signature row, no event.
 */
export class DecisionSigningError extends Error {}

/**
 * The signer a boundary hands to an authority-moving transition: an
 * authenticated identity (unforgeable — minted only by the credential path),
 * the custody broker that holds its key, and the non-secret handle naming
 * that key to the broker.
 */
export type DecisionSigner = {
  principal: AuthenticatedPrincipal;
  broker: SigningBroker;
  handle: string;
};

/**
 * One decision-specific media type per transition, so the decision class is
 * bound INTO the signed bytes through the JOSE `typ` parameter (the M1 class
 * separation mechanism) — a signature recorded for object type A cannot be
 * reclassified to type B without invalidating it, because the verifier
 * re-derives `typ` from the stored `object_type` column and refuses on
 * class_mismatch. Registration in signing.ts's SIGNED_OBJECT_MEDIA_TYPES is
 * what makes each a recognized class at all.
 */
export const DECISION_OBJECT_CLASS = {
  approval_approve: "governance_decision.approval_approve",
  approval_reject: "governance_decision.approval_reject",
  autonomy_ratify: "governance_decision.autonomy_ratify",
  org_change_apply: "governance_decision.org_change_apply",
  org_change_revert: "governance_decision.org_change_revert",
} as const;

export type DecisionObjectClass =
  (typeof DECISION_OBJECT_CLASS)[keyof typeof DECISION_OBJECT_CLASS];

/**
 * The identity fields an authority path may act on, read ONCE. Decision paths
 * take this snapshot at the top of the transition and use it for BOTH the
 * separation-of-duties guard and the stored-signer resolution, so the two
 * can never observe different values even in principle — freezing the minted
 * principal closes the known vector; single-read closes the class.
 */
export type PrincipalIdentitySnapshot = {
  principal_id: string;
  actor: string;
  key_id: string | null;
};

export function snapshotPrincipalIdentity(
  principal: AuthenticatedPrincipal,
): PrincipalIdentitySnapshot {
  assertAuthenticatedPrincipal(principal);
  return {
    principal_id: principal.principal_id,
    actor: principal.actor,
    key_id: principal.key_id,
  };
}

/** `governance_signatures.object_type` values — decision-qualified so one signer can both apply and later revert the same object. The keys are the transitions; each maps 1:1 to a decision-specific media type (DECISION_OBJECT_CLASS) so the object type is bound into the signed bytes. */
export const DECISION_OBJECT_TYPES: {
  readonly [K in keyof typeof DECISION_OBJECT_CLASS]: K;
} = {
  approval_approve: "approval_approve",
  approval_reject: "approval_reject",
  autonomy_ratify: "autonomy_ratify",
  org_change_apply: "org_change_apply",
  org_change_revert: "org_change_revert",
};

export type DecisionObjectType = (typeof DECISION_OBJECT_TYPES)[keyof typeof DECISION_OBJECT_TYPES];

export type RecordedDecision = {
  row: GovernanceSignature;
  trust: SignatureTrust;
};

/**
 * The claims half of an approval decision body, derived ENTIRELY from the
 * stored approval row — a verifier re-reading the row reconstructs the exact
 * signed body, so a future persistence change that alters stored bytes shows
 * up as a verification failure, never as silently unverifiable history.
 */
export function approvalDecisionClaims(approval: ApprovalRequest): Record<string, unknown> {
  return {
    decision: approval.status,
    action: approval.action,
    requested_by: approval.requested_by,
    target_type: approval.payload.target_type,
    target_id: approval.payload.target_id,
    resolved_at: approval.resolved_at,
  };
}

export function autonomyRatificationClaims(autonomyCase: AutonomyCase): Record<string, unknown> {
  return {
    decision: "ratified",
    org_id: autonomyCase.org_id,
    current_level: autonomyCase.current_level,
    proposed_level: autonomyCase.proposed_level,
    proposed_by: autonomyCase.proposed_by,
    ratified_by: autonomyCase.ratified_by,
    resolved_at: autonomyCase.resolved_at,
  };
}

export function orgChangeApplyClaims(application: OrgChangeApplication): Record<string, unknown> {
  return {
    decision: "applied",
    proposal_id: application.proposal_id,
    change_type: application.change_type,
    applied_by: application.applied_by,
    created_at: application.created_at,
  };
}

export function orgChangeRevertClaims(application: OrgChangeApplication): Record<string, unknown> {
  return {
    decision: "reverted",
    proposal_id: application.proposal_id,
    change_type: application.change_type,
    applied_by: application.applied_by,
    reverted_at: application.reverted_at,
  };
}

/**
 * The full signed body: the verifier's envelope claims (workspace, object,
 * signer) plus the transition's claims. Exported so a verifier can rebuild
 * the exact body from stored rows and compare it against the persisted
 * signed bytes.
 */
export function buildDecisionBody(input: {
  workspaceId: string;
  objectId: string;
  signerPrincipalId: string;
  signerKeyId: string;
  claims: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    workspace_id: input.workspaceId,
    object_id: input.objectId,
    signer: input.signerPrincipalId,
    signer_key_id: input.signerKeyId,
    ...input.claims,
  };
}

/**
 * The reference an event payload carries for a recorded decision: ids, the
 * domain tag, the decision time, and the verifier's trust label — never the
 * signature bytes (those stay in the sibling table, out of the hash-chained
 * payload).
 */
export function decisionSignatureRef(decision: RecordedDecision): Record<string, unknown> {
  return {
    signature_id: decision.row.id,
    object_type: decision.row.object_type,
    signer_key_id: decision.row.signer_key_id,
    signer_principal_id: decision.row.signer_principal_id,
    domain_tag: decision.row.domain_tag,
    signed_at: decision.row.signed_at,
    trust: decision.trust,
  };
}

/**
 * Resolves the signer from STORED rows: the principal must exist in this
 * workspace, be active, and be human per its stored row (a caller cannot
 * assert kind or standing by supplying a field); the key must be the one the
 * authenticated identity carries, active, and enrolled to that principal in
 * this workspace. Called INSIDE the writing transaction, so a principal
 * disabled or a key revoked between the boundary's authentication read and
 * BEGIN fails the write and rolls it back.
 */
function resolveStoredSigner(
  database: Database,
  workspaceId: string,
  identity: PrincipalIdentitySnapshot,
  operation: string,
): { principalId: string; keyId: string } {
  const stored = new PrincipalStore(database).get(identity.principal_id);
  if (!stored || stored.workspace_id !== workspaceId) {
    throw new DecisionSigningError(
      `${operation} refused; signer principal not found in workspace: ${identity.principal_id}`,
    );
  }
  if (stored.status !== "active") {
    throw new DecisionSigningError(
      `${operation} refused; signer principal is not active: ${identity.principal_id}`,
    );
  }
  if (stored.kind !== "human") {
    throw new DecisionSigningError(
      `${operation} refused; signer principal is not human (stored kind: ${stored.kind})`,
    );
  }
  if (identity.key_id === null) {
    throw new DecisionSigningError(
      `${operation} refused; the authenticated principal carries no signing key`,
    );
  }
  const key = new PrincipalKeyStore(database).get(identity.key_id);
  if (!key || key.workspace_id !== workspaceId || key.principal_id !== stored.id) {
    throw new DecisionSigningError(
      `${operation} refused; key ${identity.key_id} is not an enrolled key of principal ${identity.principal_id} in this workspace`,
    );
  }
  if (key.status !== "active") {
    throw new DecisionSigningError(
      `${operation} refused; signer key is not active: ${identity.key_id}`,
    );
  }
  return { principalId: stored.id, keyId: key.id };
}

/**
 * Module-private signing core: reachable ONLY through the four
 * transition-specific wrappers below, each of which derives the object type,
 * claims, and decision time from the stored row it just mutated. There is no
 * exported primitive that signs a caller-supplied (type, id, claims, time)
 * tuple — a signature for an arbitrary or non-existent object cannot be
 * produced through this module. Must run INSIDE the caller's state-transition
 * transaction — the stored-row resolution doubles as the in-transaction
 * standing re-check, and any throw rolls the whole transition back.
 */
function signGovernanceDecision(input: {
  database: Database;
  workspaceId: string;
  signer: DecisionSigner;
  identity: PrincipalIdentitySnapshot;
  objectType: DecisionObjectType;
  objectId: string;
  claims: Record<string, unknown>;
  decidedAt: string;
}): RecordedDecision {
  const signer = resolveStoredSigner(
    input.database,
    input.workspaceId,
    input.identity,
    input.objectType,
  );
  const objectClass = DECISION_OBJECT_CLASS[input.objectType];
  const body = buildDecisionBody({
    workspaceId: input.workspaceId,
    objectId: input.objectId,
    signerPrincipalId: signer.principalId,
    signerKeyId: signer.keyId,
    claims: input.claims,
  });
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
    throw new DecisionSigningError(
      `${input.objectType} refused; signing custody must be synchronous — a state-transition transaction cannot await`,
    );
  }
  if (!signature) {
    throw new DecisionSigningError(
      `${input.objectType} refused; signing custody returned no signature`,
    );
  }
  const envelope = {
    protectedHeaderSegment: headerSegment,
    payloadSegment,
    signatureSegment: encodeSegment(signature),
  };
  // Two different clocks, deliberately separated:
  //
  //   - validityNow: SUBSTRATE time, read here inside the transition. Key
  //     validity windows are evaluated against this clock and this clock
  //     only — a caller-supplied (or stored-row) decision time may move the
  //     transition's recorded time, but it must never move the authority
  //     clock, or an expired key could sign by supplying a backdated `at`.
  //
  //   - decidedAt: the stored-row decision time. It is what the transition
  //     happened AT — persisted as signed_at and replay-stable — but it is
  //     not an authority source and is never consulted for validity.
  const validityNow = utcNow();
  // Substantiate before recording: the envelope just produced must verify
  // against the signer's ENROLLED key through the registry-backed verifier,
  // with substrate time as the authority clock. A broker holding material
  // other than the claimed enrolled key fails here.
  const verdict = verifyObject({
    database: input.database,
    workspaceId: input.workspaceId,
    expectedClass: objectClass,
    expectedObjectId: input.objectId,
    envelope,
    now: validityNow,
  });
  if (!verdict.ok) {
    throw new DecisionSigningError(
      `${input.objectType} refused; the produced signature failed registry-backed verification (${verdict.reason}) — signing custody does not hold the claimed enrolled key`,
    );
  }
  const row = new GovernanceSignatureStore(input.database).record({
    id: newId("govsig"),
    workspace_id: input.workspaceId,
    object_type: input.objectType,
    object_id: input.objectId,
    signer_key_id: signer.keyId,
    signer_principal_id: signer.principalId,
    // The exact signed byte string (header.payload segments): verification
    // later runs over these literal bytes, never a re-serialization.
    signed_bytes: signingInput,
    signature: envelope.signatureSegment,
    domain_tag: mediaTypeForClass(objectClass),
    signed_at: input.decidedAt,
  });
  return { row, trust: verdict.trust };
}

/**
 * The shared signing half of the four authority-moving transitions. Each
 * wrapper below asserts the caller's declared object type against the
 * decision it re-derived FROM THE STORED ROW IT MUTATED — a caller that
 * names one transition but hands over another's claims never reaches
 * signing, and the type signed into the bytes is always the transition the
 * row actually underwent. This is the whole public surface: the generic
 * "sign anything" primitive is module-private, so a caller cannot produce a
 * signature for an arbitrary or non-existent object.
 */
function signDecisionForStoredRow(input: {
  database: Database;
  workspaceId: string;
  signer: DecisionSigner;
  identity: PrincipalIdentitySnapshot;
  expectedObjectType: DecisionObjectType;
  objectType: DecisionObjectType;
  objectId: string;
  claims: Record<string, unknown>;
  decidedAt: string;
}): RecordedDecision {
  assertAuthenticatedPrincipal(input.signer.principal);
  if (input.objectType !== input.expectedObjectType) {
    throw new DecisionSigningError(
      `decision signing refused; declared object type ${input.objectType} does not match the transition derived from the stored row (${input.expectedObjectType})`,
    );
  }
  // The identity snapshot comes from the wrapper, which took it ONCE at the
  // top of the transition path; passing the snapshot onward (not the
  // principal object) is what makes guard and signer read the same values.
  return signGovernanceDecision(input);
}

export function signApprovalDecision(input: {
  database: Database;
  workspaceId: string;
  signer: DecisionSigner;
  identity: PrincipalIdentitySnapshot;
  objectType: DecisionObjectType;
  approval: ApprovalRequest;
}): RecordedDecision {
  if (
    input.objectType !== DECISION_OBJECT_TYPES.approval_approve &&
    input.objectType !== DECISION_OBJECT_TYPES.approval_reject
  ) {
    throw new DecisionSigningError(
      `approval decision signing refused; ${input.objectType} is not an approval transition`,
    );
  }
  const expectedObjectType =
    input.approval.status === "approved"
      ? DECISION_OBJECT_TYPES.approval_approve
      : input.approval.status === "rejected"
        ? DECISION_OBJECT_TYPES.approval_reject
        : null;
  if (!expectedObjectType) {
    throw new DecisionSigningError(
      `approval decision signing refused; the stored approval row is not resolved: ${input.approval.id}`,
    );
  }
  return signDecisionForStoredRow({
    database: input.database,
    workspaceId: input.workspaceId,
    signer: input.signer,
    identity: input.identity,
    expectedObjectType,
    objectType: input.objectType,
    objectId: input.approval.id,
    claims: approvalDecisionClaims(input.approval),
    decidedAt: requireStoredDecisionTime(input.approval.resolved_at, input.approval.id),
  });
}

export function signAutonomyRatification(input: {
  database: Database;
  workspaceId: string;
  signer: DecisionSigner;
  identity: PrincipalIdentitySnapshot;
  objectType: DecisionObjectType;
  autonomyCase: AutonomyCase;
}): RecordedDecision {
  if (input.objectType !== DECISION_OBJECT_TYPES.autonomy_ratify) {
    throw new DecisionSigningError(
      `autonomy ratification signing refused; ${input.objectType} is not the autonomy transition`,
    );
  }
  if (input.autonomyCase.status !== "ratified") {
    throw new DecisionSigningError(
      `autonomy ratification signing refused; the stored case is not ratified: ${input.autonomyCase.id}`,
    );
  }
  return signDecisionForStoredRow({
    database: input.database,
    workspaceId: input.workspaceId,
    signer: input.signer,
    identity: input.identity,
    expectedObjectType: DECISION_OBJECT_TYPES.autonomy_ratify,
    objectType: input.objectType,
    objectId: input.autonomyCase.id,
    claims: autonomyRatificationClaims(input.autonomyCase),
    decidedAt: requireStoredDecisionTime(input.autonomyCase.resolved_at, input.autonomyCase.id),
  });
}

export function signOrgChangeApply(input: {
  database: Database;
  workspaceId: string;
  signer: DecisionSigner;
  identity: PrincipalIdentitySnapshot;
  objectType: DecisionObjectType;
  application: OrgChangeApplication;
}): RecordedDecision {
  if (input.objectType !== DECISION_OBJECT_TYPES.org_change_apply) {
    throw new DecisionSigningError(
      `org-change apply signing refused; ${input.objectType} is not the apply transition`,
    );
  }
  return signDecisionForStoredRow({
    database: input.database,
    workspaceId: input.workspaceId,
    signer: input.signer,
    identity: input.identity,
    expectedObjectType: DECISION_OBJECT_TYPES.org_change_apply,
    objectType: input.objectType,
    objectId: input.application.id,
    claims: orgChangeApplyClaims(input.application),
    decidedAt: requireStoredDecisionTime(input.application.created_at, input.application.id),
  });
}

export function signOrgChangeRevert(input: {
  database: Database;
  workspaceId: string;
  signer: DecisionSigner;
  identity: PrincipalIdentitySnapshot;
  objectType: DecisionObjectType;
  application: OrgChangeApplication;
}): RecordedDecision {
  if (input.objectType !== DECISION_OBJECT_TYPES.org_change_revert) {
    throw new DecisionSigningError(
      `org-change revert signing refused; ${input.objectType} is not the revert transition`,
    );
  }
  if (input.application.status !== "reverted") {
    throw new DecisionSigningError(
      `org-change revert signing refused; the stored application is not reverted: ${input.application.id}`,
    );
  }
  return signDecisionForStoredRow({
    database: input.database,
    workspaceId: input.workspaceId,
    signer: input.signer,
    identity: input.identity,
    expectedObjectType: DECISION_OBJECT_TYPES.org_change_revert,
    objectType: input.objectType,
    objectId: input.application.id,
    claims: orgChangeRevertClaims(input.application),
    // Fail closed: a reverted application with no reverted_at refuses rather
    // than borrowing a caller-influenced clock. The signed body's time comes
    // from the stored row or the transition does not sign.
    decidedAt: requireStoredDecisionTime(input.application.reverted_at, input.application.id),
  });
}

/**
 * A stored-row decision time, required. The row-derived-timestamp rule has
 * no fallback: a row that reached its decision state without its decision
 * time is a storage violation, and the transition refuses to sign rather
 * than substitute a clock the caller could influence.
 */
function requireStoredDecisionTime(value: string | null, objectId: string): string {
  if (!value) {
    throw new DecisionSigningError(
      `decision signing refused; the stored row has no decision time: ${objectId}`,
    );
  }
  return value;
}
