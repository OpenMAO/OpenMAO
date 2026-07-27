import { newId, utcNow } from "../contracts/index.js";
import {
  type Database,
  EventStore,
  type Principal,
  PrincipalCredentialStore,
  type PrincipalKey,
  PrincipalKeyAttestationStore,
  PrincipalKeyRevocationStore,
  PrincipalKeyStore,
  PrincipalStore,
  WorkspaceStore,
} from "../persistence/index.js";
import { dumpJson } from "../persistence/serialization.js";
import { PrincipalAuthService } from "./principal-auth.js";
import { assertNoSensitiveMaterial } from "./sensitive-material.js";
import {
  buildProtectedHeader,
  buildSigningInput,
  encodeSegment,
  mediaTypeForClass,
  payloadBytesForBody,
  type SignedEnvelopeParts,
  type SignedObjectClass,
  verifyObject,
} from "./signing.js";
import type { SigningBroker } from "./signing-broker.js";

/**
 * Authority mutations are events first. In this architecture the audit record
 * is the authorising act: attesting a key and revoking a key each run through
 * this service, where the state change and its event land in ONE transaction
 * through the normal event path — never direct store writes from a boundary.
 * Credential rotation commits its revocation and its event in one transaction
 * too, but only AFTER the new token is durably persisted (see
 * rotatePrincipalCredential). An authority change that never entered the
 * event chain is invisible to the world model and to verify-chain.
 *
 * Every signed mutation is substantiated before it is recorded: the
 * attester/revoker principal and key are resolved from STORED rows (never
 * from caller-supplied claims of kind or standing), and the produced
 * signature must verify against the enrolled public key or nothing is
 * written.
 *
 * Event detail lives inside the opaque `payload.data`; the event contract
 * itself is untouched. The plaintext token minting returns is never part of
 * the event — only its credential id is.
 */
export class AuthorityMutationError extends Error {}

export const PRINCIPAL_CREDENTIAL_MINTED_EVENT = "principal.credential_minted";
export const PRINCIPAL_KEY_ATTESTED_EVENT = "principal.key_attested";
export const PRINCIPAL_KEY_REVOKED_EVENT = "principal.key_revoked";

export type EvaluatedPredicate = { predicate: string; result: boolean; observed: string };

/**
 * Identifies the operator performing an authority mutation. Deliberately just
 * ids: the principal's kind and standing, and the key's standing and
 * ownership, are resolved from STORED rows — a caller cannot assert "human"
 * or "active" by supplying a field.
 */
export type OperatorIdentity = {
  principal_id: string;
  key_id: string;
};

/**
 * Resolves the operator principal and key from stored state, refusing unless
 * every authority-bearing property holds in the registry: the principal
 * exists in this workspace, is active, and is human (kind from the stored
 * row); the key exists in this workspace, belongs to that principal, and is
 * active. Nothing here trusts caller input beyond the two ids.
 */
function resolveStoredOperator(
  database: Database,
  workspaceId: string,
  identity: OperatorIdentity,
  operation: string,
): { principal: Principal; key: PrincipalKey } {
  const principal = new PrincipalStore(database).get(identity.principal_id);
  if (!principal || principal.workspace_id !== workspaceId) {
    throw new AuthorityMutationError(
      `${operation} refused; operator principal not found in workspace: ${identity.principal_id}`,
    );
  }
  if (principal.status !== "active") {
    throw new AuthorityMutationError(
      `${operation} refused; operator principal is not active: ${identity.principal_id}`,
    );
  }
  if (principal.kind !== "human") {
    throw new AuthorityMutationError(
      `${operation} refused; operator principal is not human (stored kind: ${principal.kind})`,
    );
  }
  const key = new PrincipalKeyStore(database).get(identity.key_id);
  if (!key || key.workspace_id !== workspaceId || key.principal_id !== principal.id) {
    throw new AuthorityMutationError(
      `${operation} refused; key ${identity.key_id} is not an enrolled key of principal ${identity.principal_id} in this workspace`,
    );
  }
  if (key.status !== "active") {
    throw new AuthorityMutationError(
      `${operation} refused; operator key is not active: ${identity.key_id}`,
    );
  }
  return { principal, key };
}

