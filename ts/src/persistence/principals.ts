import { createHash, createPublicKey } from "node:crypto";

import type { Database } from "./database.js";

/**
 * Signed-authority identity storage (ADR-0007 execution). These stores mirror
 * worker-credentials.ts: explicit columns, hash-only credential persistence, and a working
 * revoke() everywhere a `revoked` status is modelled.
 *
 * Boundary validation, fail-closed: a credential store only accepts a SHA-256 digest (64
 * lowercase hex chars), and a key store only accepts a canonical Ed25519 public key as the
 * raw 32-byte X coordinate, base64url-encoded with no padding — the RFC 8037 OKP `x`
 * representation that signing.ts already consumes. The DB also pins the closed status/kind
 * sets with CHECK constraints, and every status reader maps an unrecognized value to the
 * least-privilege state, never to active.
 */

/** A persisted credential token must already be a SHA-256 digest; plaintext is never storable. */
export class InvalidPrincipalTokenHashError extends Error {}

/** A persisted public key must be a well-formed Ed25519 public key, and never private material. */
export class InvalidPrincipalPublicKeyError extends Error {}

/** Principal standing is a closed set; an unrecognized value can never widen access. */
export class InvalidPrincipalStatusError extends Error {}

const TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/;

function validatePrincipalTokenHash(tokenHash: string): void {
  if (!TOKEN_HASH_PATTERN.test(tokenHash)) {
    throw new InvalidPrincipalTokenHashError(
      "principal credential token_hash must be a 64-character lowercase hex SHA-256 digest",
    );
  }
}

const BASE64URL_ALPHABET = /^[A-Za-z0-9_-]*$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Canonical base64url of exactly 32 bytes: 43 characters, URL alphabet, no padding, and no
 * non-zero unused pad bits in the final character. `Buffer.from(…, "base64url")` is lenient
 * — encodings that differ only in unused bits decode identically — so a value is accepted
 * only if re-encoding the decoded bytes reproduces it exactly (mirrors signing.ts).
 */
function isCanonicalBase64Url32(value: string): boolean {
  return (
    value.length === 43 &&
    BASE64URL_ALPHABET.test(value) &&
    Buffer.from(value, "base64url").toString("base64url") === value
  );
}

/**
 * node:crypto's OKP import accepts ANY 32 bytes as an Ed25519 public key — including the
 * identity point and the other small-order encodings, non-canonical y >= p, and y values with
 * no corresponding curve point. Against the identity key, the "signature" (R = identity,
 * S = 0) verifies for ANY message with no private key at all, so an enrolled low-order key is
 * a universal forgery of every governance signature class. The point is therefore validated
 * here, in plain field arithmetic (no dependencies), before anything is persisted.
 */
const ED25519_FIELD_P = 2n ** 255n - 19n;

function modP(a: bigint): bigint {
  const r = a % ED25519_FIELD_P;
  return r >= 0n ? r : r + ED25519_FIELD_P;
}

function powModP(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  let x = modP(base);
  let n = exponent;
  while (n > 0n) {
    if (n & 1n) {
      result = modP(result * x);
    }
    x = modP(x * x);
    n >>= 1n;
  }
  return result;
}

// The curve constant d = -121665/121666 mod p (RFC 8032 section 5.1).
const ED25519_CURVE_D = modP(-121665n * powModP(121666n, ED25519_FIELD_P - 2n));

/**
 * The eight canonical encodings of edwards25519 points of order dividing 8 (the cofactor
 * group). Derived from the curve equation, not invented: y in {0, ±1} plus the four y values
 * solving d·y⁴ + 2·y² − 1 = 0 — the y(2P) = 0 doubling-formula condition for order-8 points —
 * each encoded with the sign bit of its recovered x. The test suite re-derives this exact set
 * independently and asserts every member is refused; the same set appears in libsodium's
 * ge25519_has_small_order blacklist. Hex, lowercase, of the raw 32-byte encoding.
 */
