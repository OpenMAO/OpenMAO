# ADR-0020: Signed Authority — Ed25519 Signatures over Bound Identity

**Status:** Accepted (2026-07-27)
**Date:** 2026-07-27
**Proposed by:** Human Product Owner (design reconciled across three independent design passes
and two adversarial reviews, per the project's independent-review discipline)
**Owner:** Human Product Owner

---

## Context

ADR-0007 (first-class principals; not yet published — see the numbering note in this
directory's README) committed OpenMAO to *bound* identity: every actor is a stored principal,
resolved from a credential, never from a caller-asserted string. It did not commit to
cryptography. This ADR records the cryptographic layer built on top of that commitment, because
a signature scheme is a one-way door that outlives any single implementation and therefore
needs its own record.

The problem it solves, precisely: before this work, every separation-of-duties guard OpenMAO
enforces (self-approval, proposer≠applier, corroboration distinctness) compared caller-supplied
actor strings behind one shared operator token. The enforcement was real; the identity it
enforced over was self-asserted. A 2026-07 cross-family source audit named this the project's
largest evaluator-visible weakness, and the ADR-0008 adoption gate accepts as evidence "an
exported, hash-chain-verifiable event-log slice — or periodic chain-head attestations."
Evidence of that kind requires signatures a third party can verify without trusting the
database they came from.

Two constraints shaped everything below:

1. **Zero canonical contract changes.** Adding any field to `EventSchema`,
   `EventPayloadSchema`, or `ExternalActorRefSchema` silently changes the recomputed hash of
   every already-chained event (re-parse materializes schema defaults), and no test that builds
   a fresh database would catch it. Signatures therefore live in sibling tables, never in event
   payloads or contract types.
2. **The signed-input format cannot be migrated later.** A signature binds the exact bytes
   signed; keys rotate and an append-only log cannot be re-signed. A byte-level probe settled
   this: a signature over payload `P` does not verify against any wrapped encoding of `P`. The
   format had to be standard from the first signature.

## Decision

OpenMAO signs the records that move authority — approval approve/reject, autonomy widening
ratification, org-change apply/revert, principal key enrolment and revocation, and event-chain
head attestations — with **Ed25519, over the RFC 7515 detached-JWS signing input, implemented
on `node:crypto` with zero new runtime dependencies.**

The signed bytes are exactly the JWS construction:

```
BASE64URL(UTF8(protected_header_json)) || "." || BASE64URL(payload_bytes)
```

- **Protected header** is minimal and vanilla: `{"alg":"EdDSA","kid":<key id>,"typ":<media
  type>}`. Domain separation rides the registered-style `typ` parameter — one distinct media
  type per signed class (`application/vnd.openmao.governance-decision.approval-approve.v1+json`,
  `…chain-attestation.v1+json`, etc.) — so a signature cannot be reclassified across record
  types without invalidating it. Once emitted, these media types are protocol constants.
- **Payload** is the canonical `dumpJson` serialization of an explicitly-enumerated body
  object. Every value in a signed body comes from stored state — including timestamps, which
  are read from the stored row and never from a wall clock at signing time — so a replayed
  transition re-signs byte-identical bytes and is a no-op under the signature table's unique
  index rather than a duplicate.
- **Verification runs over the exact stored byte string**, never a re-serialization of parsed
  content. The verifier fails closed with typed reason codes, in a fixed order (typ → key
  resolution → algorithm shape → standing → conditions → body claims → signature shape →
  cryptographic check), and never throws on a bad signature.
- **The algorithm is pinned in code on both paths.** `kid` is an unauthenticated lookup hint;
  `alg` is never used to select an algorithm. Ed25519 was chosen because it is natively
  supported by `node:crypto` and because it is *deterministic* — re-signing identical bytes
  yields identical bytes, which is what makes replay idempotent under the unique index.
- **Public keys** are stored as the raw 32-byte Ed25519 key in canonical base64url — the
  RFC 8037 OKP `x` representation. Key enrolment validates curve membership, canonical
  encoding, and rejects small-order points, so a key that admits forged signatures can never be
  stored.
- **Identity resolution is registry-backed.** Who signed is resolved from stored principal and
  key rows, never from the presented envelope; standing (active/disabled/revoked), enrolment,
  and the validity window are all re-derived from stored rows at verification time.
- **Custody is brokered.** Signing goes through a signer broker
  (`sign(handle, bytes) → signature`); no API returns private key material. Operator keys live
  in 0600/0700 file custody established by a root-of-trust ceremony.
- **Signatures live in a sibling append-only table** (`governance_signatures`), written in the
  same transaction as the state transition they authorize. Chain-head attestations get their
  own append-only, self-chaining table (`chain_head_attestations`), with read-time signature
  re-verification: an attestation row is a claim until its envelope re-verifies against the
  stored enrolled key.

### What a signature means — and what it does not

Signing is **server-side**. A valid signature attests: *the substrate, holding this principal's
key, signed on presentation of this principal's credential.* It is exactly as strong as the
credential, not stronger. Individual non-repudiation (proof that a distinct human touched a
key they alone hold) requires device-held keys, which are not implemented and belong to the
remote-access work. The ADR-0008 gate asks for integrity evidence, not non-repudiation, so
this is accepted scope — recorded here rather than glossed.

### Why not Nostr

Nostr was evaluated as the trust core and rejected on evidence, three ways:

1. **Its delegation model cannot say what OpenMAO needs to say.** The delegation specification
   (NIP-26) is a draft its own repository marks unrecommended, and it cannot express either of
   the two constructs this design depends on: attestation under *evaluated* conditions (closed
   predicates checked at every authorization seam, refusing closed on anything unrecognized)
   and *revocation* designed in from day one. A delegation credential that cannot be revoked is
   a liability, not a foundation.
2. **It would force a secp256k1 dependency Node cannot satisfy natively.** Verified by
   execution: `node:crypto` cannot generate or use secp256k1 keys at all, so Nostr conformance
   means taking on a cryptographic dependency — for a curve choice that was itself a
   protocol-conformance decision, not a security judgment.
3. **Deterministic Ed25519 is load-bearing for replay.** Re-signing identical bytes yields
   identical bytes, so the unique index makes a replayed approval a no-op. A randomized scheme
   would break the replay contract outright.

What Nostr's ecosystem got right — real keys per actor, owner-attested agent identity,
verification-first discipline — is replicated as concepts, not adopted as a protocol.

### Why not JOSE-the-library

The signing input is standard RFC 7515, so any JOSE-capable verifier — an auditor, an
adopter's compliance tooling, another deployment — can check these signatures without OpenMAO
publishing a spec. But that interop comes from the *byte format*, not from a dependency: a
compliant detached JWS was assembled and verified using only `node:crypto` and `Buffer`'s
built-in base64url, in about thirty lines. The library would buy nothing the byte format
doesn't already provide, while adding a dependency to a project whose canonicalizer and
custody rules it would not enforce. A JOSE library may be added later purely as a convenience,
or never; either way no history is re-signed, because the bytes were standard from the first
signature.

## Consequences

- The shared operator token and the self-asserted actor header are **deleted**, not
  deprecated: HTTP, console, and CLI authenticate per-principal credentials in one cutover, and
  a privileged unsigned compatibility path exists in no green commit.
- Authority-moving transitions sign inside their state-transition transaction, verified
  against the stored enrolled key before commit; the unsigned `actor === null` escape is
  deleted and `reject()` carries the same self-guard as `approve()`.
- `verify-chain` reports truncation of the newest events **relative to a surviving or exported
  attestation** — an attacker with direct file write access can delete attestation rows beside
  the events, so attestation is tamper-evidence, not tamper-resistance, and the docs and CLI
  output say so.
- **Key rotation voids the anchors it made.** Revocation is untimestamped, so verification
  fails closed on a revoked key even for historical attestations; the accepted rule is
  re-attest after rotation. Restoring historical verification across rotation would require
  timestamped revocation, recorded here as the known cost of failing closed.
- `SCHEMA_VERSION` stays 8: the six identity/signature tables ride the unconditional DDL path,
  and zero canonical contract fields were added.
- The evidence artifact for the adoption gate — an exported, hash-chain-verifiable event-log
  slice anchored by a signed chain-head attestation — is producible and independently
  verifiable as documented in [docs/CHAIN_EVIDENCE.md](../CHAIN_EVIDENCE.md).
- A reversal of any choice recorded here — curve, envelope format, dependency posture, sibling
  table placement — must amend this ADR, so the reversal is recorded rather than silent.

## Alternatives considered

- **Nostr as the trust core.** Rejected — see above: draft delegation spec, no evaluated
  conditions, no revocation, and a secp256k1 dependency Node cannot satisfy natively.
- **DSSE (Dead Simple Signing Envelope).** Ranked first by one reviewer largely on
  "no dependency," a premise the byte-level probe falsified — JWS needs no dependency either.
  With cost equalized, JWS wins: an IETF standard with ubiquitous verifier tooling in exactly
  the compliance and audit contexts that would ever check these signatures, where DSSE tooling
  concentrates in software-supply-chain use.
- **Bespoke preimage, with a "wrap it in JWS later" hedge.** Rejected by execution: Ed25519
  binds the exact message, so no historical bespoke signature can ever become a valid JWS
  signature. There is no cost-free later migration; the standard format had to come first.
- **secp256k1 via an external dependency.** Rejected: adds a cryptographic dependency for a
  curve whose only argument was Nostr conformance, and its randomized signature variants would
  break the replay contract that deterministic Ed25519 preserves.
- **Signing every HTTP request with the governance envelope.** Rejected for this branch:
  request signing is a network-threat mitigation whose value is low under a mandatory loopback
  gate. The remote-access plan assigns it to RFC 9421 HTTP Message Signatures — a different
  problem from governance attestation, deserving its own standard.
- **Signature fields on canonical contracts (`principal_id` on the actor reference,
  `resolved_by` on approvals).** Rejected by probe: any additive event-contract field silently
  rewrites the hash of every stored chained event, and the approver is already recorded
  verifiably twice (the signature row, the now-bound event actor). A third denormalized copy
  would engage the contract freeze to record data already recorded.
