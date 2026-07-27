import {
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";

import type { Database } from "../persistence/index.js";
import { PrincipalKeyStore, PrincipalStore } from "../persistence/index.js";
import { dumpJson } from "../persistence/serialization.js";
import { productionSignals } from "./key-custody.js";

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
 * fixed order (typ -> key lookup -> header algorithm -> standing ->
 * conditions -> body claims -> signature shape -> cryptographic check). The
 * algorithm is pinned to Ed25519 in code on both the signing and verifying
 * paths; the presented header's `alg` member is never used to select an
 * algorithm. `kid` is a lookup hint only.
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

/**
 * Canonical base64url only: the URL alphabet, no padding, and no non-zero
 * unused pad bits. `Buffer.from(…, "base64url")` is lenient — encodings that
 * differ only in the unused bits of the final character decode to identical
 * bytes — so a segment is accepted only if re-encoding the decoded bytes
 * reproduces it exactly. Without this, one signature has several accepted
 * textual forms and the format disagrees with strict JOSE verifiers.
 */
function isCanonicalBase64Url(segment: string): boolean {
  return (
    BASE64URL_PATTERN.test(segment) &&
    Buffer.from(segment, "base64url").toString("base64url") === segment
  );
}

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

/** Thrown when a non-Ed25519 key is presented for signing. */
export class SigningKeyTypeError extends Error {}

/**
 * The algorithm is pinned to Ed25519 on both paths. `crypto.sign(null, …)`
 * derives its behaviour from whatever key it is handed — an RSA or Ed448 key
 * would produce a signature this module would then label `alg: "EdDSA"` — so
 * the key type is checked in code, never inferred.
 */
function assertEd25519PrivateKey(privateKey: KeyObject): void {
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new SigningKeyTypeError("signing key must be an Ed25519 private key");
  }
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
  assertEd25519PrivateKey(input.privateKey);
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

/**
 * The runtime brand marker. A module-private unique symbol: it is not
 * exported, so code outside this module cannot reference the property key to
 * STAMP it, and the verifier REFUSES any key that lacks it. This is what makes
 * the caller-supplied-keys path unexpressible at runtime, not merely by
 * convention — only loadVerificationKeys and the guarded test mint (both in
 * this module) can produce a key the verifier will trust.
 */
const VERIFICATION_KEY_BRAND: unique symbol = Symbol("openmao.verification_key_brand");

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
  /**
   * The honesty valve: a key created by the dev-bootstrap ceremony verifies
   * cryptographically but must never report production trust. Not optional
   * and never defaulted at verification time: the registry-backed key loader
   * (loadVerificationKeys) derives it from the stored principal row, so a
   * caller cannot choose the trust a signature reports by omitting a field.
   */
  dev_bootstrap: boolean;
  /** Runtime brand; present only on keys minted inside this module. */
  readonly [VERIFICATION_KEY_BRAND]?: true;
};

/** Stamps the brand. Module-private: only the loader and the test mint call it. */
function brandVerificationKey(
  key: Omit<VerificationKey, typeof VERIFICATION_KEY_BRAND>,
): VerificationKey {
  return { ...key, [VERIFICATION_KEY_BRAND]: true } as VerificationKey;
}

/**
 * TEST-ONLY MINT — constructs a branded VerificationKey for the white-box
 * refusal-vector suites (ts/tests/signing.test.ts, principal_stores.test.ts),
 * which must inject hand-built keys to exercise the verifier's refusal order.
 * It HARD-REFUSES under any production signal, so this path is unreachable in
 * production. Production verification (verifyObject) never touches this: it
 * loads keys from the registry and stamps them itself. If you are reaching
 * for this outside a test file, stop.
 */
export function mintVerificationKeyForTest(
  key: Omit<VerificationKey, typeof VERIFICATION_KEY_BRAND>,
): VerificationKey {
  // Fail closed: require an affirmative test-runner signal rather than merely the
  // absence of a production one. Gating on `productionSignals` alone was fail-open —
  // on any machine with NODE_ENV unset (a developer laptop, a plain `node -e`, an
  // embedding consumer) this minted freely, so a caller could supply `dev_bootstrap:
  // false` for a dev-bootstrapped key and read back `trust: "standard"`. That is the
  // caller-chosen-trust hole this brand exists to close, one level up.
  const underTestRunner = process.env.VITEST !== undefined || process.env.NODE_ENV === "test";
  if (!underTestRunner) {
    throw new Error(
      "mintVerificationKeyForTest is test-only: no test runner detected (expected VITEST or NODE_ENV=test)",
    );
  }
  const signals = productionSignals(process.env);
  if (signals.length > 0) {
    throw new Error(
      `mintVerificationKeyForTest is test-only and refuses to operate in production (${signals.join(", ")})`,
    );
  }
  return brandVerificationKey(key);
}

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

/**
 * The trust a verified signature may claim. A signature by a dev-bootstrap key
 * is cryptographically valid but reports "development_bootstrap" — the demo
 * stays one command without lying about what it proved.
 */
export type SignatureTrust = "standard" | "development_bootstrap";

export type VerifySuccess = {
  ok: true;
  objectClass: SignedObjectClass;
  keyId: string;
  signerPrincipalId: string;
  trust: SignatureTrust;
};

export type VerifyFailure = {
  ok: false;
  reason: VerifyFailureReason;
  keyId: string | null;
};