const ED25519_SMALL_ORDER_ENCODINGS: ReadonlySet<string> = new Set([
  "0000000000000000000000000000000000000000000000000000000000000000", // y = 0, sign 0 — order 4
  "0000000000000000000000000000000000000000000000000000000000000080", // y = 0, sign 1 — order 4
  "0100000000000000000000000000000000000000000000000000000000000000", // (0, 1) — identity, order 1
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05", // order 8
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85", // order 8
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a", // order 8
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa", // order 8
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f", // (0, -1) — order 2
]);

/**
 * Refuses encodings that node:crypto would happily import but that must never confer
 * authority: small-order points (forgery against them is key-free), non-canonical y >= p
 * (a second textual form of a small y, breaking uniqueness of the stored key), and y values
 * for which x² = (y² − 1)/(d·y² + 1) is not a quadratic residue — no curve point exists.
 */
function assertUsableEd25519Point(publicKey: string): void {
  const raw = Buffer.from(publicKey, "base64url");
  if (ED25519_SMALL_ORDER_ENCODINGS.has(raw.toString("hex"))) {
    throw new InvalidPrincipalPublicKeyError(
      "principal public_key is a small-order Ed25519 point; signatures against it are forgeable without any private key",
    );
  }
  const yBytes = Buffer.from(raw);
  yBytes.writeUInt8(yBytes.readUInt8(31) & 0x7f, 31); // the top bit is the x sign bit, not part of y
  let y = 0n;
  for (let k = 31; k >= 0; k--) {
    y = (y << 8n) | BigInt(yBytes.readUInt8(k));
  }
  if (y >= ED25519_FIELD_P) {
    throw new InvalidPrincipalPublicKeyError(
      "principal public_key has a non-canonical y coordinate (y >= 2^255 - 19)",
    );
  }
  const yy = modP(y * y);
  const denominator = modP(ED25519_CURVE_D * yy + 1n);
  // The denominator never vanishes for canonical y (-1/d is a non-residue), but there is no
  // inverse of zero to recover a point from, so refuse rather than divide anyway.
  const xSquared =
    denominator === 0n ? null : modP((yy - 1n) * powModP(denominator, ED25519_FIELD_P - 2n));
  const onCurve =
    xSquared !== null && (xSquared === 0n || powModP(xSquared, (ED25519_FIELD_P - 1n) / 2n) === 1n);
  if (!onCurve) {
    throw new InvalidPrincipalPublicKeyError(
      "principal public_key does not encode a point on the edwards25519 curve",
    );
  }
}

/**
 * A stored public_key is the raw 32-byte Ed25519 X coordinate as canonical base64url — the
 * RFC 8037 OKP `x` representation. A bare JWK object is refused outright: any JSON object
 * carrying a private `d` member is private material, and accepting JWK containers at all
 * would split the storage representation between raw `x` and wrapped `x`. A PKCS8 PEM (or
 * any other encoding) fails the shape check. Anything that passes the shape check must encode
 * a real, full-order curve point AND survive a node:crypto OKP import, so a
 * malformed-but-well-shaped string cannot persist.
 */
function validateEd25519PublicKey(publicKey: string): void {
  const trimmed = publicKey.trim();
  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new InvalidPrincipalPublicKeyError(
        "principal public_key is not a raw base64url Ed25519 key",
      );
    }
    if (isPlainObject(parsed) && "d" in parsed) {
      throw new InvalidPrincipalPublicKeyError(
        "principal public_key must not contain private key material",
      );
    }
    throw new InvalidPrincipalPublicKeyError(
      "principal public_key must be the raw base64url Ed25519 key, not a JWK",
    );
  }
  if (!isCanonicalBase64Url32(publicKey)) {
    throw new InvalidPrincipalPublicKeyError(
      "principal public_key must be a raw 32-byte Ed25519 key as canonical base64url",
    );
  }
  assertUsableEd25519Point(publicKey);
  try {
    createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKey }, format: "jwk" });
  } catch {
    throw new InvalidPrincipalPublicKeyError(
      "principal public_key does not import as an Ed25519 public key",
    );
  }
}

export type PrincipalKind = "human" | "agent" | "worker" | "system";
export type PrincipalStatus = "active" | "disabled";

export type Principal = {
  id: string;
  workspace_id: string;
  kind: PrincipalKind;
  display_name: string;
  status: PrincipalStatus;
  dev_bootstrap: boolean;
  created_at: string;
};

