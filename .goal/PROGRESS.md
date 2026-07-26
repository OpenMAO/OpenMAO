# PROGRESS — Signed Authority

Milestone log. Appended by the loop each tick. A resuming session reads this to know what has
actually been accepted versus attempted.

| Milestone | Status | Accepted at | Notes |
|---|---|---|---|
| M1 Crypto core | code written, AUDIT REJECTED (attempt 2) | — | deterministic green (365 vs 329) but cross-family audit found 6 P1 defects; fix round pending |
| M2 Identity storage | not started | — | — |
| M3 Custody + bootstrap | not started | — | — |
| M3a Console extraction | not started | — | — |
| M4 Atomic cutover | not started | — | — |
| M5 Signed decisions | not started | — | — |
| M6 Chain attestations | not started | — | — |
| M7 Docs + evidence | not started | — | — |

## Failure signatures

### SIG-001 — M1 / k3-codex dispatch carrying the full crypto brief / permission-classifier denial

- **Milestone:** M1 Crypto core
- **Approach:** dispatch `k3-worker` with the verbatim M1 brief (signing module, signer broker,
  sensitive-material extension, 17 negative vectors).
- **Failing check:** not a test failure — the dispatch itself was refused:
  `Permission for this action was denied by the Claude Code auto mode classifier.`
- **Cause, established by controlled comparison (not guessed):** the executor bisected it. An
  identical command — same wrapper, same cwd, same reasoning effort, same Node PATH — was ALLOWED
  with a trivial prompt and BLOCKED with the M1 brief. The trigger is **prompt content, not command
  shape**. The brief is dense with private-key-custody and signature-forgery vocabulary
  ("must never return a private key", "PKCS8 private-key shapes", "signature malleability",
  "key substitution") which reads as credential tooling out of context, despite being defensive
  work whose entire purpose is that keys cannot escape.
- **Do NOT retry this approach.** Rewording the brief to slip past a content classifier is working
  around a denial, not resolving it. The executor correctly refused to do so; so does the loop.
- **Resolution required (operator):** a Bash permission rule permitting the K3 wrapper
  (`/Users/bilalsyed/.codex/dual-router/k3-codex`, optionally `k3-claude`) to be invoked with
  arbitrary task text. This is infrastructure the loop consumes, not infrastructure it may modify.

## Notes for the operator

- Loop machinery lives in `.goal/` and is committed on this branch by design; it is not product code.
- The loop may not merge, may not touch external contributors' PRs/issues, and may not modify CI.

### SIG-002 — M1 / K3 crypto core attempt 2 / cross-family audit REJECT

**Deterministic checks passed** (`make check` exit 0, 41 files / 365 tests vs 329 baseline, scope
guards untouched, zero new deps). The GPT cross-family audit rejected it anyway — which is the whole
point of requiring an auditor from a different model family than the executor.

Findings, judged on cited evidence and all confirmed reproducible:

- **P1 (decisive) — Ed25519 is not pinned on the SIGNING path.** No `asymmetricKeyType` check exists
  anywhere (`grep` returns nothing). `crypto.sign(null, …)` takes its behaviour from the supplied
  key, so a misconfigured broker produces 256-byte RSA or 114-byte Ed448 signatures that `signObject`
  then labels `alg:"EdDSA"`. Verification *does* pin Ed25519; signing does not. The milestone's
  stated cryptographic contract is therefore not enforced.
- **P1 — the broker's custody boundary is TypeScript-only.** `private readonly env` / `private
  readonly handles` erase at runtime, so any caller can read `(broker as any).handles.get(h)` and
  recover key material. The leakage test only inspects prototype methods, so it cannot catch this.
  A sign-only boundary that a cast defeats is not a boundary.
- **P1 — base64url decoding accepts non-canonical encodings.** Unused pad bits are not validated, so
  a signature has multiple accepted textual forms (flipping the last character of the pinned
  signature still decodes to identical bytes). That is envelope malleability and it will disagree
  with strict JOSE tooling — which matters precisely because the format was chosen for external
  verifiability.
- **P1 — the PKCS8 scrubber assumes a fixed 48-byte encoding.** PKCS8 allows optional attributes; a
  valid 50-byte Ed25519 key begins `MDACAQ` and slips the pattern, so real key material can reach an
  audit record.
- **P1 — refusal order is not as specified.** `alg` is checked before `typ` classification and key
  lookup, so reason codes misreport why a verification failed, and those codes are destined for
  audit records.
- **P1 — vectors 5/6 do not prove the exact-bytes invariant.** Both mutate semantic content, so a
  verifier that re-serializes instead of verifying presented bytes would pass them too. The
  implementation is in fact correct here; the *test* cannot tell the difference. The missing
  discriminator is a semantically identical payload with different key order plus the original
  signature.
- P2 — `StaticSigningBroker` skips the handle validation `EnvSigningBroker` enforces.

**Approach is not blocked** — the design is sound and the defects are specific and mechanical. Next
attempt fixes these findings rather than re-approaching the milestone.
