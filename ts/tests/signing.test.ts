import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  buildSigningInput,
  classForMediaType,
  mediaTypeForClass,
  mintVerificationKeyForTest,
  SIGNED_OBJECT_MEDIA_TYPES,
  type SignedEnvelopeParts,
  type SignedObjectClass,
  SigningKeyTypeError,
  signObject,
  type VerificationKey,
  type VerifyFailureReason,
  verifyObjectWithKeys,
} from "../src/security/signing.js";

// All key material below is generated at runtime or derived from a published
// test-only seed; no live secret appears in this file (public-hygiene rule).

const PKCS8_ED25519_DER_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const ED25519_GROUP_ORDER = 2n ** 252n + 27742317777372353535851937790883648493n;

function keyPairFromSeed(seed: Buffer): { privateKey: KeyObject; publicKeyBase64Url: string } {
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_DER_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  const jwk = createPublicKey(privateKey).export({ format: "jwk" });
  if (typeof jwk.x !== "string") {
    throw new Error("test key export failed");
  }
  return { privateKey, publicKeyBase64Url: jwk.x };
}

const keyA = keyPairFromSeed(Buffer.alloc(32, 0xa1));
const keyB = keyPairFromSeed(Buffer.alloc(32, 0xb2));

const WORKSPACE = "ws_signing_test";
const OBJECT = "appr_signing_test";
const PRINCIPAL_A = "principal_operator_a";
const PRINCIPAL_B = "principal_operator_b";
const NOW = "2026-07-26T12:00:00.000Z";

function decisionBody(): Record<string, unknown> {
  return {
    workspace_id: WORKSPACE,
    object_id: OBJECT,
    signer: PRINCIPAL_A,
    decision: "approved",
    decided_at: "2026-07-26T11:59:00.000Z",
  };
}

function verificationKey(overrides: Partial<VerificationKey> = {}): VerificationKey {
  return mintVerificationKeyForTest({
    keyId: "key_a",
    publicKeyBase64Url: keyA.publicKeyBase64Url,
    ownerPrincipalId: PRINCIPAL_A,
    enrolled: true,
    status: "active",
    validUntil: null,
    conditions: [],
    dev_bootstrap: false,
    ...overrides,
  });
}

function verificationKeyB(): VerificationKey {
  return verificationKey({
    keyId: "key_b",
    publicKeyBase64Url: keyB.publicKeyBase64Url,
    ownerPrincipalId: PRINCIPAL_B,
  });
}

function signedDecision() {
  return signObject({
    objectClass: "governance_decision",
    keyId: "key_a",
    body: decisionBody(),
    privateKey: keyA.privateKey,
  });
}

function verifyWith(
  envelope: SignedEnvelopeParts,
  keys: readonly VerificationKey[],
  overrides: { expectedWorkspaceId?: string; expectedObjectId?: string; now?: string } = {},
) {
  return verifyObjectWithKeys({
    expectedClass: "governance_decision",
    expectedWorkspaceId: WORKSPACE,
    expectedObjectId: OBJECT,
    envelope,
    keys,
    now: NOW,
    ...overrides,
  });
}

/** Re-signs a header/payload pair with an arbitrary key: builds forgery inputs. */
function reSign(
  protectedHeaderSegment: string,
  payloadSegment: string,
  signingKey: KeyObject,
): SignedEnvelopeParts {
  const signature = cryptoSign(
    null,
    Buffer.from(buildSigningInput(protectedHeaderSegment, payloadSegment), "utf8"),
    signingKey,
  );
  return {
    protectedHeaderSegment,
    payloadSegment,
    signatureSegment: signature.toString("base64url"),
  };
}

function headerSegment(header: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(header), "utf8").toString("base64url");
}

/** Re-encodes a mutated payload WITHOUT re-signing: the forgery is in the bytes. */
function mutatedPayloadSegment(mutate: (body: Record<string, unknown>) => void): string {
  const envelope = signedDecision();
  const body = JSON.parse(
    Buffer.from(envelope.payloadSegment, "base64url").toString("utf8"),
  ) as Record<string, unknown>;
  mutate(body);
  return Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
}