/**
 * Substantiates a produced envelope through the ONE registry-backed verifier
 * (verifyObject): the signature must verify against the operator key ENROLLED
 * IN THE REGISTRY, with the class, workspace, object, and signer bindings all
 * derived from stored rows. Without this, an embedding caller could sign with
 * any broker it holds and attribute the mutation to an enrolled operator key.
 * This is also verifyObject's production caller — the verifier the negative
 * vectors pin is the verifier the authority path actually runs.
 */
function producedEnvelopeVerifies(input: {
  database: Database;
  workspaceId: string;
  objectClass: SignedObjectClass;
  objectId: string;
  envelope: SignedEnvelopeParts;
  now: string;
}): void {
  const verdict = verifyObject({
    database: input.database,
    workspaceId: input.workspaceId,
    expectedClass: input.objectClass,
    expectedObjectId: input.objectId,
    envelope: input.envelope,
    now: input.now,
  });
  if (!verdict.ok) {
    throw new AuthorityMutationError(
      `${input.objectClass} refused; the produced signature failed registry-backed verification (${verdict.reason}) — signing custody does not hold the claimed enrolled key`,
    );
  }
}

/**
 * Signs a body with the operator key behind custody. The broker contract is
 * bytes-in/signature-out: key material never reaches this service.
 */
async function signWithOperatorKey(input: {
  broker: SigningBroker;
  handle: string;
  objectClass: SignedObjectClass;
  keyId: string;
  body: Record<string, unknown>;
}): Promise<{ envelope: SignedEnvelopeParts }> {
  const headerSegment = encodeSegment(
    Buffer.from(dumpJson(buildProtectedHeader(input.objectClass, input.keyId)), "utf8"),
  );
  const payloadSegment = encodeSegment(payloadBytesForBody(input.body));
  const signingInput = buildSigningInput(headerSegment, payloadSegment);
  const signature = await input.broker.sign(input.handle, Buffer.from(signingInput, "utf8"));
  if (!signature) {
    throw new AuthorityMutationError("signing custody returned no signature for the operator key");
  }
  return {
    envelope: {
      protectedHeaderSegment: headerSegment,
      payloadSegment,
      signatureSegment: encodeSegment(signature),
    },
  };
}

/**
 * Rotation, not accumulation: mints a fresh credential for the principal and
 * revokes every prior active credential. The ORDERING is the security
 * property: the old credential is never revoked until the new plaintext token
 * is durably persisted, so a failed token write can never strand the operator
 * with no usable credential.
 *
 *   1. the new credential (hash only) commits — both old and new are active;
 *   2. persistToken hands the plaintext to the caller's custody (the 0600
 *      profile file). If it throws, the old credential is untouched and the
 *      caller's custody still holds the old token; the unrevoked mint is
 *      revoked by the next successful rotation;
 *   3. one transaction revokes every prior active credential and appends the
 *      mint event naming the minted id and the revoked ids — the authority
 *      change and its audit record land atomically, after custody is durable.
 */
export function rotatePrincipalCredential(input: {
  database: Database;
  workspaceId: string;
  principalId: string;
  persistToken: (token: string) => void;
  now?: string;
}): { credential_id: string; principal_id: string; token: string } {
  const now = input.now ?? utcNow();
  const minted = new PrincipalAuthService(input.database).mint({
    workspace_id: input.workspaceId,
    principal_id: input.principalId,
  });
  input.persistToken(minted.token);
  input.database.transaction(() => {
    const credentials = new PrincipalCredentialStore(input.database);
    const revokedIds: string[] = [];
    for (const credential of credentials.listForPrincipal(input.workspaceId, input.principalId)) {
      if (credential.status === "active" && credential.id !== minted.credential_id) {
        credentials.revoke(credential.id);
        revokedIds.push(credential.id);
      }
    }
    new EventStore(input.database).append({
      workspace_id: input.workspaceId,
      kind: PRINCIPAL_CREDENTIAL_MINTED_EVENT,
      actor: input.principalId,
      payload: {
        data: {
          credential_id: minted.credential_id,
          principal_id: input.principalId,
          revoked_credential_ids: revokedIds,
          minted_at: now,
        },
        refs: [input.principalId],
        actor_ref: null,
        produced_refs: [],
        consumed_refs: [],
        causal_parent_id: null,
      },
      timestamp: now,
    });
  });
  return {
    credential_id: minted.credential_id,
    principal_id: input.principalId,
    token: minted.token,
  };
}

/**
 * The enrolment predicates, EVALUATED at attestation time and stored with
 * their observed values — conditions are never decoration. Any false result
 * refuses the attestation.
 */
