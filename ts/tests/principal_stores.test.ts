import { createPublicKey, verify as cryptoVerify, generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WorkspaceSchema } from "../src/contracts/index.js";
import {
  Database,
  GovernanceSignatureConflictError,
  GovernanceSignatureStore,
  hashPrincipalToken,
  InvalidPrincipalPublicKeyError,
  InvalidPrincipalStatusError,
  InvalidPrincipalTokenHashError,
  PrincipalCredentialStore,
  PrincipalKeyAttestationStore,
  PrincipalKeyRevocationStore,
  PrincipalKeyStore,
  PrincipalStore,
  WorkspaceStore,
} from "../src/persistence/index.js";
import { dumpJson } from "../src/persistence/serialization.js";
import {
  buildProtectedHeader,
  encodeSegment,
  payloadBytesForBody,
  verifyObject,
} from "../src/security/signing.js";

const fixturePath = new URL("../../tests/fixtures/canonical_v0.json", import.meta.url);

let database: Database;
let workspaceId: string;

const NOW = "2026-07-26T12:00:00Z";
const DOMAIN_TAG = "application/vnd.openmao.governance-decision.v1+json";
const ENROLMENT_TAG = "application/vnd.openmao.principal-enrolment.v1+json";

/** Deterministic canonical ids: prefix_label, 32 lowercase hex chars (canonical id shape). */
let sequence = 0;
function id(prefix: string, tag: string): string {
  sequence += 1;
  let hex = "";
  for (const ch of `${tag}:${sequence}`) {
    hex += ch.charCodeAt(0).toString(16).padStart(2, "0");
  }
  return `${prefix}_${(hex + "0".repeat(32)).slice(0, 32)}`;
}

