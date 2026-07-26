import {
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";

import { dumpJson } from "../persistence/serialization.js";

/**
 * Ed25519 signing for governance records, using the RFC 7515 detached-JWS
 * signing input:
 *
 *   BASE64URL(UTF8(protected_header_json)) || "." || BASE64URL(payload_bytes)
 *
 * implemented over node:crypto only — no dependencies. Separation between
 * record classes rides the standard JOSE `typ` parameter: each signed class
 * has a distinct registered-style media type, and an unrecognised `typ` is a
 * refusal, never a default. Payload bytes are the canonical `dumpJson`
 * serialization of an explicitly-enumerated body object; verification runs
 * over the exact byte string that was signed, never a re-serialization of a
 * parsed object.
 *
 * The verifier never throws on a bad signature and never returns a bare
 * boolean: every refusal is a typed reason code, evaluated fail-closed in a
 * fixed order (typ -> key lookup -> standing -> conditions -> body claims ->
 * signature shape -> cryptographic check). The algorithm is pinned to
 * Ed25519 in code; the presented header's `alg` member is never used to
 * select an algorithm. `kid` is a lookup hint only.
 *
 * No timestamps are taken here: any time inside a signed body is a parameter
 * placed there by the caller from stored state, and the validity window is
 * evaluated against an injected `now`, never the wall clock.
 */

export const SIGNED_OBJECT_MEDIA_TYPES = {
  governance_decision: "application/vnd.openmao.governance-decision.v1+json",
  principal_enrolment: "application/vnd.openmao.principal-enrolment.v1+json",
  revocation: "application/vnd.openmao.revocation.v1+json",
  chain_attestation: "application/vnd.openmao.chain-attestation.v1+json",
} as const;

export type SignedObjectClass = keyof typeof SIGNED_OBJECT_MEDIA_TYPES;

const MEDIA_TYPE_TO_CLASS: ReadonlyMap<string, SignedObjectClass> = new Map(
  Object.entries(SIGNED_OBJECT_MEDIA_TYPES).map(([objectClass, mediaType]) => [
    mediaType,
    objectClass as SignedObjectClass,
  ]),
);

export function mediaTypeForClass(objectClass: SignedObjectClass): string {
  return SIGNED_OBJECT_MEDIA_TYPES[objectClass];
}

/** Reverse lookup for the presented `typ`. Null means unrecognised: refuse. */
export function classForMediaType(mediaType: string): SignedObjectClass | null {
  return MEDIA_TYPE_TO_CLASS.get(mediaType) ?? null;
}

const ED25519_ALGORITHM = "EdDSA";
const ED25519_SIGNATURE_BYTES = 64;
// The Ed25519 group order l (RFC 8032 section 5.1). A signature whose S
// scalar is not reduced mod l is malleable (S + l also satisfies the
// verification equation under lax verifiers) and is refused on shape, before
// the cryptographic check.
const ED25519_GROUP_ORDER = 2n ** 252n + 27742317777372353535851937790883648493n;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;

export type ProtectedHeader = {
  alg: typeof ED25519_ALGORITHM;
  kid: string;
  typ: string;
};

export function buildProtectedHeader(
  objectClass: SignedObjectClass,
  keyId: string,
): ProtectedHeader {
  return { alg: ED25519_ALGORITHM, kid: keyId, typ: mediaTypeForClass(objectClass) };
}

/** Canonical payload bytes for an explicitly-enumerated body object. */
export function payloadBytesForBody(body: Record<string, unknown>): Buffer {
  return Buffer.from(dumpJson(body), "utf8");
}

export function encodeSegment(bytes: Buffer): string {
  return bytes.toString("base64url");
}

export function buildSigningInput(protectedHeaderSegment: string, payloadSegment: string): string {
  return `${protectedHeaderSegment}.${payloadSegment}`;
}

export type SignedEnvelope = {
  objectClass: SignedObjectClass;
  keyId: string;
  protectedHeaderJson: string;
  protectedHeaderSegment: string;
  payloadBytes: Buffer;
  payloadSegment: string;
  signingInput: string;
  signature: Buffer;
  signatureSegment: string;
};

/** The exact-byte pieces a verifier needs; what M2+ persists per signature. */
export type SignedEnvelopeParts = {
  protectedHeaderSegment: string;
  payloadSegment: string;
  signatureSegment: string;
};

export function signObject(input: {
  objectClass: SignedObjectClass;
  keyId: string;
  body: Record<string, unknown>;
  privateKey: KeyObject;
}): SignedEnvelope {
  const protectedHeaderJson = dumpJson(buildProtectedHeader(input.objectClass, input.keyId));
  const protectedHeaderSegment = encodeSegment(Buffer.from(protectedHeaderJson, "utf8"));
  const payloadBytes = payloadBytesForBody(input.body);
  const payloadSegment = encodeSegment(payloadBytes);
  const signingInput = buildSigningInput(protectedHeaderSegment, payloadSegment);
  const signature = cryptoSign(null, Buffer.from(signingInput, "utf8"), input.privateKey);
  return {
    objectClass: input.objectClass,
    keyId: input.keyId,
    protectedHeaderJson,
    protectedHeaderSegment,
    payloadBytes,
    payloadSegment,
    signingInput,
    signature,
    signatureSegment: encodeSegment(signature),
  };
}

/**
 * Enrolment conditions carried by a key's enrolment record. A closed set of
 * kinds is evaluated here; an unrecognised kind refuses, it is never ignored.
 * `not_after` and the key's own validity window are evaluated against the
 * caller-injected `now`, never the wall clock.
 */
export type EnrolmentCondition = { kind: string } & Record<string, unknown>;

export type VerificationKey = {
  keyId: string;
  /** Raw 32-byte Ed25519 public key, base64url (RFC 8037 OKP `x`). */
  publicKeyBase64Url: string;
  /** Stable principal this key belongs to; the body's signer must agree. */
  ownerPrincipalId: string;
  enrolled: boolean;
  status: "active" | "revoked";
  /** ISO instant after which the key confers no authority, or null. */
  validUntil: string | null;
  conditions: readonly EnrolmentCondition[];
};

export type VerifyFailureReason =
  | "malformed_envelope"
  | "unrecognized_typ"
  | "class_mismatch"
  | "unknown_key"
  | "key_not_enrolled"
  | "key_revoked"
  | "key_expired"
  | "condition_class_restricted"
  | "condition_workspace_mismatch"
  | "condition_unrecognized"
  | "workspace_mismatch"
  | "object_mismatch"
  | "signer_mismatch"
  | "malformed_signature"
  | "signature_malleable"
  | "signature_invalid"
  | "internal_error";

export type VerifySuccess = {
  ok: true;
  objectClass: SignedObjectClass;
  keyId: string;
  signerPrincipalId: string;
};

export type VerifyFailure = {
  ok: false;
  reason: VerifyFailureReason;
  keyId: string | null;
};

export type VerifyResult = VerifySuccess | VerifyFailure;

/**
 * Verifies a signed envelope against the exact signed bytes. Never throws,
 * never returns a bare boolean; every refusal is typed and fail-closed.
 */
export function verifyObject(input: {
  expectedClass: SignedObjectClass;
  expectedWorkspaceId: string;
  expectedObjectId: string;
  envelope: SignedEnvelopeParts;
  keys: readonly VerificationKey[];
  /** Injected "now" as an ISO instant; the wall clock is never read. */
  now: string;
}): VerifyResult {
  try {
    return verifyObjectInner(input);
  } catch {
    return { ok: false, reason: "internal_error", keyId: null };
  }
}

function fail(reason: VerifyFailureReason, keyId: string | null = null): VerifyFailure {
  return { ok: false, reason, keyId };
}

function verifyObjectInner(input: {
  expectedClass: SignedObjectClass;
  expectedWorkspaceId: string;
  expectedObjectId: string;
  envelope: SignedEnvelopeParts;
  keys: readonly VerificationKey[];
  now: string;
}): VerifyResult {
  const { protectedHeaderSegment, payloadSegment, signatureSegment } = input.envelope;
  if (
    protectedHeaderSegment.length === 0 ||
    payloadSegment.length === 0 ||
    !BASE64URL_PATTERN.test(protectedHeaderSegment) ||
    !BASE64URL_PATTERN.test(payloadSegment) ||
    !BASE64URL_PATTERN.test(signatureSegment)
  ) {
    return fail("malformed_envelope");
  }

  const header = parseProtectedHeader(protectedHeaderSegment);
  if (!header) {
    return fail("malformed_envelope");
  }

  const presentedClass = classForMediaType(header.typ);
  if (!presentedClass) {
    return fail("unrecognized_typ", header.kid);
  }
  if (presentedClass !== input.expectedClass) {
    return fail("class_mismatch", header.kid);
  }

  const key = input.keys.find((candidate) => candidate.keyId === header.kid);
  if (!key) {
    return fail("unknown_key", header.kid);
  }
  if (!key.enrolled) {
    return fail("key_not_enrolled", key.keyId);
  }
  if (key.status === "revoked") {
    return fail("key_revoked", key.keyId);
  }
  // ISO-8601 UTC instants order lexicographically; `now` is caller-injected.
  if (key.validUntil !== null && input.now > key.validUntil) {
    return fail("key_expired", key.keyId);
  }

  const conditionFailure = evaluateConditions(
    key,
    presentedClass,
    input.expectedWorkspaceId,
    input.now,
  );
  if (conditionFailure) {
    return conditionFailure;
  }

  const body = parseBodyClaims(payloadSegment);
  if (!body) {
    return fail("malformed_envelope", key.keyId);
  }
  if (body.workspace_id !== input.expectedWorkspaceId) {
    return fail("workspace_mismatch", key.keyId);
  }
  if (body.object_id !== input.expectedObjectId) {
    return fail("object_mismatch", key.keyId);
  }
  if (body.signer !== key.ownerPrincipalId) {
    return fail("signer_mismatch", key.keyId);
  }

  const signature = Buffer.from(signatureSegment, "base64url");
  if (signature.length !== ED25519_SIGNATURE_BYTES) {
    return fail("malformed_signature", key.keyId);
  }
  if (readLittleEndianBigInt(signature.subarray(32)) >= ED25519_GROUP_ORDER) {
    return fail("signature_malleable", key.keyId);
  }

  // The algorithm is pinned here, in code; the header's `alg` member is never
  // consulted to choose a verification algorithm. Verification runs over the
  // exact presented segments, never a re-serialization of the parsed body.
  try {
    const publicKey = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: key.publicKeyBase64Url },
      format: "jwk",
    });
    const verified = cryptoVerify(
      null,
      Buffer.from(buildSigningInput(protectedHeaderSegment, payloadSegment), "utf8"),
      publicKey,
      signature,
    );
    if (!verified) {
      return fail("signature_invalid", key.keyId);
    }
  } catch {
    return fail("signature_invalid", key.keyId);
  }

  return {
    ok: true,
    objectClass: presentedClass,
    keyId: key.keyId,
    signerPrincipalId: key.ownerPrincipalId,
  };
}