export function evaluateAttestationPredicates(input: {
  database: Database;
  workspaceId: string;
  attester: OperatorIdentity;
  subjectKeyId: string;
}): EvaluatedPredicate[] {
  const workspace = new WorkspaceStore(input.database).get(input.workspaceId);
  const principals = new PrincipalStore(input.database);
  const keys = new PrincipalKeyStore(input.database);
  const subject = keys.get(input.subjectKeyId);
  const attesterPrincipal = principals.get(input.attester.principal_id);
  const attesterKey = keys.get(input.attester.key_id);
  // Every conjunct is read from stored rows: the caller supplies only ids and
  // can assert nothing about kind, standing, or ownership.
  const attesterActiveOperator =
    attesterPrincipal !== null &&
    attesterPrincipal.workspace_id === input.workspaceId &&
    attesterPrincipal.status === "active" &&
    attesterPrincipal.kind === "human" &&
    attesterKey !== null &&
    attesterKey.workspace_id === input.workspaceId &&
    attesterKey.status === "active" &&
    attesterKey.principal_id === attesterPrincipal.id;
  const fingerprintCollision =
    subject === null ? null : keys.getActiveByPublicKey(subject.public_key);
  return [
    {
      predicate: "workspace_exists",
      result: workspace !== null,
      observed: workspace ? input.workspaceId : "absent",
    },
    {
      predicate: "subject_exists",
      result: subject !== null && subject.workspace_id === input.workspaceId,
      observed: subject ? input.subjectKeyId : "absent",
    },
    {
      predicate: "attestor_is_active_operator",
      result: attesterActiveOperator,
      observed: attesterKey
        ? `${attesterPrincipal?.kind ?? "no_principal"}/${attesterKey.status}`
        : "no_key",
    },
    {
      predicate: "public_key_is_ed25519",
      result: subject?.algorithm === "ed25519",
      observed: subject?.algorithm ?? "absent",
    },
    {
      predicate: "fingerprint_is_unique",
      result: fingerprintCollision === null || fingerprintCollision.id === input.subjectKeyId,
      observed: fingerprintCollision ? fingerprintCollision.id : "absent",
    },
  ];
}

/**
 * The operator key attests another enrolled key: predicates are EVALUATED and
 * stored, the attestation is signed through custody, and the attestation row
 * plus its event commit in one transaction.
 */
export async function attestPrincipalKey(input: {
  database: Database;
  workspaceId: string;
  attester: OperatorIdentity;
  subjectKeyId: string;
  broker: SigningBroker;
  handle: string;
  now?: string;
}) {
  const now = input.now ?? utcNow();
  const predicates = evaluateAttestationPredicates({
    database: input.database,
    workspaceId: input.workspaceId,
    attester: input.attester,
    subjectKeyId: input.subjectKeyId,
  });
  const failed = predicates.filter((predicate) => !predicate.result);
  if (failed.length > 0) {
    throw new AuthorityMutationError(
      `attestation refused; predicates failed: ${failed.map((predicate) => predicate.predicate).join(", ")}`,
    );
  }
  // The attester of record is the stored operator: principal and key resolved
  // from the registry, not from any claim in the input.
  const operator = resolveStoredOperator(
    input.database,
    input.workspaceId,
    input.attester,
    "attestation",
  );
  const signed = await signWithOperatorKey({
    broker: input.broker,
    handle: input.handle,
    objectClass: "principal_enrolment",
    keyId: operator.key.id,
    body: {
      workspace_id: input.workspaceId,
      object_id: input.subjectKeyId,
      signer: operator.principal.id,
      attester_key_id: operator.key.id,
      attested_at: now,
      predicates,
    },
  });
  // Substantiate before recording: the envelope just produced must verify
  // through the registry-backed verifier. A broker that does not hold the key
  // it claims produces a signature that fails here, and nothing is written.
  producedEnvelopeVerifies({
    database: input.database,
    workspaceId: input.workspaceId,
    objectClass: "principal_enrolment",
    objectId: input.subjectKeyId,
    envelope: signed.envelope,
    now,
  });
  return input.database.transaction(() => {
    // Authorization is atomic with the mutation: standing is re-read INSIDE
    // the writing transaction, so a principal disabled or a key revoked
    // between the verification read and BEGIN makes the write fail and roll
    // back — an authority record can never be ordered after the withdrawal of
    // that authority.
    resolveStoredOperator(input.database, input.workspaceId, input.attester, "attestation");
    const attestation = new PrincipalKeyAttestationStore(input.database).record({
      id: newId("prinatt"),
      workspace_id: input.workspaceId,
      subject_key_id: input.subjectKeyId,
      attester_key_id: operator.key.id,
      conditions_json: dumpJson(predicates),
      signature: signed.envelope.signatureSegment,
      domain_tag: mediaTypeForClass("principal_enrolment"),
      attested_at: now,
    });
    const eventData = {
      attestation_id: attestation.id,
      subject_key_id: input.subjectKeyId,
      attester_key_id: operator.key.id,
      attested_at: now,
    };
    assertNoSensitiveMaterial(eventData, "principal.key_attested");
    new EventStore(input.database).append({
      workspace_id: input.workspaceId,
      kind: PRINCIPAL_KEY_ATTESTED_EVENT,
      actor: operator.principal.id,
      payload: {
        data: eventData,
        refs: [input.subjectKeyId, operator.key.id],
        actor_ref: null,
        produced_refs: [],
        consumed_refs: [],
        causal_parent_id: null,
      },
      timestamp: now,
    });
    return attestation;
  });
}