export type VerifyResult = VerifySuccess | VerifyFailure;

/**
 * The production verifier. There is deliberately NO `keys` parameter: the key
 * set is loaded from the principal registry (loadVerificationKeys) inside this
 * function, so every property a verdict reports — enrolment, standing, owner,
 * validity, and the dev_bootstrap trust label — is derived from stored rows.
 * A caller cannot supply keys, a `dev_bootstrap` flag, or a `status` at all;
 * the trust a signature reports is not expressible as caller input on this
 * path.
 *
 * Verifies a signed envelope against the exact signed bytes. Never throws,
 * never returns a bare boolean; every refusal is typed and fail-closed.
 */
export function verifyObject(input: {
  database: Database;
  workspaceId: string;
  expectedClass: SignedObjectClass;
  expectedObjectId: string;
  envelope: SignedEnvelopeParts;
  /** Injected "now" as an ISO instant; the wall clock is never read. */
  now: string;
}): VerifyResult {
  try {
    const keys = loadVerificationKeys(input.database, input.workspaceId);
    return verifyObjectInner({
      expectedClass: input.expectedClass,
      expectedWorkspaceId: input.workspaceId,
      expectedObjectId: input.expectedObjectId,
      envelope: input.envelope,
      keys,
      now: input.now,
    });
  } catch {
    return { ok: false, reason: "internal_error", keyId: null };
  }
}

/**
 * TEST-ONLY SEAM — the white-box verifier the refusal-vector suites
 * (ts/tests/signing.test.ts, ts/tests/principal_stores.test.ts) drive with
 * hand-built key sets. This is NOT a production API: every VerificationKey
 * field here is caller-supplied, including the trust label, so no production
 * module may call it — production verification is verifyObject above, which
 * takes a database and derives the key set from the registry. If you are
 * reaching for this outside a test file, stop.
 */
export function verifyObjectWithKeys(input: {
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
    !isCanonicalBase64Url(protectedHeaderSegment) ||
    !isCanonicalBase64Url(payloadSegment) ||
    !isCanonicalBase64Url(signatureSegment)
  ) {
    return fail("malformed_envelope");
  }

  const header = parseProtectedHeader(protectedHeaderSegment);
  if (!header) {
    return fail("malformed_envelope");
  }

  // The refusal order is contractual — reason codes land in audit records, so
  // they must be accurate: typ classification first, then key-id resolution,
  // then algorithm/shape, and only then the cryptographic check.
  const headerKeyId = typeof header.kid === "string" ? header.kid : null;
  if (typeof header.typ !== "string") {
    return fail("unrecognized_typ", headerKeyId);
  }
  const presentedClass = classForMediaType(header.typ);
  if (!presentedClass) {
    return fail("unrecognized_typ", headerKeyId);
  }
  if (presentedClass !== input.expectedClass) {
    return fail("class_mismatch", headerKeyId);
  }

  if (headerKeyId === null) {
    return fail("unknown_key");
  }
  const key = input.keys.find((candidate) => candidate.keyId === headerKeyId);
  if (!key) {
    return fail("unknown_key", headerKeyId);
  }
  // Fail-closed: a key that was not minted inside this module is never
  // trusted, even if a caller smuggled one in through the test seam or a cast.
  if ((key as VerificationKey)[VERIFICATION_KEY_BRAND] !== true) {
    return fail("unknown_key", headerKeyId);
  }

  // `alg` is not read to select an algorithm (Ed25519 is pinned in code), but
  // an envelope claiming any other algorithm — or none — is not a well-formed
  // EdDSA JWS and is refused on shape, once typ and key id have resolved.
  if (header.alg !== ED25519_ALGORITHM) {
    return fail("malformed_envelope", key.keyId);
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
    trust: key.dev_bootstrap ? "development_bootstrap" : "standard",
  };
}

function parseProtectedHeader(segment: string): Record<string, unknown> | null {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
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

/**
 * The registry-backed key loader: the ONLY way a verifier should obtain
 * VerificationKey values in production paths. Every field — enrolled state,
 * standing, validity window, owner, and the dev_bootstrap honesty flag — is
 * derived from stored rows, never from caller input, so the trust a verified
 * signature reports is a property of the registry and cannot be spoofed by
 * the caller presenting (or omitting) a flag. A key whose principal row is
 * missing or cross-workspace is conservatively reported not enrolled.
 */
export function loadVerificationKeys(database: Database, workspaceId: string): VerificationKey[] {
  const principals = new PrincipalStore(database);
  const keyStore = new PrincipalKeyStore(database);
  const loaded: VerificationKey[] = [];
  for (const principal of principals.listForWorkspace(workspaceId)) {
    for (const key of keyStore.listForPrincipal(workspaceId, principal.id)) {
      loaded.push(
        brandVerificationKey({
          keyId: key.id,
          publicKeyBase64Url: key.public_key,
          ownerPrincipalId: principal.id,
          enrolled: true,
          // Standing is derived from BOTH stored rows: a key row that still says
          // "active" confers no authority when its principal is disabled, so the
          // verifier sees such a key as revoked — never as active.
          status: principal.status === "active" ? key.status : "revoked",
          validUntil: key.valid_until,
          conditions: [],
          dev_bootstrap: principal.dev_bootstrap,
        }),
      );
    }
  }
  return loaded;
}
