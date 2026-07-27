# HANDOFF — Signed Authority: CLOSEOUT

**Status:** `done` — all seven milestones accepted, every done-criterion met as a delta from the
recorded baseline.
**Branch:** `claude/signed-authority`
**Budget used:** 22 of 24 ticks.

## What the branch does

Replaces a shared bearer token plus a self-asserted `x-openmao-actor` header with per-principal
cryptographic identity, and makes the decisions that move authority carry Ed25519 signatures —
implemented on `node:crypto` over the RFC 7515 detached-JWS signing input, with **zero new runtime
dependencies** and **zero canonical contract changes** (`SCHEMA_VERSION` still 8).

| Milestone | Delivered |
| --- | --- |
| M1 Crypto core | signing + verification, sign-only custody broker, 17 negative vectors |
| M2 Identity storage | six tables, five stores, principal auth; fixed two bugs a closed PR had surfaced |
| M3 Custody + bootstrap | custody tiers with enforced modes, root-of-trust ceremony, profile token custody |
| M3a Console extraction | `server.ts` 2,563 → 1,266 lines; output proven byte-identical |
| M4 Atomic cutover | HTTP + console + CLI in one wave; legacy token path **deleted** |
| M5 Signed decisions | approve / reject / ratify / apply / revert signed; null-actor escape deleted |
| M6 Chain attestations | signed head anchors with read-time signature verification |
| M7 Docs + evidence | ADR-0020, LIMITATIONS truth-up, remote-access plan, exportable evidence bundle |

**Tests: 329 → 574.** Every criterion was verified as a *delta* — a check that was already green at
baseline could never count as done.

## The finding worth carrying forward

Across six milestones, every decisive defect had one shape: **a check that tested the presence of a
marker rather than the provenance or immutability of the thing.**

- A spread copied an "unforgeable" brand.
- A stateful getter defeated a frozen-looking object, so the separation-of-duties guard and the signer
  resolution read different values.
- Absence-of-a-production-signal stood in for under-test.
- A status column stood in for a validity window (`valid_from` was never checked).
- A `signature_id` column stood in for a verified envelope.
- A comment asserting a check happens stood in for the check.

**Four of the six were fail-open.** Two were live forgeries: an Ed25519 low-order key that verified
arbitrary bytes with no private key, and a transplanted signature that let an attacker with database
write access — and no key — rewrite the chain and have it verify clean.

None were caught by a green test suite. All were caught by a cross-family auditor probing rather than
reading. The rule is recorded once, in `AGENTS.md` Hard Rules: **"Test the thing, not its marker."**

## What this deliberately does NOT do

Stated here and in `docs/LIMITATIONS.md` §2, because overclaiming would violate the repo's own
truth-in-status ADR:

- Signing is **server-side**. A signature attests "the substrate, holding this principal's key, signed
  on presentation of this principal's credential" — exactly as strong as the credential, not stronger.
  Device-held keys would give individual non-repudiation and are not implemented.
- Direct write access to the database file remains equivalent to root.
- Chain attestations detect truncation only relative to an attestation that **survives or was
  exported**.
- Rotating a signing key **voids the anchors it made** (revocation is untimestamped, so verification
  fails closed). Re-attest after rotation.
- The server is **loopback-only**. Remote access is a written plan, not an implementation.
- Authority is still binary — `AuthorityGrant`, quorum and impact-gated approval are not in scope.

## Gate evidence

`docs/CHAIN_EVIDENCE.md` documents producing and verifying an exportable bundle. Verification needs
**no database**: it re-checks chain, anchor and signature from the bundle alone, and fails closed —
truncation reports an anchor failure, a mutated payload a chain failure, both non-zero exit. This is
what ADR-0008 names as acceptable evidence.

## For the operator

1. Review the PR. It is large by design — the boundary cutover had to be atomic, because a green tree
   containing a privileged unsigned path beside the new one is the condition this work exists to end.
2. **`.goal/` is loop machinery committed on this branch by design**, so a resumed session could
   reconstitute. It is not product code. Squash it out or strip it before merge if you prefer.
3. This branch predates PR #133 (publishing the ADR series to `main`), so `docs/adr/README.md`
   carries the older numbering note. It resolves when both land; fixing it here would conflict.
4. Residual hardening not in scope, recorded in `PROGRESS.md`: failure paths that can delete
   pre-existing custody artefacts, a symlinked custody directory at creation, the profile unchecked at
   use time, and a read/check TOCTOU in custody resolution.