/**
 * Signed revocation: the revocation store flips the key's standing in the
 * same transaction as the audit-row insert, and this service appends the
 * revocation event inside that same transaction — audit row, standing, and
 * event can never disagree.
 *
 * The revoker of record is resolved from STORED state before anything is
 * written — active human principal, active enrolled key owned by that
 * principal in this workspace — and the produced signature must verify
 * against that enrolled key. A caller holding any other broker cannot
 * attribute a revocation to an operator key it does not hold.
 */
export async function revokePrincipalKey(input: {
  database: Database;
  workspaceId: string;
  revoker: OperatorIdentity;
  keyId: string;
  reasonCode: string;
  broker: SigningBroker;
  handle: string;
  now?: string;
}) {
  const now = input.now ?? utcNow();
  const operator = resolveStoredOperator(
    input.database,
    input.workspaceId,
    input.revoker,
    "revocation",
  );
  const subject = new PrincipalKeyStore(input.database).get(input.keyId);
  if (!subject || subject.workspace_id !== input.workspaceId) {
    throw new AuthorityMutationError(
      `revocation refused; subject key not found in workspace: ${input.keyId}`,
    );
  }
  const signed = await signWithOperatorKey({
    broker: input.broker,
    handle: input.handle,
    objectClass: "revocation",
    keyId: operator.key.id,
    body: {
      workspace_id: input.workspaceId,
      object_id: input.keyId,
      signer: operator.principal.id,
      reason_code: input.reasonCode,
      revoked_at: now,
    },
  });
  producedEnvelopeVerifies({
    database: input.database,
    workspaceId: input.workspaceId,
    objectClass: "revocation",
    objectId: input.keyId,
    envelope: signed.envelope,
    now,
  });
  return input.database.transaction(() => {
    // Same atomicity rule as attestation: the revoker's standing is re-read
    // inside the writing transaction, so a withdrawal that lands after the
    // verification read rolls this write back instead of being recorded.
    resolveStoredOperator(input.database, input.workspaceId, input.revoker, "revocation");
    const revocation = new PrincipalKeyRevocationStore(input.database).record({
      id: newId("prinrev"),
      workspace_id: input.workspaceId,
      key_id: input.keyId,
      reason_code: input.reasonCode,
      revoked_at: now,
      revoked_by_key_id: operator.key.id,
      signature: signed.envelope.signatureSegment,
    });
    const eventData = {
      revocation_id: revocation.id,
      key_id: input.keyId,
      reason_code: input.reasonCode,
      revoked_by_key_id: operator.key.id,
      revoked_at: now,
    };
    assertNoSensitiveMaterial(eventData, "principal.key_revoked");
    new EventStore(input.database).append({
      workspace_id: input.workspaceId,
      kind: PRINCIPAL_KEY_REVOKED_EVENT,
      actor: operator.principal.id,
      payload: {
        data: eventData,
        refs: [input.keyId, operator.key.id],
        actor_ref: null,
        produced_refs: [],
        consumed_refs: [],
        causal_parent_id: null,
      },
      timestamp: now,
    });
    return revocation;
  });
}