function readLe(bytes: Buffer): bigint {
  return BigInt(`0x${Buffer.from(bytes).reverse().toString("hex")}`);
}

function writeLe(value: bigint): Buffer {
  return Buffer.from(value.toString(16).padStart(64, "0"), "hex").reverse();
}

describe("signing media-type table", () => {
  it("maps each class to a distinct versioned media type and back", () => {
    const classes = Object.keys(SIGNED_OBJECT_MEDIA_TYPES) as SignedObjectClass[];
    expect(new Set(Object.values(SIGNED_OBJECT_MEDIA_TYPES)).size).toBe(classes.length);
    for (const objectClass of classes) {
      expect(classForMediaType(mediaTypeForClass(objectClass))).toBe(objectClass);
    }
  });

  it("returns null for unrecognised or unversioned typ values", () => {
    expect(classForMediaType("application/json")).toBeNull();
    expect(classForMediaType("application/vnd.openmao.governance-decision.v2+json")).toBeNull();
  });
});

describe("signing positive cases", () => {
  it("verifies a correct signature and returns key id and signer, never a bare boolean", () => {
    const result = verifyWith(signedDecision(), [verificationKey()]);
    expect(result).not.toBe(true);
    expect(result).toEqual({
      ok: true,
      objectClass: "governance_decision",
      keyId: "key_a",
      signerPrincipalId: PRINCIPAL_A,
      trust: "standard",
    });
  });

  it("verifies for every record class in the table", () => {
    const classes = Object.keys(SIGNED_OBJECT_MEDIA_TYPES) as SignedObjectClass[];
    for (const objectClass of classes) {
      const envelope = signObject({
        objectClass,
        keyId: "key_a",
        body: decisionBody(),
        privateKey: keyA.privateKey,
      });
      const result = verifyObjectWithKeys({
        expectedClass: objectClass,
        expectedWorkspaceId: WORKSPACE,
        expectedObjectId: OBJECT,
        envelope,
        keys: [verificationKey()],
        now: NOW,
      });
      expect(result.ok).toBe(true);
    }
  });

  it("the honesty valve: a dev-bootstrap key VERIFIES but reports development_bootstrap trust", () => {
    const dev = verifyWith(signedDecision(), [verificationKey({ dev_bootstrap: true })]);
    expect(dev).toEqual({
      ok: true,
      objectClass: "governance_decision",
      keyId: "key_a",
      signerPrincipalId: PRINCIPAL_A,
      trust: "development_bootstrap",
    });
    // Absent the flag, trust is standard — the flag defaults off.
    const standard = verifyWith(signedDecision(), [verificationKey()]);
    expect(standard.ok && standard.trust).toBe("standard");
  });
});

describe("signing algorithm pinning", () => {
  it("refuses to sign with an RSA key even though crypto.sign would accept it", () => {
    // crypto.sign(null, …) derives behaviour from the key: an RSA key would
    // yield a 256-byte signature that signObject would label alg:"EdDSA".
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(privateKey.asymmetricKeyType).toBe("rsa");
    expect(() =>
      signObject({
        objectClass: "governance_decision",
        keyId: "key_a",
        body: decisionBody(),
        privateKey,
      }),
    ).toThrow(SigningKeyTypeError);
  });

  it("refuses to sign with an Ed448 key even though crypto.sign would accept it", () => {
    const { privateKey } = generateKeyPairSync("ed448");
    expect(privateKey.asymmetricKeyType).toBe("ed448");
    expect(() =>
      signObject({
        objectClass: "governance_decision",
        keyId: "key_a",
        body: decisionBody(),
        privateKey,
      }),
    ).toThrow(SigningKeyTypeError);
  });
});