/** Raw 32-byte Ed25519 public key as base64url — the OKP `x` representation the store persists. */
function freshPublicKey(): string {
  const { publicKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" });
  if (typeof jwk.x !== "string") {
    throw new Error("node:crypto did not return an OKP x coordinate");
  }
  return jwk.x;
}

beforeEach(async () => {
  database = new Database(":memory:");
  database.initialize();
  const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as Record<string, unknown>;
  const workspace = new WorkspaceStore(database).save(WorkspaceSchema.parse(fixture.workspace));
  workspaceId = workspace.id;
});

afterEach(() => {
  database.close();
});

function seedWorkspace(tag: string): string {
  const parsed = WorkspaceSchema.parse({
    id: id("ws", tag),
    name: `ws-${tag}`,
    created_at: NOW,
  });
  return new WorkspaceStore(database).save(parsed).id;
}

function seedPrincipal(overrides: Record<string, unknown> = {}) {
  return new PrincipalStore(database).create({
    id: id("principal", "p"),
    workspace_id: workspaceId,
    kind: "human",
    display_name: `principal-${sequence}`,
    created_at: NOW,
    ...overrides,
  } as Parameters<PrincipalStore["create"]>[0]);
}

function seedKey(overrides: Record<string, unknown> = {}) {
  // A key's (workspace_id, principal_id) must satisfy the composite FK into
  // principals(workspace_id, id). When a caller moves the key to another workspace without
  // naming a principal, seed the auto-principal in that SAME workspace so the fixture is a
  // legitimate cross-workspace row — not an FK violation that fails inside the seeder.
  const keyWorkspace = (overrides.workspace_id as string | undefined) ?? workspaceId;
  const principalId =
    (overrides.principal_id as string | undefined) ??
    seedPrincipal({ workspace_id: keyWorkspace }).id;
  return new PrincipalKeyStore(database).create({
    id: id("pkey", "k"),
    workspace_id: keyWorkspace,
    principal_id: principalId,
    public_key: freshPublicKey(),
    valid_from: NOW,
    created_at: NOW,
    ...overrides,
  } as Parameters<PrincipalKeyStore["create"]>[0]);
}

function seedCredential(overrides: Record<string, unknown> = {}) {
  const principalId = (overrides.principal_id as string | undefined) ?? seedPrincipal().id;
  return new PrincipalCredentialStore(database).create({
    id: id("prtcred", "c"),
    workspace_id: workspaceId,
    principal_id: principalId,
    token_hash: hashPrincipalToken(`prt_token_${id("tok", "t")}`),
    created_at: NOW,
    ...overrides,
  } as Parameters<PrincipalCredentialStore["create"]>[0]);
}

function signatureInput(overrides: Record<string, unknown> = {}) {
  const principal = seedPrincipal();
  const key = seedKey({ principal_id: principal.id });
  const keyId = key.id;
  const principalId = principal.id;
  return {
    id: id("gsig", "g"),
    workspace_id: workspaceId,
    object_type: "approval_resolution",
    object_id: id("approval", "a"),
    signer_key_id: keyId,
    signer_principal_id: principalId,
    signed_bytes: "eyJhbGciOiJFZERTQSJ9.eyJib2R5IjoxfQ",
    signature: "c2lnbmF0dXJl",
    domain_tag: DOMAIN_TAG,
    signed_at: NOW,
    ...overrides,
  };
}

describe("PrincipalStore", () => {
  it("round-trips a principal including the dev_bootstrap flag", () => {
    const created = seedPrincipal({ dev_bootstrap: true });
    expect(created.status).toBe("active");

    const store = new PrincipalStore(database);
    const fetched = store.get(created.id);
    expect(fetched).toEqual(created);
    expect(fetched?.dev_bootstrap).toBe(true);
    expect(store.listForWorkspace(workspaceId)).toEqual([created]);
    expect(store.get(id("principal", "missing"))).toBeNull();
  });

  it("enforces unique (workspace_id, display_name)", () => {
    const created = seedPrincipal();
    expect(() =>
      seedPrincipal({ id: id("principal", "dup"), display_name: created.display_name }),
    ).toThrow();
  });

  it("transitions a principal to disabled and back", () => {
    const created = seedPrincipal();
    const store = new PrincipalStore(database);
    const disabled = store.setStatus(created.id, "disabled");
    expect(disabled.status).toBe("disabled");
    expect(store.get(created.id)?.status).toBe("disabled");
    expect(store.setStatus(created.id, "active").status).toBe("active");
    expect(() => store.setStatus(id("principal", "missing"), "disabled")).toThrow();
  });

  it("rejects an unknown status in setStatus before any lookup", () => {
    const store = new PrincipalStore(database);
    expect(() => store.setStatus(id("principal", "x"), "suspended" as never)).toThrow(
      InvalidPrincipalStatusError,
    );
  });

  it("maps an unrecognized stored status to disabled, never active", () => {
    const created = seedPrincipal();
    // Simulate an out-of-band write: the CHECK constraint pins the closed status set, so the
    // only way to land an out-of-set value is to bypass the constraint for this one write.
    // ignore_check_constraints is scoped to this connection and restored immediately after.
    database.connection.pragma("ignore_check_constraints = ON");
    database.connection
      .prepare("UPDATE principals SET status = ? WHERE id = ?")
      .run("suspended", created.id);
    database.connection.pragma("ignore_check_constraints = OFF");
    // The CHECK constraint itself is intact: the stored value is genuinely out-of-set.
    const raw = database.connection
      .prepare("SELECT status FROM principals WHERE id = ?")
      .get(created.id) as { status: string };
    expect(raw.status).toBe("suspended");
    const store = new PrincipalStore(database);
    expect(store.get(created.id)?.status).toBe("disabled");
  });

  it("rejects a principal whose workspace does not exist (foreign key)", () => {
    expect(() =>
      new PrincipalStore(database).create({
        id: id("principal", "orphan"),
        workspace_id: id("ws", "nows"),
        kind: "agent",
        display_name: "orphan",
        created_at: NOW,
      }),
    ).toThrow();
  });
});

describe("PrincipalKeyStore", () => {
  it("round-trips a key with a null validity horizon", () => {
    const created = seedKey();
    expect(created.algorithm).toBe("ed25519");
    expect(created.status).toBe("active");
    expect(created.valid_until).toBeNull();

    const store = new PrincipalKeyStore(database);
    expect(store.get(created.id)).toEqual(created);
    expect(store.getActiveByPublicKey(created.public_key)).toEqual(created);
    expect(store.listForPrincipal(workspaceId, created.principal_id)).toEqual([created]);
  });

  it("enforces unique public_key across principals and workspaces", () => {
    const shared = freshPublicKey();
    seedKey({ public_key: shared });
    // Same key material under a DIFFERENT principal and DIFFERENT workspace must still collide:
    // the index is global on public_key, not scoped.
    const otherWorkspace = seedWorkspace("other");
    const otherPrincipal = seedPrincipal({ workspace_id: otherWorkspace });
    expect(() =>
      seedKey({
        workspace_id: otherWorkspace,
        principal_id: otherPrincipal.id,
        public_key: shared,
      }),
    ).toThrow();
  });

  it("revoke() makes a key stop resolving as active, and is idempotent", () => {
    const created = seedKey();
    const store = new PrincipalKeyStore(database);
    expect(store.getActiveByPublicKey(created.public_key)).toEqual(created);
    const revoked = store.revoke(created.id);
    expect(revoked.status).toBe("revoked");
    expect(store.get(created.id)?.status).toBe("revoked");
    expect(store.getActiveByPublicKey(created.public_key)).toBeNull();
    expect(store.revoke(created.id).status).toBe("revoked");
    expect(() => store.revoke(id("pkey", "missing"))).toThrow();
  });

  it("rejects a public key that is not raw 32-byte base64url Ed25519", () => {
    expect(() => seedKey({ public_key: "ed25519-pubkey-aaaa" })).toThrow(
      InvalidPrincipalPublicKeyError,
    );
    expect(() => seedKey({ public_key: "" })).toThrow(InvalidPrincipalPublicKeyError);
    // 32 bytes but non-canonical padding bits set in the final character.
    const nonCanonical = `${"A".repeat(42)}B`;
    expect(() => seedKey({ public_key: nonCanonical })).toThrow(InvalidPrincipalPublicKeyError);
  });

  it("refuses a PKCS8 private key and a JWK carrying private material", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const pkcs8Pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    expect(() => seedKey({ public_key: pkcs8Pem })).toThrow(InvalidPrincipalPublicKeyError);

    const privateJwk = privateKey.export({ format: "jwk" });
    expect(() => seedKey({ public_key: JSON.stringify(privateJwk) })).toThrow(
      InvalidPrincipalPublicKeyError,
    );

    // Even a public-only JWK object is refused: the store persists the raw x, not a container.
    const publicJwk = publicKey.export({ format: "jwk" });
    expect(() => seedKey({ public_key: JSON.stringify(publicJwk) })).toThrow(
      InvalidPrincipalPublicKeyError,
    );
  });

  it("rejects a key whose principal does not exist (foreign key)", () => {
    expect(() => seedKey({ principal_id: id("principal", "noprin") })).toThrow();
  });
});