type PrincipalRow = {
  id: string;
  workspace_id: string;
  kind: string;
  display_name: string;
  status: string;
  dev_bootstrap: number;
  created_at: string;
};

export class PrincipalStore {
  constructor(private readonly database: Database) {}

  create(input: {
    id: string;
    workspace_id: string;
    kind: PrincipalKind;
    display_name: string;
    dev_bootstrap?: boolean;
    created_at: string;
  }): Principal {
    const principal: Principal = {
      ...input,
      status: "active",
      dev_bootstrap: input.dev_bootstrap ?? false,
    };
    this.kindFrom(principal.kind);
    this.database.connection
      .prepare(
        `INSERT INTO principals (id, workspace_id, kind, display_name, status, dev_bootstrap, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        principal.id,
        principal.workspace_id,
        principal.kind,
        principal.display_name,
        principal.status,
        principal.dev_bootstrap ? 1 : 0,
        principal.created_at,
      );
    return principal;
  }

  get(principalId: string): Principal | null {
    const row = this.database.connection
      .prepare(
        `SELECT id, workspace_id, kind, display_name, status, dev_bootstrap, created_at
         FROM principals WHERE id = ?`,
      )
      .get(principalId) as PrincipalRow | undefined;
    return row ? this.fromRow(row) : null;
  }

  listForWorkspace(workspaceId: string): Principal[] {
    const rows = this.database.connection
      .prepare(
        `SELECT id, workspace_id, kind, display_name, status, dev_bootstrap, created_at
         FROM principals WHERE workspace_id = ? ORDER BY created_at, id`,
      )
      .all(workspaceId) as PrincipalRow[];
    return rows.map((row) => this.fromRow(row));
  }

  setStatus(principalId: string, status: PrincipalStatus): Principal {
    if (status !== "active" && status !== "disabled") {
      throw new InvalidPrincipalStatusError(`unknown principal status: ${status as string}`);
    }
    const current = this.get(principalId);
    if (!current) {
      throw new PrincipalNotFoundError(`principal not found: ${principalId}`);
    }
    if (current.status === status) {
      return current;
    }
    this.database.connection
      .prepare("UPDATE principals SET status = ? WHERE id = ?")
      .run(status, principalId);
    return { ...current, status };
  }

  private fromRow(row: PrincipalRow): Principal {
    return {
      id: row.id,
      workspace_id: row.workspace_id,
      kind: this.kindFrom(row.kind),
      display_name: row.display_name,
      status: principalStatusFrom(row.status),
      dev_bootstrap: row.dev_bootstrap !== 0,
      created_at: row.created_at,
    };
  }

  private kindFrom(kind: string): PrincipalKind {
    if (kind === "human" || kind === "agent" || kind === "worker" || kind === "system") {
      return kind;
    }
    throw new Error(`unknown principal kind in storage: ${kind}`);
  }
}

/** Thrown when a principal row is referenced but absent. */
export class PrincipalNotFoundError extends Error {}

/**
 * Fail-closed standing: only the exact stored value "active" resolves to active. Any other
 * persisted value — including a typo like "suspended" — maps to "disabled". The CHECK
 * constraint makes an out-of-set value unreachable through this module, so a hit here means
 * the row was written out-of-band, and least privilege is the only safe reading.
 */
function principalStatusFrom(status: string): PrincipalStatus {
  return status === "active" ? "active" : "disabled";
}

export type PrincipalKeyStatus = "active" | "revoked";

export type PrincipalKey = {
  id: string;
  workspace_id: string;
  principal_id: string;
  algorithm: "ed25519";
  public_key: string;
  status: PrincipalKeyStatus;
  valid_from: string;
  valid_until: string | null;
  created_at: string;
};

type PrincipalKeyRow = {
  id: string;
  workspace_id: string;
  principal_id: string;
  algorithm: string;
  public_key: string;
  status: string;
  valid_from: string;
  valid_until: string | null;
  created_at: string;
};

export class PrincipalKeyStore {
  constructor(private readonly database: Database) {}

  create(input: {
    id: string;
    workspace_id: string;
    principal_id: string;
    public_key: string;
    valid_from: string;
    valid_until?: string | null;
    created_at: string;
  }): PrincipalKey {
    validateEd25519PublicKey(input.public_key);
    const key: PrincipalKey = {
      ...input,
      algorithm: "ed25519",
      status: "active",
      valid_until: input.valid_until ?? null,
    };
    this.database.connection
      .prepare(
        `INSERT INTO principal_keys
           (id, workspace_id, principal_id, algorithm, public_key, status, valid_from, valid_until, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        key.id,
        key.workspace_id,
        key.principal_id,
        key.algorithm,
        key.public_key,
        key.status,
        key.valid_from,
        key.valid_until,
        key.created_at,
      );
    return key;
  }

  get(keyId: string): PrincipalKey | null {
    const row = this.database.connection
      .prepare(
        `SELECT id, workspace_id, principal_id, algorithm, public_key, status, valid_from, valid_until, created_at
         FROM principal_keys WHERE id = ?`,
      )
      .get(keyId) as PrincipalKeyRow | undefined;
    return row ? this.fromRow(row) : null;
  }

  getActiveByPublicKey(publicKey: string): PrincipalKey | null {
    const row = this.database.connection
      .prepare(
        `SELECT id, workspace_id, principal_id, algorithm, public_key, status, valid_from, valid_until, created_at
         FROM principal_keys WHERE public_key = ? AND status = 'active'`,
      )
      .get(publicKey) as PrincipalKeyRow | undefined;
    return row ? this.fromRow(row) : null;
  }

  listForPrincipal(workspaceId: string, principalId: string): PrincipalKey[] {
    const rows = this.database.connection
      .prepare(
        `SELECT id, workspace_id, principal_id, algorithm, public_key, status, valid_from, valid_until, created_at
         FROM principal_keys WHERE workspace_id = ? AND principal_id = ? ORDER BY created_at, id`,
      )
      .all(workspaceId, principalId) as PrincipalKeyRow[];
    return rows.map((row) => this.fromRow(row));
  }

  /**
   * Operator-initiated standing flip. Recording a signed revocation goes through
   * PrincipalKeyRevocationStore.record(), which flips status in the same transaction as the
   * audit-row insert, so the audit record and the effective state can never disagree. This
   * method remains available because some lifecycle paths (principal disablement, enrolment
   * supersession) must be able to stand a key down before — or without — a signed revocation
   * chain existing; a status flip without a revocation record is therefore possible, but the
   * reverse is not.
   */
  revoke(keyId: string): PrincipalKey {
    const current = this.get(keyId);
    if (!current) {
      throw new Error(`principal key not found: ${keyId}`);
    }
    if (current.status === "revoked") {
      return current;
    }
    this.database.connection
      .prepare("UPDATE principal_keys SET status = 'revoked' WHERE id = ?")
      .run(keyId);
    return { ...current, status: "revoked" };
  }

  private fromRow(row: PrincipalKeyRow): PrincipalKey {
    return {
      id: row.id,
      workspace_id: row.workspace_id,
      principal_id: row.principal_id,
      algorithm: "ed25519",
      public_key: row.public_key,
      status: keyStatusFrom(row.status),
      valid_from: row.valid_from,
      valid_until: row.valid_until,
      created_at: row.created_at,
    };
  }
}

export type PrincipalCredential = {
  id: string;
  workspace_id: string;
  principal_id: string;
  token_hash: string;
  status: "active" | "revoked";
  created_at: string;
};

type PrincipalCredentialRow = {
  id: string;
  workspace_id: string;
  principal_id: string;
  token_hash: string;
  status: string;
  created_at: string;
};

/** Fail-closed key standing: only the exact value "active" resolves to active. */
function keyStatusFrom(status: string): PrincipalKeyStatus {
  return status === "active" ? "active" : "revoked";
}

/** Hash a principal token for storage/lookup. Only the hash is ever persisted. */
export function hashPrincipalToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class PrincipalCredentialStore {
  constructor(private readonly database: Database) {}

  create(input: {
    id: string;
    workspace_id: string;
    principal_id: string;
    token_hash: string;
    created_at: string;
  }): PrincipalCredential {
    validatePrincipalTokenHash(input.token_hash);
    const credential: PrincipalCredential = { ...input, status: "active" };
    this.database.connection
      .prepare(
        `INSERT INTO principal_credentials (id, workspace_id, principal_id, token_hash, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        credential.id,
        credential.workspace_id,
        credential.principal_id,
        credential.token_hash,
        credential.status,
        credential.created_at,
      );
    return credential;
  }

  get(credentialId: string): PrincipalCredential | null {
    const row = this.database.connection
      .prepare(
        `SELECT id, workspace_id, principal_id, token_hash, status, created_at
         FROM principal_credentials WHERE id = ?`,
      )
      .get(credentialId) as PrincipalCredentialRow | undefined;
    return row ? this.fromRow(row) : null;
  }

  getActiveByTokenHash(tokenHash: string): PrincipalCredential | null {
    const row = this.database.connection
      .prepare(
        `SELECT id, workspace_id, principal_id, token_hash, status, created_at
         FROM principal_credentials WHERE token_hash = ? AND status = 'active'`,
      )
      .get(tokenHash) as PrincipalCredentialRow | undefined;
    return row ? this.fromRow(row) : null;
  }

  listForPrincipal(workspaceId: string, principalId: string): PrincipalCredential[] {
    const rows = this.database.connection
      .prepare(
        `SELECT id, workspace_id, principal_id, token_hash, status, created_at
         FROM principal_credentials WHERE workspace_id = ? AND principal_id = ? ORDER BY created_at`,
      )
      .all(workspaceId, principalId) as PrincipalCredentialRow[];
    return rows.map((row) => this.fromRow(row));
  }

  revoke(credentialId: string): PrincipalCredential {
    const current = this.get(credentialId);
    if (!current) {
      throw new Error(`principal credential not found: ${credentialId}`);
    }
    if (current.status === "revoked") {
      return current;
    }
    this.database.connection
      .prepare("UPDATE principal_credentials SET status = 'revoked' WHERE id = ?")
      .run(credentialId);
    return { ...current, status: "revoked" };
  }

  private fromRow(row: PrincipalCredentialRow): PrincipalCredential {
    return {
      id: row.id,
      workspace_id: row.workspace_id,
      principal_id: row.principal_id,
      token_hash: row.token_hash,
      status: keyStatusFrom(row.status),
      created_at: row.created_at,
    };
  }
}

export type PrincipalKeyAttestation = {
  id: string;
  workspace_id: string;
  subject_key_id: string;
  attester_key_id: string;
  conditions_json: string;
  signature: string;
  domain_tag: string;
  attested_at: string;
  status: "active" | "revoked";
};

type PrincipalKeyAttestationRow = {
  id: string;
  workspace_id: string;
  subject_key_id: string;
  attester_key_id: string;
  conditions_json: string;
  signature: string;
  domain_tag: string;
  attested_at: string;
  status: string;
};

export class PrincipalKeyAttestationStore {
  constructor(private readonly database: Database) {}

  record(input: {
    id: string;
    workspace_id: string;
    subject_key_id: string;
    attester_key_id: string;
    conditions_json: string;
    signature: string;
    domain_tag: string;
    attested_at: string;
  }): PrincipalKeyAttestation {
    const attestation: PrincipalKeyAttestation = { ...input, status: "active" };
    this.database.connection
      .prepare(
        `INSERT INTO principal_key_attestations
           (id, workspace_id, subject_key_id, attester_key_id, conditions_json, signature, domain_tag, attested_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        attestation.id,
        attestation.workspace_id,
        attestation.subject_key_id,
        attestation.attester_key_id,
        attestation.conditions_json,
        attestation.signature,
        attestation.domain_tag,
        attestation.attested_at,
        attestation.status,
      );
    return attestation;
  }

  get(attestationId: string): PrincipalKeyAttestation | null {
    const row = this.database.connection
      .prepare(
        `SELECT id, workspace_id, subject_key_id, attester_key_id, conditions_json, signature, domain_tag, attested_at, status
         FROM principal_key_attestations WHERE id = ?`,
      )
      .get(attestationId) as PrincipalKeyAttestationRow | undefined;
    return row ? this.fromRow(row) : null;
  }

  listForSubjectKey(workspaceId: string, subjectKeyId: string): PrincipalKeyAttestation[] {
    const rows = this.database.connection
      .prepare(
        `SELECT id, workspace_id, subject_key_id, attester_key_id, conditions_json, signature, domain_tag, attested_at, status
         FROM principal_key_attestations WHERE workspace_id = ? AND subject_key_id = ?
         ORDER BY attested_at, id`,
      )
      .all(workspaceId, subjectKeyId) as PrincipalKeyAttestationRow[];
    return rows.map((row) => this.fromRow(row));
  }

  revoke(attestationId: string): PrincipalKeyAttestation {
    const current = this.get(attestationId);
    if (!current) {
      throw new Error(`principal key attestation not found: ${attestationId}`);
    }
    if (current.status === "revoked") {
      return current;
    }
    this.database.connection
      .prepare("UPDATE principal_key_attestations SET status = 'revoked' WHERE id = ?")
      .run(attestationId);
    return { ...current, status: "revoked" };
  }

  private fromRow(row: PrincipalKeyAttestationRow): PrincipalKeyAttestation {
    return {
      id: row.id,
      workspace_id: row.workspace_id,
      subject_key_id: row.subject_key_id,
      attester_key_id: row.attester_key_id,
      conditions_json: row.conditions_json,
      signature: row.signature,
      domain_tag: row.domain_tag,
      attested_at: row.attested_at,
      status: keyStatusFrom(row.status),
    };
  }
}

export type PrincipalKeyRevocation = {
  id: string;
  workspace_id: string;
  key_id: string;
  reason_code: string;
  revoked_at: string;
  revoked_by_key_id: string;
  signature: string;
};

type PrincipalKeyRevocationRow = PrincipalKeyRevocation;

export class PrincipalKeyRevocationStore {
  constructor(private readonly database: Database) {}

  record(input: {
    id: string;
    workspace_id: string;
    key_id: string;
    reason_code: string;
    revoked_at: string;
    revoked_by_key_id: string;
    signature: string;
  }): PrincipalKeyRevocation {
    // One atomic operation: the audit row and the key's effective standing move together.
    // A database can never hold a signed revocation whose key still resolves active.
    // FK violations, the one-revocation-per-key unique index, and "key not found" surface
    // from inside the transaction, which then rolls back in full.
    return this.database.transaction(() => {
      this.database.connection
        .prepare(
          `INSERT INTO principal_key_revocations
             (id, workspace_id, key_id, reason_code, revoked_at, revoked_by_key_id, signature)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.workspace_id,
          input.key_id,
          input.reason_code,
          input.revoked_at,
          input.revoked_by_key_id,
          input.signature,
        );
      const updated = this.database.connection
        .prepare("UPDATE principal_keys SET status = 'revoked' WHERE id = ?")
        .run(input.key_id);
      if (updated.changes === 0) {
        throw new PrincipalKeyNotFoundError(`principal key not found: ${input.key_id}`);
      }
      return { ...input };
    });
  }

  getForKey(keyId: string): PrincipalKeyRevocation | null {
    const row = this.database.connection
      .prepare(
        `SELECT id, workspace_id, key_id, reason_code, revoked_at, revoked_by_key_id, signature
         FROM principal_key_revocations WHERE key_id = ?`,
      )
      .get(keyId) as PrincipalKeyRevocationRow | undefined;
    return row ? { ...row } : null;
  }

  listForWorkspace(workspaceId: string): PrincipalKeyRevocation[] {
    const rows = this.database.connection
      .prepare(
        `SELECT id, workspace_id, key_id, reason_code, revoked_at, revoked_by_key_id, signature
         FROM principal_key_revocations WHERE workspace_id = ? ORDER BY revoked_at, id`,
      )
      .all(workspaceId) as PrincipalKeyRevocationRow[];
    return rows.map((row) => ({ ...row }));
  }
}

/** Thrown when a revocation is recorded against a key that does not exist. */
export class PrincipalKeyNotFoundError extends Error {}