describe("canonical base64url enforcement", () => {
  const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

  /**
   * Flips one unused pad bit of the final character. The decoded bytes are
   * identical (the guard assertion proves it), but the encoding is not the
   * canonical one a strict JOSE verifier would produce.
   */
  function withFlippedPadBit(segment: string): string {
    const last = segment.charAt(segment.length - 1);
    const index = BASE64URL_ALPHABET.indexOf(last);
    expect(index).toBeGreaterThanOrEqual(0);
    const flipped = segment.slice(0, -1) + BASE64URL_ALPHABET.charAt(index ^ 1);
    expect(Buffer.from(flipped, "base64url").equals(Buffer.from(segment, "base64url"))).toBe(true);
    expect(flipped).not.toBe(segment);
    return flipped;
  }

  it("refuses a signature whose unused pad bits are flipped (one signature, one text form)", () => {
    const envelope = signedDecision();
    // 64 bytes encode to 86 chars; the final char carries 2 significant bits
    // and 4 pad bits, so e.g. a trailing `g` and `h` decode identically.
    const result = verifyWith(
      {
        protectedHeaderSegment: envelope.protectedHeaderSegment,
        payloadSegment: envelope.payloadSegment,
        signatureSegment: withFlippedPadBit(envelope.signatureSegment),
      },
      [verificationKey()],
    );
    expect(result).toEqual({ ok: false, reason: "malformed_envelope", keyId: null });
  });

  it("refuses header and payload segments with flipped pad bits", () => {
    const envelope = signedDecision();
    for (const segment of ["protectedHeaderSegment", "payloadSegment"] as const) {
      const result = verifyWith({ ...envelope, [segment]: withFlippedPadBit(envelope[segment]) }, [
        verificationKey(),
      ]);
      expect(result).toEqual({ ok: false, reason: "malformed_envelope", keyId: null });
    }
  });

  it("refuses padded and non-URL-alphabet segments", () => {
    const envelope = signedDecision();
    const padded = verifyWith({ ...envelope, signatureSegment: `${envelope.signatureSegment}=` }, [
      verificationKey(),
    ]);
    expect(padded).toEqual({ ok: false, reason: "malformed_envelope", keyId: null });
    const standardAlphabet = verifyWith(
      { ...envelope, payloadSegment: `${envelope.payloadSegment.slice(0, -1)}+` },
      [verificationKey()],
    );
    expect(standardAlphabet).toEqual({ ok: false, reason: "malformed_envelope", keyId: null });
  });
});

