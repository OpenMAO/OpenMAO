#!/usr/bin/env tsx
/**
 * Verifies a chain-evidence bundle (scripts/export-chain-evidence.ts) WITHOUT
 * touching any database. This is the check a third party runs — the whole
 * point of the artifact is that verification needs only the bundle and the
 * published algorithm (docs/CHAIN_EVIDENCE.md specifies it independently of
 * this implementation).
 *
 * Three independent checks, each fail-closed:
 *
 *   1. CHAIN — every event hash is recomputed as SHA-256 over the canonical
 *      JSON of the event with its `hash` field removed, and every `prev_hash`
 *      must link to the preceding event, back to the fixed genesis value.
 *   2. ANCHOR — the surviving head (last event's sequence, hash, and the event
 *      count) must equal what the attestation pins. Truncation of the newest
 *      events leaves a self-consistent chain whose head no longer matches.
 *   3. SIGNATURE — the attestation's RFC 7515 detached-JWS signing input
 *      (BASE64URL(header) || "." || BASE64URL(payload)) must verify under
 *      Ed25519 against the signer's public key, with the header's algorithm,
 *      media type, and key id and the body's workspace, object, signer, and
 *      attested-fact claims all bound to the bundle.
 *
 * Usage: tsx scripts/verify-chain-evidence.ts <bundle.json>
 * Exit 0 with a JSON report on success, 1 on the first failed check.
 */
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { readFileSync } from "node:fs";

import { dumpJson } from "../ts/src/persistence/serialization.js";

const EXPECTED_FORMAT = "openmao-chain-evidence/v1";
const EXPECTED_MEDIA_TYPE = "application/vnd.openmao.chain-attestation.v1+json";
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;

type BundleEvent = Record<string, unknown> & { seq: number; hash: string; prev_hash: string };

function fail(check: string, detail: string): never {
  console.log(JSON.stringify({ ok: false, failed_check: check, detail }, null, 2));
  process.exit(1);
}

function isCanonicalBase64Url(segment: string): boolean {
  return (
    BASE64URL_PATTERN.test(segment) &&
    segment.length > 0 &&
    Buffer.from(segment, "base64url").toString("base64url") === segment
  );
}

function decodeSegment(check: string, name: string, segment: string): Record<string, unknown> {
  if (!isCanonicalBase64Url(segment)) {
    fail(check, `${name} is not canonical base64url`);
  }
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      fail(check, `${name} does not decode to a JSON object`);
    }
    return value as Record<string, unknown>;
  } catch {
    fail(check, `${name} does not parse as JSON`);
  }
}

const bundlePath = process.argv[2];
if (!bundlePath) {
  fail("usage", "expected a bundle path: tsx scripts/verify-chain-evidence.ts <bundle.json>");
}
let bundle: Record<string, unknown>;
try {
  bundle = JSON.parse(readFileSync(bundlePath, "utf8")) as Record<string, unknown>;
} catch {
  fail("format", `${bundlePath} does not parse as JSON`);
}
if (bundle.format !== EXPECTED_FORMAT) {
  fail("format", `expected format ${EXPECTED_FORMAT}, got ${String(bundle.format)}`);
}

// --- 1. CHAIN ---------------------------------------------------------------
const events = bundle.events as BundleEvent[];
if (!Array.isArray(events) || events.length === 0) {
  fail("chain", "the bundle carries no events");
}
const genesisHash = bundle.genesis_hash as string;
if (typeof genesisHash !== "string" || genesisHash.length !== 64) {
  fail("chain", "missing or malformed genesis_hash");
}
let previousHash = genesisHash;
for (const event of events) {
  if (typeof event.hash !== "string" || typeof event.prev_hash !== "string") {
    fail("chain", `event at seq ${String(event.seq)} is not hash-chained`);
  }
  if (event.prev_hash !== previousHash) {
    fail(
      "chain",
      `event at seq ${event.seq} does not link to its predecessor (insertion or reorder)`,
    );
  }
  const { hash: statedHash, ...content } = event;
  const recomputed = createHash("sha256").update(dumpJson(content)).digest("hex");
  if (recomputed !== statedHash) {
    fail("chain", `event at seq ${event.seq} hash does not match its contents (tampering)`);
  }
  previousHash = statedHash;
}
const head = events[events.length - 1]!;