describe("Ed25519 key enrolment boundary", () => {
  // Independent re-derivation, in plain field arithmetic, of the small-order encodings the
  // store must refuse. The store's set is proven, not trusted: this suite derives the points
  // from the curve equation, checks each really has order dividing 8 (three doublings land on
  // the identity), pins the derived set to the documented values, and then asserts enrolment
  // refuses every member. Removing the store check fails this test, not just a constant diff.
  const FIELD_P = 2n ** 255n - 19n;

  function modP(a: bigint): bigint {
    const r = a % FIELD_P;
    return r >= 0n ? r : r + FIELD_P;
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

  const CURVE_D = modP(-121665n * powModP(121666n, FIELD_P - 2n));
  const SQRT_MINUS_ONE = powModP(2n, (FIELD_P - 1n) / 4n); // p % 4 == 1, so this is sqrt(-1)

  function sqrtModP(c: bigint): bigint | null {
    // p % 8 == 5: the standard two-candidate square root.
    let r = powModP(c, (FIELD_P + 3n) / 8n);
    if (modP(r * r) !== modP(c)) {
      r = modP(r * SQRT_MINUS_ONE);
    }
    return modP(r * r) === modP(c) ? r : null;
  }

  function requireRoot(c: bigint): bigint {
    const r = sqrtModP(c);
    if (r === null) {
      throw new Error("derivation error: expected a quadratic residue");
    }
    return r;
  }

  function encodePoint(y: bigint, x: bigint): string {
    const bytes = Buffer.alloc(32);
    let v = modP(y);
    for (let k = 0; k < 32; k++) {
      bytes[k] = Number(v & 0xffn);
      v >>= 8n;
    }
    bytes.writeUInt8(bytes.readUInt8(31) | (Number(x & 1n) << 7), 31);
    return bytes.toString("hex");
  }

  function decodePoint(hex: string): { x: bigint; y: bigint } {
    const bytes = Buffer.from(hex, "hex");
    const sign = BigInt(bytes.readUInt8(31) >> 7);
    bytes.writeUInt8(bytes.readUInt8(31) & 0x7f, 31);
    let y = 0n;
    for (let k = 31; k >= 0; k--) {
      y = (y << 8n) | BigInt(bytes.readUInt8(k));
    }
    const yy = modP(y * y);
    const xSquared = modP((yy - 1n) * powModP(modP(CURVE_D * yy + 1n), FIELD_P - 2n));
    const x0 = requireRoot(xSquared);
    return { x: (x0 & 1n) === sign ? x0 : modP(-x0), y };
  }

  // The complete doubling formula for twisted Edwards with a = -1 (d is a non-square, so no
  // denominator can vanish).
  function pointDouble(point: { x: bigint; y: bigint }): { x: bigint; y: bigint } {
    const x2 = modP(point.x * point.x);
    const y2 = modP(point.y * point.y);
    const dxxyy = modP(CURVE_D * modP(x2 * y2));
    return {
      x: modP(2n * modP(point.x * point.y) * powModP(modP(1n + dxxyy), FIELD_P - 2n)),
      y: modP(modP(y2 + x2) * powModP(modP(1n - dxxyy), FIELD_P - 2n)),
    };
  }

  function deriveSmallOrderEncodings(): Set<string> {
    const encodings = new Set<string>();
    encodings.add(encodePoint(1n, 0n)); // (0, 1) — identity, order 1
    encodings.add(encodePoint(FIELD_P - 1n, 0n)); // (0, -1) — order 2
    for (const x of [SQRT_MINUS_ONE, modP(-SQRT_MINUS_ONE)]) {
      encodings.add(encodePoint(0n, x)); // (±sqrt(-1), 0) — order 4
    }
    // Order 8: y(2P) = 0 in the doubling formula iff d·y⁴ + 2·y² − 1 = 0, i.e.
    // y² = (−1 ± sqrt(1+d)) / d. Exactly one branch is a quadratic residue.
    const discriminant = requireRoot(modP(1n + CURVE_D));
    for (const branch of [modP(-1n + discriminant), modP(-1n - discriminant)]) {
      const ySquared = modP(branch * powModP(CURVE_D, FIELD_P - 2n));
      const y0 = sqrtModP(ySquared);
      if (y0 === null) {
        continue;
      }
      for (const y of [y0, modP(-y0)]) {
        const x0 = requireRoot(modP(-modP(y * y))); // x² = −y² for these points
        for (const x of [x0, modP(-x0)]) {
          encodings.add(encodePoint(y, x));
        }
      }
    }
    return encodings;
  }

  it("refuses all eight small-order encodings, re-derived here from the curve equation", () => {
    const derived = deriveSmallOrderEncodings();
    // The documented cofactor-group encodings (RFC 8032 section 5.1 group structure; the same
    // set libsodium hardcodes in ge25519_has_small_order). If this assertion drifts, the
    // derivation above is wrong — the store's refusal of each member is proven separately.
    expect([...derived].sort()).toEqual([
      "0000000000000000000000000000000000000000000000000000000000000000",
      "0000000000000000000000000000000000000000000000000000000000000080",
      "0100000000000000000000000000000000000000000000000000000000000000",
      "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
      "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
      "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
      "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
      "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
    ]);
    for (const hex of derived) {
      // Genuinely small order: three doublings ([8]P) land on the identity (0, 1).
      const doubled = pointDouble(pointDouble(pointDouble(decodePoint(hex))));
      expect(doubled.x).toBe(0n);
      expect(doubled.y).toBe(1n);
      // ...and the store refuses to enrol the key.
      expect(() => seedKey({ public_key: Buffer.from(hex, "hex").toString("base64url") })).toThrow(
        InvalidPrincipalPublicKeyError,
      );
    }
  });

  it("refuses the low-order identity key, leaving the key-free forged signature no authority path", () => {
    const identityKey = "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    // The hazard is real and demonstrated, not hypothetical: node:crypto imports the identity
    // point as a public key, and the "signature" R = identity, S = 0 verifies against it for
    // ANY message with no private key. Enrolment is the gate that keeps it out of the system.
    const nodeKey = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: identityKey },
      format: "jwk",
    });
    const forgedSignature = Buffer.concat([
      Buffer.from(identityKey, "base64url"),
      Buffer.alloc(32),
    ]);
    expect(
      cryptoVerify(null, Buffer.from("any governance decision"), nodeKey, forgedSignature),
    ).toBe(true);

    // The security property: the key can never be enrolled. If the point check is removed
    // from the store, this enrolment succeeds and the test fails loudly.
    expect(() => seedKey({ public_key: identityKey })).toThrow(InvalidPrincipalPublicKeyError);
    expect(new PrincipalKeyStore(database).getActiveByPublicKey(identityKey)).toBeNull();

    // End-to-end authority path: the store holds one legitimately enrolled key; a forged
    // envelope naming the would-be identity-key id resolves to no signing key at all.
    const principal = seedPrincipal();
    const legitimate = seedKey({ principal_id: principal.id });
    const objectId = id("approval", "forge");
    const refusedKeyId = id("pkey", "forged");
    const protectedHeaderSegment = encodeSegment(
      Buffer.from(dumpJson(buildProtectedHeader("governance_decision", refusedKeyId)), "utf8"),
    );
    const payloadSegment = encodeSegment(
      payloadBytesForBody({
        workspace_id: workspaceId,
        object_id: objectId,
        signer: principal.id,
      }),
    );
    const result = verifyObject({
      expectedClass: "governance_decision",
      expectedWorkspaceId: workspaceId,
      expectedObjectId: objectId,
      envelope: {
        protectedHeaderSegment,
        payloadSegment,
        signatureSegment: encodeSegment(forgedSignature),
      },
      keys: [
        {
          keyId: legitimate.id,
          publicKeyBase64Url: legitimate.public_key,
          ownerPrincipalId: principal.id,
          enrolled: true,
          status: "active",
          validUntil: null,
          conditions: [],
        },
      ],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    expect(result).toEqual({ ok: false, reason: "unknown_key", keyId: refusedKeyId });
  });

  it("rejects non-canonical y coordinates and y values with no corresponding curve point", () => {
    const keyFromHex = (hex: string) => Buffer.from(hex, "hex").toString("base64url");
    // y = p exactly — node:crypto imports these; the store must not.
    expect(() =>
      seedKey({
        public_key: keyFromHex("edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f"),
      }),
    ).toThrow(InvalidPrincipalPublicKeyError);
    // y = p with the x sign bit set.
    expect(() =>
      seedKey({
        public_key: keyFromHex(
          "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        ),
      }),
    ).toThrow(InvalidPrincipalPublicKeyError);
    // y = 2^255 − 1: the largest encodable magnitude, still non-canonical.
    expect(() =>
      seedKey({
        public_key: keyFromHex("ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"),
      }),
    ).toThrow(InvalidPrincipalPublicKeyError);
    // y = 2: a canonical magnitude with no curve point — x² = 3/(4d+1) is a non-residue
    // (proven in the derivation harness; node:crypto imports the key anyway).
    expect(() => seedKey({ public_key: "AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" })).toThrow(
      InvalidPrincipalPublicKeyError,
    );
  });

  it("accepts freshly generated Ed25519 public keys without false rejections", () => {
    for (let k = 0; k < 30; k++) {
      const publicKey = freshPublicKey();
      const created = seedKey({ public_key: publicKey });
      expect(created.public_key).toBe(publicKey);
      expect(created.status).toBe("active");
    }
  });
});

describe("PrincipalCredentialStore", () => {
  it("round-trips a credential and persists only the token hash", () => {
    const token = "prt_secretplaintexttoken";
    const store = new PrincipalCredentialStore(database);
    const created = store.create({
      id: id("prtcred", "rt"),
      workspace_id: workspaceId,
      principal_id: seedPrincipal().id,
      token_hash: hashPrincipalToken(token),
      created_at: NOW,
    });

    expect(store.getActiveByTokenHash(hashPrincipalToken(token))).toEqual(created);
    expect(store.getActiveByTokenHash(hashPrincipalToken("prt_wrong"))).toBeNull();
    expect(store.listForPrincipal(workspaceId, created.principal_id)).toEqual([created]);

    // The plaintext token must appear NOWHERE in the stored row.
    const raw = database.connection
      .prepare("SELECT * FROM principal_credentials WHERE id = ?")
      .get(created.id) as Record<string, unknown>;
    expect(Object.values(raw).join("|")).not.toContain(token);
    expect(raw.token_hash).toBe(hashPrincipalToken(token));
  });

  it("refuses a plaintext token as token_hash", () => {
    const store = new PrincipalCredentialStore(database);
    const principal = seedPrincipal();
    const plaintext = "prt_secretplaintexttoken";
    expect(() =>
      store.create({
        id: id("prtcred", "pt"),
        workspace_id: workspaceId,
        principal_id: principal.id,
        token_hash: plaintext,
        created_at: NOW,
      }),
    ).toThrow(InvalidPrincipalTokenHashError);
    // And a 64-char UPPERCASE digest is not the canonical lowercase form.
    expect(() =>
      store.create({
        id: id("prtcred", "uc"),
        workspace_id: workspaceId,
        principal_id: principal.id,
        token_hash: hashPrincipalToken(plaintext).toUpperCase(),
        created_at: NOW,
      }),
    ).toThrow(InvalidPrincipalTokenHashError);
    expect(store.listForPrincipal(workspaceId, principal.id)).toEqual([]);
  });

  it("enforces unique token_hash", () => {
    const tokenHash = hashPrincipalToken("prt_one");
    seedCredential({ token_hash: tokenHash });
    expect(() => seedCredential({ token_hash: tokenHash })).toThrow();
  });

  it("refuses a non-digest token_hash at the SQL level (CHECK constraint), not just in code", () => {
    // The "plaintext is never storable" invariant holds at the column: a direct INSERT that
    // bypasses PrincipalCredentialStore cannot land anything but a 64-char lowercase hex digest.
    const principal = seedPrincipal();
    const insert = database.connection.prepare(
      `INSERT INTO principal_credentials (id, workspace_id, principal_id, token_hash, status, created_at)
       VALUES (?, ?, ?, ?, 'active', ?)`,
    );
    expect(() =>
      insert.run(id("prtcred", "sq1"), workspaceId, principal.id, "prt_plaintexttoken", NOW),
    ).toThrow(/CHECK constraint failed/);
    // A 64-char UPPERCASE digest is not the canonical lowercase form the column pins.
    expect(() =>
      insert.run(
        id("prtcred", "sq2"),
        workspaceId,
        principal.id,
        hashPrincipalToken("prt_sql_uc").toUpperCase(),
        NOW,
      ),
    ).toThrow(/CHECK constraint failed/);
    // A genuine lowercase digest persists through the same raw path.
    insert.run(id("prtcred", "sq3"), workspaceId, principal.id, hashPrincipalToken("prt_sql"), NOW);
    expect(
      new PrincipalCredentialStore(database).getActiveByTokenHash(hashPrincipalToken("prt_sql")),
    ).not.toBeNull();
  });

  it("revoke() makes a credential stop resolving, and is idempotent", () => {
    const store = new PrincipalCredentialStore(database);
    const tokenHash = hashPrincipalToken("prt_two");
    const created = seedCredential({ token_hash: tokenHash });
    expect(store.revoke(created.id).status).toBe("revoked");
    expect(store.getActiveByTokenHash(tokenHash)).toBeNull();
    expect(store.get(created.id)?.status).toBe("revoked");
    expect(store.revoke(created.id).status).toBe("revoked");
  });
});

describe("PrincipalKeyAttestationStore", () => {
  it("round-trips an attestation and revokes it", () => {
    const subject = seedKey();
    const attester = seedKey();
    const store = new PrincipalKeyAttestationStore(database);
    const created = store.record({
      id: id("patt", "att"),
      workspace_id: workspaceId,
      subject_key_id: subject.id,
      attester_key_id: attester.id,
      conditions_json: '[{"predicate":"workspace_exists","result":"pass"}]',
      signature: "c2lnbmF0dXJl",
      domain_tag: ENROLMENT_TAG,
      attested_at: NOW,
    });
    expect(created.status).toBe("active");
    expect(store.get(created.id)).toEqual(created);
    expect(store.listForSubjectKey(workspaceId, subject.id)).toEqual([created]);

    expect(store.revoke(created.id).status).toBe("revoked");
    expect(store.get(created.id)?.status).toBe("revoked");
  });

  it("rejects an attestation whose subject key does not exist", () => {
    const attester = seedKey();
    const store = new PrincipalKeyAttestationStore(database);
    expect(() =>
      store.record({
        id: id("patt", "nosub"),
        workspace_id: workspaceId,
        subject_key_id: id("pkey", "nosub"),
        attester_key_id: attester.id,
        conditions_json: "[]",
        signature: "c2ln",
        domain_tag: ENROLMENT_TAG,
        attested_at: NOW,
      }),
    ).toThrow();
  });

  it("rejects an attestation whose subject key lives in another workspace", () => {
    const attester = seedKey();
    const otherWorkspace = seedWorkspace("other");
    const crossSubject = seedKey({ workspace_id: otherWorkspace });
    const store = new PrincipalKeyAttestationStore(database);
    expect(() =>
      store.record({
        id: id("patt", "xsub"),
        workspace_id: workspaceId,
        subject_key_id: crossSubject.id,
        attester_key_id: attester.id,
        conditions_json: "[]",
        signature: "c2ln",
        domain_tag: ENROLMENT_TAG,
        attested_at: NOW,
      }),
    ).toThrow();
  });

  it("rejects an attestation whose attester key does not exist or is cross-workspace", () => {
    const subject = seedKey();
    const store = new PrincipalKeyAttestationStore(database);
    const base = {
      workspace_id: workspaceId,
      subject_key_id: subject.id,
      conditions_json: "[]",
      signature: "c2ln",
      domain_tag: ENROLMENT_TAG,
      attested_at: NOW,
    };
    expect(() =>
      store.record({ ...base, id: id("patt", "noatt"), attester_key_id: id("pkey", "noatt") }),
    ).toThrow();
    const crossAttester = seedKey({ workspace_id: seedWorkspace("other2") });
    expect(() =>
      store.record({ ...base, id: id("patt", "xatt"), attester_key_id: crossAttester.id }),
    ).toThrow();
  });
});

describe("PrincipalKeyRevocationStore", () => {
  it("recording a revocation flips the key to revoked, atomically", () => {
    const key = seedKey();
    const revoker = seedKey();
    const keys = new PrincipalKeyStore(database);
    const store = new PrincipalKeyRevocationStore(database);

    // The key must resolve ACTIVE before the revocation; the audit row must not exist yet.
    expect(keys.getActiveByPublicKey(key.public_key)).toEqual(key);
    expect(store.getForKey(key.id)).toBeNull();

    const created = store.record({
      id: id("prev", "rev"),
      workspace_id: workspaceId,
      key_id: key.id,
      reason_code: "key_compromise",
      revoked_at: NOW,
      revoked_by_key_id: revoker.id,
      signature: "c2lnbmF0dXJl",
    });

    // Both sides move together: the audit row exists AND the key no longer resolves.
    expect(store.getForKey(key.id)).toEqual(created);
    expect(keys.getActiveByPublicKey(key.public_key)).toBeNull();
    expect(keys.get(key.id)?.status).toBe("revoked");
    expect(store.listForWorkspace(workspaceId)).toEqual([created]);
  });

  it("enforces one revocation per key and rejects a missing or cross-workspace key", () => {
    const key = seedKey();
    const revoker = seedKey();
    const store = new PrincipalKeyRevocationStore(database);
    const created = store.record({
      id: id("prev", "one"),
      workspace_id: workspaceId,
      key_id: key.id,
      reason_code: "key_compromise",
      revoked_at: NOW,
      revoked_by_key_id: revoker.id,
      signature: "c2ln",
    });
    // Second revocation of the same key in the same workspace: unique (workspace_id, key_id).
    expect(() => store.record({ ...created, id: id("prev", "two") })).toThrow();

    // A revocation naming a nonexistent key: composite FK fails.
    expect(() =>
      store.record({
        ...created,
        id: id("prev", "nokey"),
        key_id: id("pkey", "nokey"),
      }),
    ).toThrow();

    // A revocation naming a key that lives in another workspace: composite FK fails.
    const crossKey = seedKey({ workspace_id: seedWorkspace("other") });
    expect(() =>
      store.record({
        ...created,
        id: id("prev", "xkey"),
        key_id: crossKey.id,
      }),
    ).toThrow();
  });

  it("rolls back the audit row when the key flip cannot complete", () => {
    // Seed the row directly to simulate an insert that passes FK but whose UPDATE finds no row
    // (unreachable through the store because the composite FK guards first; proven here by
    // disabling FK enforcement to force the partial-failure path).
    const revoker = seedKey();
    database.connection.prepare("PRAGMA foreign_keys = OFF").run();
    const store = new PrincipalKeyRevocationStore(database);
    const missingKeyId = id("pkey", "ghost");
    expect(() =>
      store.record({
        id: id("prev", "ghost"),
        workspace_id: workspaceId,
        key_id: missingKeyId,
        reason_code: "key_compromise",
        revoked_at: NOW,
        revoked_by_key_id: revoker.id,
        signature: "c2ln",
      }),
    ).toThrow();
    // The transaction rolled the audit row back: nothing was persisted.
    expect(store.getForKey(missingKeyId)).toBeNull();
    expect(store.listForWorkspace(workspaceId)).toEqual([]);
  });

  it("rejects a revocation whose revoker key does not exist, and leaves the key active", () => {
    const key = seedKey();
    const keys = new PrincipalKeyStore(database);
    const store = new PrincipalKeyRevocationStore(database);
    expect(() =>
      store.record({
        id: id("prev", "norev"),
        workspace_id: workspaceId,
        key_id: key.id,
        reason_code: "key_compromise",
        revoked_at: NOW,
        revoked_by_key_id: id("pkey", "norev"),
        signature: "c2ln",
      }),
    ).toThrow();
    // The FK failure rolled the whole transaction back: no audit row, key still active.
    expect(store.getForKey(key.id)).toBeNull();
    expect(keys.get(key.id)?.status).toBe("active");
  });

  it("rejects a revocation whose revoker key lives in another workspace", () => {
    const key = seedKey();
    const crossRevoker = seedKey({ workspace_id: seedWorkspace("other") });
    const keys = new PrincipalKeyStore(database);
    const store = new PrincipalKeyRevocationStore(database);
    expect(() =>
      store.record({
        id: id("prev", "xrev"),
        workspace_id: workspaceId,
        key_id: key.id,
        reason_code: "key_compromise",
        revoked_at: NOW,
        revoked_by_key_id: crossRevoker.id,
        signature: "c2ln",
      }),
    ).toThrow();
    expect(store.getForKey(key.id)).toBeNull();
    expect(keys.get(key.id)?.status).toBe("active");
  });
});

describe("GovernanceSignatureStore", () => {
  it("round-trips a recorded signature via forObject and listByType", () => {
    const store = new GovernanceSignatureStore(database);
    const created = store.record(signatureInput());
    expect(store.forObject(workspaceId, "approval_resolution", created.object_id)).toEqual([
      created,
    ]);
    expect(store.listByType(workspaceId, "approval_resolution")).toEqual([created]);
    expect(store.listByType(workspaceId, "ratification")).toEqual([]);
  });

  it("treats recording the SAME signature twice as a no-op, not an error", () => {
    const store = new GovernanceSignatureStore(database);
    const input = signatureInput();
    const first = store.record({ ...input });
    const replayed = store.record({ ...input, id: id("gsig", "replay") });
    expect(replayed).toEqual(first);
    expect(store.forObject(workspaceId, "approval_resolution", input.object_id)).toHaveLength(1);
  });

  it("enforces the database unique index even when the store read path is bypassed", () => {
    const store = new GovernanceSignatureStore(database);
    const input = signatureInput();
    store.record({ ...input });
    // Bypass the store's ON CONFLICT read path entirely and hit the index directly.
    expect(() =>
      database.connection
        .prepare(
          `INSERT INTO governance_signatures
             (id, workspace_id, object_type, object_id, signer_key_id, signer_principal_id,
              signed_bytes, signature, domain_tag, signed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id("gsig", "bypass"),
          input.workspace_id,
          input.object_type,
          input.object_id,
          input.signer_key_id,
          input.signer_principal_id,
          "ZGlmZmVyZW50Ynl0ZXM",
          "ZGlmZmVyZW50c2ln",
          input.domain_tag,
          NOW,
        ),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it("rejects a CONFLICTING record for the same (workspace, object_type, object_id, signer_key)", () => {
    const store = new GovernanceSignatureStore(database);
    const input = signatureInput();
    store.record({ ...input });
    expect(() =>
      store.record({ ...input, id: id("gsig", "conf"), signature: "b3RoZXJzaWduYXR1cmU" }),
    ).toThrow(GovernanceSignatureConflictError);
  });

  it("rejects a same-tuple replay that differs only in signer_principal_id", () => {
    const store = new GovernanceSignatureStore(database);
    const input = signatureInput();
    const first = store.record({ ...input });
    // Same tuple, same bytes, same signature — but attributed to a DIFFERENT (real, same
    // workspace) principal. The FK passes; the row must still conflict, not replay silently.
    const otherPrincipal = seedPrincipal();
    expect(() =>
      store.record({ ...input, id: id("gsig", "xprin2"), signer_principal_id: otherPrincipal.id }),
    ).toThrow(GovernanceSignatureConflictError);
    expect(store.forObject(workspaceId, input.object_type, input.object_id)).toEqual([first]);
  });

  it("rejects a same-tuple replay that differs only in domain_tag", () => {
    const store = new GovernanceSignatureStore(database);
    const input = signatureInput();
    const first = store.record({ ...input });
    expect(() =>
      store.record({
        ...input,
        id: id("gsig", "xtag"),
        domain_tag: "application/vnd.openmao.revocation.v1+json",
      }),
    ).toThrow(GovernanceSignatureConflictError);
    expect(store.forObject(workspaceId, input.object_type, input.object_id)).toEqual([first]);
  });

  it("rejects a same-tuple replay that differs only in signed_at", () => {
    const store = new GovernanceSignatureStore(database);
    const input = signatureInput();
    const first = store.record({ ...input });
    expect(() =>
      store.record({ ...input, id: id("gsig", "xtime"), signed_at: "2026-07-26T13:00:00Z" }),
    ).toThrow(GovernanceSignatureConflictError);
    expect(store.forObject(workspaceId, input.object_type, input.object_id)).toEqual([first]);
  });

  it("lets a SECOND signer sign the same object (the quorum shape), still once per key", () => {
    const store = new GovernanceSignatureStore(database);
    const input = signatureInput();
    store.record({ ...input });
    const second = signatureInput({
      object_id: input.object_id,
      signature: "c2Vjb25kc2lnbmF0dXJl",
    });
    store.record(second);
    expect(store.forObject(workspaceId, "approval_resolution", input.object_id)).toHaveLength(2);
  });

  it("rejects a signature whose signer key does not exist in the workspace", () => {
    const store = new GovernanceSignatureStore(database);
    const input = signatureInput();
    // A valid principal, but a key id that was never enrolled.
    expect(() =>
      store.record({ ...input, id: id("gsig", "nokey"), signer_key_id: id("pkey", "nokey") }),
    ).toThrow();
  });

  it("rejects a signature whose signer principal lives in another workspace", () => {
    const store = new GovernanceSignatureStore(database);
    const crossPrincipal = seedPrincipal({ workspace_id: seedWorkspace("other") });
    const input = signatureInput();
    expect(() =>
      store.record({ ...input, id: id("gsig", "xprin"), signer_principal_id: crossPrincipal.id }),
    ).toThrow();
  });

  it("rejects a signature whose workspace does not exist (foreign key)", () => {
    const store = new GovernanceSignatureStore(database);
    expect(() => store.record(signatureInput({ workspace_id: id("ws", "nows") }))).toThrow();
  });
});