describe("pinned positive vector", () => {
  // Ed25519 is deterministic, so a second implementation can localise any
  // disagreement against these pinned intermediates. The seed is a published
  // test-only constant, never a live key.
  const FIXTURE = {
    seedHex: "1111111111111111111111111111111111111111111111111111111111111111",
    publicKeyBase64Url: "0EqyMnQrtKs6E2i9RhXk5tAiSrcaAWuvhSCjMsl3hzc",
    protectedHeaderSegment:
      "eyJhbGciOiJFZERTQSIsImtpZCI6ImtleV9maXh0dXJlIiwidHlwIjoiYXBwbGljYXRpb24vdm5kLm9wZW5tYW8uZ292ZXJuYW5jZS1kZWNpc2lvbi52MStqc29uIn0",
    payloadHex:
      "7b22646563696465645f6174223a22323032362d30372d32365431313a35393a30302e3030305a222c226465636973696f6e223a22617070726f766564222c226f626a6563745f6964223a22617070725f66697874757265222c227369676e6572223a227072696e636970616c5f66697874757265222c22776f726b73706163655f6964223a2277735f66697874757265227d",
    signingInput:
      "eyJhbGciOiJFZERTQSIsImtpZCI6ImtleV9maXh0dXJlIiwidHlwIjoiYXBwbGljYXRpb24vdm5kLm9wZW5tYW8uZ292ZXJuYW5jZS1kZWNpc2lvbi52MStqc29uIn0.eyJkZWNpZGVkX2F0IjoiMjAyNi0wNy0yNlQxMTo1OTowMC4wMDBaIiwiZGVjaXNpb24iOiJhcHByb3ZlZCIsIm9iamVjdF9pZCI6ImFwcHJfZml4dHVyZSIsInNpZ25lciI6InByaW5jaXBhbF9maXh0dXJlIiwid29ya3NwYWNlX2lkIjoid3NfZml4dHVyZSJ9",
    signatureHex:
      "82120b1f68a065895c20070b18fd61c75214bcb5951858211ac9cd35d5a5f7bd805c8e1bc6524c55a626ca5eab3053402051145a5e980009b2b0b94aee028d0e",
  } as const;

  const fixtureBody = {
    workspace_id: "ws_fixture",
    object_id: "appr_fixture",
    signer: "principal_fixture",
    decision: "approved",
    decided_at: "2026-07-26T11:59:00.000Z",
  };

  it("reproduces every pinned intermediate from the test-only seed", () => {
    const { privateKey, publicKeyBase64Url } = keyPairFromSeed(Buffer.from(FIXTURE.seedHex, "hex"));
    expect(publicKeyBase64Url).toBe(FIXTURE.publicKeyBase64Url);
    const envelope = signObject({
      objectClass: "governance_decision",
      keyId: "key_fixture",
      body: fixtureBody,
      privateKey,
    });
    expect(envelope.protectedHeaderSegment).toBe(FIXTURE.protectedHeaderSegment);
    expect(envelope.payloadBytes.toString("hex")).toBe(FIXTURE.payloadHex);
    expect(envelope.signingInput).toBe(FIXTURE.signingInput);
    expect(envelope.signature.toString("hex")).toBe(FIXTURE.signatureHex);
  });

  it("verifies the pinned vector end to end", () => {
    const result = verifyObjectWithKeys({
      expectedClass: "governance_decision",
      expectedWorkspaceId: "ws_fixture",
      expectedObjectId: "appr_fixture",
      envelope: {
        protectedHeaderSegment: FIXTURE.protectedHeaderSegment,
        payloadSegment: Buffer.from(FIXTURE.payloadHex, "hex").toString("base64url"),
        signatureSegment: Buffer.from(FIXTURE.signatureHex, "hex").toString("base64url"),
      },
      keys: [
        verificationKey({
          keyId: "key_fixture",
          publicKeyBase64Url: FIXTURE.publicKeyBase64Url,
          ownerPrincipalId: "principal_fixture",
        }),
      ],
      now: NOW,
    });
    expect(result.ok).toBe(true);
  });
});

describe("JWS conformance", () => {
  it("accepts a signing input built independently as b64u(header) + '.' + b64u(payload)", () => {
    const envelope = signedDecision();
    // Built without touching the module's builder: this is what makes the
    // construction RFC 7515 rather than homegrown.
    const independentHeaderJson = JSON.stringify({
      alg: "EdDSA",
      kid: "key_a",
      typ: "application/vnd.openmao.governance-decision.v1+json",
    });
    const independentInput = `${Buffer.from(independentHeaderJson, "utf8").toString("base64url")}.${envelope.payloadSegment}`;
    expect(independentInput).toBe(envelope.signingInput);
    const publicKey = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: keyA.publicKeyBase64Url },
      format: "jwk",
    });
    const verified = cryptoVerify(
      null,
      Buffer.from(independentInput, "utf8"),
      publicKey,
      Buffer.from(envelope.signatureSegment, "base64url"),
    );
    expect(verified).toBe(true);
  });
});