// --- 2. ANCHOR --------------------------------------------------------------
const attestation = bundle.attestation as Record<string, unknown>;
if (!attestation || typeof attestation !== "object") {
  fail("anchor", "the bundle carries no attestation");
}
if (attestation.head_hash !== head.hash) {
  fail(
    "anchor",
    `surviving head hash ${head.hash} does not match attested head hash ${String(attestation.head_hash)} — the chain was truncated or rewritten after attestation`,
  );
}
if (attestation.head_sequence !== head.seq) {
  fail(
    "anchor",
    `surviving head sequence ${String(head.seq)} does not match attested ${String(attestation.head_sequence)}`,
  );
}
if (attestation.event_count !== events.length) {
  fail(
    "anchor",
    `surviving event count ${events.length} does not match attested ${String(attestation.event_count)}`,
  );
}

// --- 3. SIGNATURE -----------------------------------------------------------
const signature = bundle.signature as Record<string, unknown>;
const signer = bundle.signer as Record<string, unknown>;
if (!signature || !signer) {
  fail("signature", "the bundle carries no signature or signer block");
}
const segments = (signature.signed_bytes as string)?.split(".") ?? [];
if (segments.length !== 2) {
  fail("signature", "signed_bytes is not the two-segment JWS signing input");
}
const [headerSegment, payloadSegment] = segments as [string, string];
const signatureSegment = signature.signature as string;
if (!isCanonicalBase64Url(signatureSegment)) {
  fail("signature", "the signature segment is not canonical base64url");
}

const header = decodeSegment("signature", "protected header", headerSegment);
if (header.alg !== "EdDSA") {
  fail("signature", `protected header alg is ${String(header.alg)}, not EdDSA`);
}
if (header.typ !== EXPECTED_MEDIA_TYPE) {
  fail("signature", `protected header typ is ${String(header.typ)}, not ${EXPECTED_MEDIA_TYPE}`);
}
if (header.kid !== signer.key_id || header.kid !== attestation.signer_key_id) {
  fail("signature", "the header key id does not match the attestation's signer key");
}

const body = decodeSegment("signature", "payload", payloadSegment);
const expectedBodyClaims: Array<[string, unknown]> = [
  ["workspace_id", bundle.workspace_id],
  ["object_id", attestation.id],
  ["signer", attestation.signer_principal_id],
  ["signer_key_id", attestation.signer_key_id],
  ["head_sequence", attestation.head_sequence],
  ["head_hash", attestation.head_hash],
  ["event_count", attestation.event_count],
  ["attested_at", attestation.attested_at],
];
for (const [claim, expected] of expectedBodyClaims) {
  if (body[claim] !== expected) {
    fail(
      "signature",
      `signed body claim ${claim} is ${JSON.stringify(body[claim])}, expected ${JSON.stringify(expected)}`,
    );
  }
}
if (
  signature.signer_key_id !== attestation.signer_key_id ||
  signature.signer_principal_id !== attestation.signer_principal_id ||
  signature.id !== attestation.signature_id
) {
  fail("signature", "the signature row and attestation row disagree about who signed what");
}

const signatureBytes = Buffer.from(signatureSegment, "base64url");
if (signatureBytes.length !== 64) {
  fail("signature", `signature is ${signatureBytes.length} bytes, not 64`);
}
let verified: boolean;
try {
  const publicKey = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: signer.public_key as string },
    format: "jwk",
  });
  verified = cryptoVerify(
    null,
    Buffer.from(signature.signed_bytes as string, "utf8"),
    publicKey,
    signatureBytes,
  );
} catch (error) {
  fail("signature", `the public key does not import as Ed25519: ${String(error)}`);
}
if (!verified) {
  fail("signature", "the Ed25519 signature does not verify over the signed bytes");
}

console.log(
  JSON.stringify(
    {
      ok: true,
      checks: {
        chain: { events: events.length, head_sequence: head.seq, head_hash: head.hash },
        anchor: { attestation_id: attestation.id, attested_at: attestation.attested_at },
        signature: {
          key_id: signer.key_id,
          principal_id: signer.principal_id,
          trust: signer.trust,
          caveat:
            "verified against the public key carried in the bundle; confirm that key against an independently obtained fingerprint before treating authorship as established",
        },
      },
    },
    null,
    2,
  ),
);