function parseProtectedHeader(segment: string): { kid: string; typ: string } | null {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const header = value as Record<string, unknown>;
  // `alg` is not read to select an algorithm (Ed25519 is pinned in code), but
  // an envelope claiming any other algorithm — or none — is not a well-formed
  // EdDSA JWS and is refused on shape.
  if (header.alg !== ED25519_ALGORITHM) {
    return null;
  }
  if (typeof header.kid !== "string" || typeof header.typ !== "string") {
    return null;
  }
  return { kid: header.kid, typ: header.typ };
}

function parseBodyClaims(
  payloadSegment: string,
): { workspace_id: unknown; object_id: unknown; signer: unknown } | null {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const body = value as Record<string, unknown>;
  return {
    workspace_id: body.workspace_id,
    object_id: body.object_id,
    signer: body.signer,
  };
}

function evaluateConditions(
  key: VerificationKey,
  presentedClass: SignedObjectClass,
  expectedWorkspaceId: string,
  now: string,
): VerifyFailure | null {
  for (const condition of key.conditions) {
    switch (condition.kind) {
      case "not_after": {
        if (typeof condition.timestamp !== "string") {
          return fail("condition_unrecognized", key.keyId);
        }
        if (now > condition.timestamp) {
          return fail("key_expired", key.keyId);
        }
        break;
      }
      case "object_classes": {
        const classes = condition.classes;
        if (!Array.isArray(classes) || classes.some((entry) => typeof entry !== "string")) {
          return fail("condition_unrecognized", key.keyId);
        }
        if (!classes.includes(presentedClass)) {
          return fail("condition_class_restricted", key.keyId);
        }
        break;
      }
      case "workspace": {
        if (condition.workspaceId !== expectedWorkspaceId) {
          return fail("condition_workspace_mismatch", key.keyId);
        }
        break;
      }
      default:
        // A condition this verifier cannot evaluate is a refusal, never an
        // ignored clause.
        return fail("condition_unrecognized", key.keyId);
    }
  }
  return null;
}

function readLittleEndianBigInt(bytes: Buffer): bigint {
  return BigInt(`0x${Buffer.from(bytes).reverse().toString("hex")}`);
}