describe("negative verify vectors", () => {
  it("1. refuses a governance-decision signature presented as a chain attestation", () => {
    const envelope = signObject({
      objectClass: "chain_attestation",
      keyId: "key_a",
      body: decisionBody(),
      privateKey: keyA.privateKey,
    });
    const result = verifyWith(envelope, [verificationKey()]);
    expect(result).toEqual({ ok: false, reason: "class_mismatch", keyId: "key_a" });
  });

  it("2. refuses the correct class at the wrong typ version", () => {
    const envelope = signedDecision();
    const forged = reSign(
      headerSegment({
        alg: "EdDSA",
        kid: "key_a",
        typ: "application/vnd.openmao.governance-decision.v2+json",
      }),
      envelope.payloadSegment,
      keyA.privateKey,
    );
    const result = verifyWith(forged, [verificationKey()]);
    expect(result).toEqual({ ok: false, reason: "unrecognized_typ", keyId: "key_a" });
  });

  it("3. refuses a body naming the wrong workspace id", () => {
    const envelope = signObject({
      objectClass: "governance_decision",
      keyId: "key_a",
      body: { ...decisionBody(), workspace_id: "ws_other" },
      privateKey: keyA.privateKey,
    });
    const result = verifyWith(envelope, [verificationKey()]);
    expect(result).toEqual({ ok: false, reason: "workspace_mismatch", keyId: "key_a" });
  });

  it("4. refuses a body naming the wrong object id", () => {
    const envelope = signObject({
      objectClass: "governance_decision",
      keyId: "key_a",
      body: { ...decisionBody(), object_id: "appr_other" },
      privateKey: keyA.privateKey,
    });
    const result = verifyWith(envelope, [verificationKey()]);
    expect(result).toEqual({ ok: false, reason: "object_mismatch", keyId: "key_a" });
  });

  it("5. refuses a body field mutated after signing", () => {
    const envelope = signedDecision();
    const result = verifyWith(
      {
        protectedHeaderSegment: envelope.protectedHeaderSegment,
        payloadSegment: mutatedPayloadSegment((body) => {
          body.decision = "rejected";
        }),
        signatureSegment: envelope.signatureSegment,
      },
      [verificationKey()],
    );
    expect(result).toEqual({ ok: false, reason: "signature_invalid", keyId: "key_a" });
  });

  it("6. refuses a body field added after signing", () => {
    const envelope = signedDecision();
    const result = verifyWith(
      {
        protectedHeaderSegment: envelope.protectedHeaderSegment,
        payloadSegment: mutatedPayloadSegment((body) => {
          body.unsigned_field = "injected";
        }),
        signatureSegment: envelope.signatureSegment,
      },
      [verificationKey()],
    );
    expect(result).toEqual({ ok: false, reason: "signature_invalid", keyId: "key_a" });
  });

  it("6b. refuses a semantically identical payload serialized to different bytes", () => {
    // The discriminating exact-bytes vector: unlike 5 and 6, the claims are
    // unchanged — only the serialization differs (key order reversed;
    // insignificant whitespace). A verifier that re-serialized the parsed
    // body instead of verifying the presented bytes would wrongly ACCEPT
    // these; exact-byte verification must reject them.
    const envelope = signedDecision();
    const parsed = JSON.parse(
      Buffer.from(envelope.payloadSegment, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const reordered: Record<string, unknown> = {};
    for (const key of Object.keys(parsed).reverse()) {
      reordered[key] = parsed[key];
    }
    for (const variant of [JSON.stringify(reordered), JSON.stringify(parsed, null, 2)]) {
      // Guards: the variant really is semantically identical and really is a
      // different byte string than the one that was signed.
      expect(JSON.parse(variant)).toEqual(parsed);
      expect(Buffer.from(variant, "utf8").equals(envelope.payloadBytes)).toBe(false);
      const result = verifyWith(
        {
          protectedHeaderSegment: envelope.protectedHeaderSegment,
          payloadSegment: Buffer.from(variant, "utf8").toString("base64url"),
          signatureSegment: envelope.signatureSegment,
        },
        [verificationKey()],
      );
      expect(result).toEqual({ ok: false, reason: "signature_invalid", keyId: "key_a" });
    }
  });

  it("7. refuses a signature under a key id marked revoked", () => {
    const result = verifyWith(signedDecision(), [verificationKey({ status: "revoked" })]);
    expect(result).toEqual({ ok: false, reason: "key_revoked", keyId: "key_a" });
  });

  it("8. refuses a key id absent from the key set", () => {
    const result = verifyWith(signedDecision(), [verificationKeyB()]);
    expect(result).toEqual({ ok: false, reason: "unknown_key", keyId: "key_a" });
  });

  it("9. refuses an expired validity window, evaluated against the injected now", () => {
    const expired = verificationKey({ validUntil: "2026-01-01T00:00:00.000Z" });
    expect(verifyWith(signedDecision(), [expired])).toEqual({
      ok: false,
      reason: "key_expired",
      keyId: "key_a",
    });
    // Same instant, earlier now: the wall clock is never consulted.
    const stillValid = verificationKey({ validUntil: "2026-12-31T00:00:00.000Z" });
    expect(verifyWith(signedDecision(), [stillValid]).ok).toBe(true);
    // A not_after enrolment condition is evaluated the same way.
    const conditioned = verificationKey({
      conditions: [{ kind: "not_after", timestamp: "2026-01-01T00:00:00.000Z" }],
    });
    expect(verifyWith(signedDecision(), [conditioned])).toEqual({
      ok: false,
      reason: "key_expired",
      keyId: "key_a",
    });
  });

  it("10. refuses when a condition restricts the key to other record classes", () => {
    const key = verificationKey({
      conditions: [{ kind: "object_classes", classes: ["revocation", "chain_attestation"] }],
    });
    expect(verifyWith(signedDecision(), [key])).toEqual({
      ok: false,
      reason: "condition_class_restricted",
      keyId: "key_a",
    });
  });

  it("11. refuses when a condition names a different workspace", () => {
    const key = verificationKey({
      conditions: [{ kind: "workspace", workspaceId: "ws_elsewhere" }],
    });
    expect(verifyWith(signedDecision(), [key])).toEqual({
      ok: false,
      reason: "condition_workspace_mismatch",
      keyId: "key_a",
    });
  });

  it("12. refuses an unrecognised condition kind instead of ignoring it", () => {
    const key = verificationKey({
      conditions: [{ kind: "not_invented_yet", anything: true }],
    });
    expect(verifyWith(signedDecision(), [key])).toEqual({
      ok: false,
      reason: "condition_unrecognized",
      keyId: "key_a",
    });
  });

  it("13. refuses malformed signature lengths (63 and 65 bytes)", () => {
    const envelope = signedDecision();
    for (const signature of [
      envelope.signature.subarray(0, 63),
      Buffer.concat([envelope.signature, Buffer.alloc(1)]),
    ]) {
      const result = verifyWith(
        {
          protectedHeaderSegment: envelope.protectedHeaderSegment,
          payloadSegment: envelope.payloadSegment,
          signatureSegment: signature.toString("base64url"),
        },
        [verificationKey()],
      );
      expect(result).toEqual({ ok: false, reason: "malformed_signature", keyId: "key_a" });
    }
  });

  it("14. refuses a valid signature made by a different legitimate key", () => {
    const envelope = signedDecision();
    const substituted = reSign(
      envelope.protectedHeaderSegment,
      envelope.payloadSegment,
      keyB.privateKey,
    );
    const result = verifyWith(substituted, [verificationKey(), verificationKeyB()]);
    expect(result).toEqual({ ok: false, reason: "signature_invalid", keyId: "key_a" });
  });

  it("15. refuses a key present but carrying no enrolment record", () => {
    const result = verifyWith(signedDecision(), [verificationKey({ enrolled: false })]);
    expect(result).toEqual({ ok: false, reason: "key_not_enrolled", keyId: "key_a" });
  });

  it("16. refuses a mutated-S malleability vector", () => {
    const envelope = signedDecision();
    const malleableS = writeLe(readLe(envelope.signature.subarray(32)) + ED25519_GROUP_ORDER);
    const forgedSignature = Buffer.concat([envelope.signature.subarray(0, 32), malleableS]);
    const result = verifyWith(
      {
        protectedHeaderSegment: envelope.protectedHeaderSegment,
        payloadSegment: envelope.payloadSegment,
        signatureSegment: forgedSignature.toString("base64url"),
      },
      [verificationKey()],
    );
    expect(result).toEqual({ ok: false, reason: "signature_malleable", keyId: "key_a" });
  });

  it("17. refuses when the body's signer disagrees with the key's owner mapping", () => {
    const envelope = signObject({
      objectClass: "governance_decision",
      keyId: "key_a",
      body: { ...decisionBody(), signer: PRINCIPAL_B },
      privateKey: keyA.privateKey,
    });
    const result = verifyWith(envelope, [verificationKey(), verificationKeyB()]);
    expect(result).toEqual({ ok: false, reason: "signer_mismatch", keyId: "key_a" });
  });
});

describe("verifier robustness", () => {
  it("never throws and refuses garbage input with the contractual reason code", () => {
    // Reason codes land in audit records, so each case asserts the specific
    // code — and the contractual refusal order (typ -> key id -> algorithm/
    // shape -> cryptographic check), not merely "some string".
    const cases: Array<{
      envelope: SignedEnvelopeParts;
      reason: VerifyFailureReason;
      keyId: string | null;
    }> = [
      {
        // Not base64url at all.
        envelope: { protectedHeaderSegment: "!!!", payloadSegment: "???", signatureSegment: "$$$" },
        reason: "malformed_envelope",
        keyId: null,
      },
      {
        // Empty segments.
        envelope: { protectedHeaderSegment: "", payloadSegment: "", signatureSegment: "" },
        reason: "malformed_envelope",
        keyId: null,
      },
      {
        // Base64url but not a JSON object header.
        envelope: {
          protectedHeaderSegment: Buffer.from("not json", "utf8").toString("base64url"),
          payloadSegment: Buffer.from("[]", "utf8").toString("base64url"),
          signatureSegment: Buffer.alloc(64).toString("base64url"),
        },
        reason: "malformed_envelope",
        keyId: null,
      },
      {
        // typ classification precedes algorithm validation: alg "none" with an
        // unrecognised typ is unrecognized_typ, not malformed_envelope.
        envelope: {
          protectedHeaderSegment: headerSegment({ alg: "none", kid: "key_a", typ: "x" }),
          payloadSegment: Buffer.from("{}", "utf8").toString("base64url"),
          signatureSegment: Buffer.alloc(64).toString("base64url"),
        },
        reason: "unrecognized_typ",
        keyId: "key_a",
      },
      {
        // Key-id resolution precedes algorithm validation: alg "none" with an
        // unresolvable kid is unknown_key.
        envelope: {
          protectedHeaderSegment: headerSegment({
            alg: "none",
            kid: "key_missing",
            typ: mediaTypeForClass("governance_decision"),
          }),
          payloadSegment: Buffer.from("{}", "utf8").toString("base64url"),
          signatureSegment: Buffer.alloc(64).toString("base64url"),
        },
        reason: "unknown_key",
        keyId: "key_missing",
      },
      {
        // Only after typ and key id resolve is a bad alg a shape failure.
        envelope: {
          protectedHeaderSegment: headerSegment({
            alg: "none",
            kid: "key_a",
            typ: mediaTypeForClass("governance_decision"),
          }),
          payloadSegment: Buffer.from("{}", "utf8").toString("base64url"),
          signatureSegment: Buffer.alloc(64).toString("base64url"),
        },
        reason: "malformed_envelope",
        keyId: "key_a",
      },
    ];
    for (const { envelope, reason, keyId } of cases) {
      const result = verifyWith(envelope, [verificationKey()]);
      expect(result).not.toBe(true);
      expect(result).toEqual({ ok: false, reason, keyId });
    }
  });
});
