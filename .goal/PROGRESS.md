# PROGRESS — Signed Authority

Milestone log. Appended by the loop each tick. A resuming session reads this to know what has
actually been accepted versus attempted.

| Milestone | Status | Accepted at | Notes |
|---|---|---|---|
| M1 Crypto core | **ACCEPTED** | 2026-07-26 | 378 tests (baseline 329); 2 audit rounds, 8 findings fixed; driver fixed a quadratic-scan regression |
| M2 Identity storage | **ACCEPTED** | 2026-07-26 | 428 tests; 2 audit rounds, 13 findings incl. a demonstrated P0 signature forgery |
| M3 Custody + bootstrap | **ACCEPTED** | 2026-07-27 | 518 tests; 2 audit rounds; P0 confirmed fixed, caller-trust bypass closed by driver |
| M3a Console extraction | **ACCEPTED** | 2026-07-27 | pure move; output byte-identical at source AND runtime; server.ts 2563 -> 1266 |
| M4 Atomic cutover | **ACCEPTED** | 2026-07-27 | 531 tests; 6 audit findings fixed; spread-forgery closed by driver |
| M5 Signed decisions | next | — | — |
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

### M1 — ACCEPTED (2026-07-26)

Two full cross-family audit rounds. GPT rejected K3's work twice; both rejections were correct and
both were upheld by the judge on cited evidence. Final state: `make check` green, **378 tests vs a
329 baseline**, scope guards untouched, zero new dependencies.

What the audits caught that a green suite did not:
- **Ed25519 was pinned on verification but not on signing** — no key-type check existed, so a
  misconfigured broker would emit RSA or Ed448 signatures labelled `alg:"EdDSA"`. The milestone's
  central cryptographic contract was unenforced while every test passed.
- **The custody boundary was TypeScript-only.** `private readonly` erases at runtime; a cast
  recovered key material. Now ECMAScript `#private`, with a test that enumerates own properties
  rather than only walking the prototype.
- **base64url accepted non-canonical encodings** — one signature had several valid textual forms.
  Now decode/re-encode equality on all three segments.
- **The exact-bytes invariant had no discriminating test.** Both original vectors mutated semantic
  content, so a re-serializing verifier would have passed them too. Now pinned by a semantically
  identical, byte-different payload presented with the original signature.
- **A fix round introduced a P1 worse than the bug it fixed**: the new scrubber matched a maximal
  base64 run and anchored DER at offset 0, so `signkey_<material>` — the exact shape key material
  takes in a log line — evaded detection entirely. Caught only because the auditor probed rather
  than read.

Driver-applied fix (outside the executor iteration cap, recorded openly): the corrected scrubber
scanned every offset by decoding the whole remaining run, which is quadratic — 267KB took 4.5s on the
*ingestion* path, which takes untrusted input with no length cap. Capping each decode window at 72
characters makes it linear: 267KB now 35ms, a 130x improvement, with all five bypass shapes still
scrubbed and no false positives.

Also fixed here: `node_modules` was tracked as an absolute-path symlink into another checkout — a
driver setup error, caused by `.gitignore` listing `node_modules/` with a trailing slash, which does
not match a symlink of that name. Untracked and properly ignored. The executor's hygiene-script
workaround was reverted as scope creep once the root cause was gone.

### M2 — ACCEPTED (2026-07-26)

`make check` green, **428 tests** (M1 left it at 378). Six SQL tables, five principal stores,
`PrincipalAuthService`, and the two bugs closed PR #63 had surfaced. `SCHEMA_VERSION` stays 8 —
fresh tables in the unconditional DDL need no migration.

Two audit rounds, thirteen findings. The decisive one was a **demonstrated signature forgery**, and
it is worth recording precisely because a green suite could never have found it:

`createPublicKey()` does not validate that 32 bytes are a usable curve point. The Ed25519 low-order
identity key (`0x01` + 31 zero bytes) imports happily, and a signature of `R = identity, S = 0`
**verifies against arbitrary bytes with no private key**. Anyone able to enrol that public key could
forge a valid signature on any governance decision — the exact attack this milestone exists to stop.
The auditor found it by probing rather than reading; the driver reproduced it independently before
acting.

Fixed by rejecting all eight small-order encodings, non-canonical y values, and off-curve points at
the key store, so an unusable key can never be stored. The eight encodings were *derived*, not
copied: the executor derived them from the curve equation, the driver's verification re-derived them
by a different route (projecting through the torsion subgroup) and got an exact match, and removing
the check fails exactly three tests by name.

Also fixed across the two rounds: a store that accepted plaintext where a hash belonged (now
constrained at the column, not just the code path); a public-key registry that would accept a
*private* key; missing composite foreign keys that allowed orphan and cross-workspace authority
records; a signed revocation that recorded an audit row without actually revoking the key
(split-brain — revocation looked recorded while the key still resolved active); a signature upsert
whose race was reachable because the server opens a fresh connection per request under WAL; and
status parsing that failed *open*, so a typo like "suspended" would authenticate.

Two residual notes accepted knowingly: one test asserts the Node low-order-verify behaviour still
exists, so it will fail if a future Node hardens it — a canary that breaks on an upstream fix; and
the end-to-end forgery assertion is indirect (the forged key is refused as unknown because it can no
longer be enrolled at all). The executor disclosed both rather than papering over them.

### SIG-003 — M3 / two audit rejections + a half-migrated tree

M3 (custody + bootstrap) is written and green at **504 tests**, but has been rejected twice by the
cross-family audit and is at code-attempt 2 of 3.

**Tree state found at tick 9, worth recording as a process failure:** `make check` was RED on arrival,
despite the prior round reporting "498 green". Two causes, both now fixed by the driver:
biome formatting errors in two new files, and — more seriously — a **half-migrated refactor**. The
audit's cross-workspace fix changed `resolveCustody` to take `keysRoot` + `workspaceId`, the source
was updated, but `ts/tests/key_custody.test.ts` still used the old `keysDir` API and never imported
`workspaceCustodyDir`. So the file did not typecheck, and the "498 green" verification was taken on a
tree that could not compile that suite. Completing the migration (one import, five call sites) took
the count to 504 — the extra six are cases that were never actually running.

**Lesson for the executor brief:** a reported test count is only meaningful if typecheck passed in
the same run. Verify the gate end-to-end rather than trusting a summary line.

**Outstanding audit findings on M3 (unfixed):**
- **P0 — authority mutations accept forged signers.** `attestPrincipalKey()` gates on a
  caller-supplied `attester.kind` and never verifies the signature against the *stored* attester key.
  `revokePrincipalKey()` performs no active-principal, operator, active-revoker-key, or broker/key
  binding check at all. The system records signed authority changes it cannot substantiate — the
  exact property the milestone exists to establish.
- **P1 — the honesty valve remains bypassable.** A registry-backed key loader was added, but
  `verifyObject` still accepts caller-built keys and the loader has *zero production callers*. A
  probe confirmed a hand-built key omitting `dev_bootstrap` still reports production trust.
- **P1 — cross-workspace custody bypass survives.** `resolveCustody` still accepts a custody root and
  workspace id that can disagree, and the registry check returns early when the registry is empty.
- P1 — a disabled principal's keys still load as active.
- P1 — failure paths can delete pre-existing artefacts and leave irrecoverable split state.
- P1 — custody creation follows a symlinked directory; the profile is unchecked at use time.

**The recurring pattern, named:** twice the executor added a safe path *without removing the unsafe
one*. A safe alternative beside a reachable unsafe path is not a fix. The final attempt must make the
unsafe path unexpressible — delete it, make it private, or change the signature so the dangerous
combination cannot be constructed.

### M3 — ACCEPTED (2026-07-27)

`make check` green, **518 tests** (M2 left it at 428), typecheck clean in the same run.

Delivers custody tiers with enforced 0600/0700 modes, the root-of-trust ceremony with evaluated
predicates, workspace-namespaced custody, atomic temp+rename writes, operator profile token custody
across invocations, `principal-authority` mint/attest/revoke with events, and the
`AuthenticatedPrincipal` abstraction with the CLI's 13 actor sites routed through it — behaviour
deliberately unchanged, because the boundary cutover is M4.

**Two findings from the final round are worth keeping, because both are about process rather than
code:**

1. **An audit went stale under its own subject.** The second audit was written against the
   uncommitted tree, and by the time its findings were acted on, two of the three — the P0 on forged
   signers and the cross-workspace bypass — were already fixed in what got committed. Verified
   directly: `00e902b` resolves the operator from stored rows and verifies the produced signature
   before writing, and `input.attester.kind` appears nowhere. The cited line numbers pointed at
   unrelated code. **Re-verify a finding against the current tree before spending an iteration on
   it** — a third of the last attempt was spent on already-closed holes.

2. **The remaining hole was fail-open, and the executor's own fix reproduced the pattern.** The
   honesty valve was closed with a runtime brand so a hand-built key cannot verify — good. But the
   test-only mint that stamps the brand was guarded by *absence of production signals*, so on any
   machine with `NODE_ENV` unset it minted freely and a caller could still claim `standard` trust for
   a dev-bootstrapped key. Reproduced by probe. Fixed by the driver, inverting the guard to require
   an affirmative test-runner signal — refuse unless under test, rather than allow unless production.

That inversion is the same correction this project has now had to make repeatedly: status parsing
that failed open, a scrubber that failed open on prefixes, and now a trust seam that failed open on
an unset environment variable. Worth stating as a standing rule in M7's documentation: **a security
gate keyed on the absence of a signal is not a gate.**

Residual, recorded rather than fixed (deferred to M7 documentation or a follow-up):
`verifyObject` still has no production caller — the boundary that will call it is M4; a
`registrySize === 0` early return remains in `assertCustodyMatchesRegistry` after the foreign-key
check; and four hardening findings from the second audit (failure paths deleting pre-existing
artefacts, symlinked custody dir at creation, profile unchecked at use time, read/check TOCTOU).

### M3a — ACCEPTED (2026-07-27)

`make check` green, 518 tests, typecheck clean in the same run. `ts/src/api/server.ts` drops from
**2,563 to 1,266 lines**; the console template moves to `ts/src/api/console.ts` (1,318 lines).

Low risk tier, so deterministic verification only — no cross-family audit, per the verifier contract.
But "pure move" is a claim that deserves evidence, and it got some: the rendered `/console` HTML was
captured over HTTP from the old and new code and is **byte-identical** (86,107 bytes, sha256
`3c45e26…73cbb4`), and the template source itself is identical (`85ee8c5…7fd4bf0`). Both were
reproduced independently rather than taken on report.

The six interpolated constants (`TOKEN_HEADER`, `ACTOR_HEADER`, `CONSOLE_ACTOR`, `WORKSPACE_ID`,
`RUN_ID`, `COORDINATOR_AGENT_ID`) cross as a typed `ConsoleConfig` parameter rather than being
duplicated or moved — deliberately, because moving them would have widened the diff into the
auth-adjacent code M4 owns, and duplicating a header name is exactly the kind of drift that becomes a
real bug.

**Why this wave existed at all:** M4 rewrites the authentication boundary *and* the console's request
headers. With 1,300 lines of template inline, that diff would have been unreviewable and would have
conflicted badly. Note for M4: the header set now lives in two places that TypeScript keeps in sync —
the `ConsoleConfig` type and the call-site literal — so changing it is two edits, not one, but the
build fails if they diverge.

Also cleaned: a gitignored `.openmao/` runtime directory accumulated during execution, which was
making `make demo-approve` fail on stale state. Removed; not a code issue.

### M4 — code complete, audit pending (2026-07-27)

`make check` exit 0 with typecheck clean **in the same run**: 49 files / **522 tests** (was 518).
Committed durable-but-not-accepted so a five-hour executor run cannot be lost to an interruption;
the cross-family audit was cut off mid-probe by a transient API 529 and must be re-run before this
milestone can be accepted.

The wave did what it had to do atomically — HTTP, console and CLI in one commit, with the legacy
bearer path **deleted rather than deferred**, because a green tree containing a privileged unsigned
path is exactly the condition this branch exists to end.

**Deleted, not merely superseded** (driver-verified by grep): `ServerOptions.operatorToken`,
`tokenMatches`, the random boot token and its stdout print; `CONSOLE_ACTOR`; `cli_operator` /
`LEGACY_CLI_ACTOR`; all ten `--by` flag occurrences — three lines remain and they are a *hard error*
naming the replacement, so a stale script fails loudly instead of being silently reinterpreted;
`requireUnambiguousWriteWorkspace` and its 23 call sites, dead once the credential forces the
workspace; and `producedSignatureVerifies`, the hand-rolled crypto, replaced by the registry-backed
`verifyObject`. `x-openmao-operator-token` survives only inside `REJECTED_HEADERS` as a permanent
regression fence.

**`verifyObject` finally has a production caller** — the gap the M3 audit flagged. `attestPrincipalKey`
and `revokePrincipalKey` now verify the produced envelope against the *stored enrolled* key before
the recording transaction, so a broker that does not hold the key it claims writes nothing.

**The gate-relevant unlock:** with per-principal console tokens replacing the hardcoded actor, two
humans in two browser profiles can each approve under their own identity. Separation of duties stops
being a string comparison and becomes demonstrable.

Two places the executor pushed back and was right: the self-approval test cannot use the demo
approval (its `requested_by` is an agent id no principal token can equal, so it seeds an
`OrgChangeService.propose` review instead — which is the two-human separation the milestone actually
wants), and `/ingestion` returns 201 not 200, which was true at baseline too.

**Carried into the re-audit:** the interrupted run had already flagged a possible TOCTOU window in
`attestPrincipalKey` — verify-then-write with a gap between the stored-state check and the recording
transaction. That is the first thing the next audit must probe.

**Audit blocked (2026-07-27):** the M4 cross-family audit was attempted twice and both runs died on
`API Error: 529 Overloaded` — transient infrastructure, unrelated to the code. Deterministic
verification passed in full (522 tests, typecheck clean in the same run, deletions grep-verified), so
M4 is code-complete and durably committed at `d11bfc7`, but **not accepted**: a high-risk milestone
does not get accepted on deterministic checks alone, and on this branch the audits have caught what
green suites did not, every single time.

Next tick retries the audit. It must lead with the carried TOCTOU finding in `attestPrincipalKey`.

### M4 — ACCEPTED (2026-07-27)

`make check` green, **531 tests** (M3a left it at 518), typecheck clean in the same run.

The audit (third attempt; two earlier runs died on transient API 529) returned 3×P1 + 3×P2 and
rejected. All six were fixed, and the two decisive ones were the same shape this branch keeps
producing — **a safe path added beside a still-reachable unsafe one**, now for the third time:

- **`work outcome` was unauthenticated worker impersonation.** The command passed no actor at all
  while every sibling command passed `cliPrincipal().actor`; anyone who could run the CLI could act
  as any assigned worker. Now it requires a worker token, and `--worker` is demoted to a
  must-match cross-check against the credential.
- **The publicly-exported SDK let a caller name the acting identity.** `OpenMaoLocalClient` took an
  `actor: string` straight into event records. It now takes an `AuthenticatedPrincipal` only the
  credential path can produce, and `issued_by` was deleted from the envelope input.
- **TOCTOU between verification and the write.** Verification completed, *then* the transaction
  began, so a principal disabled or a key revoked in that gap still produced a committed authority
  record ordered after its own withdrawal. Standing is now re-read as the first statement inside the
  writing transaction, with tests that interpose a second connection at exactly that point.

Also fixed: demo approvals recorded a hardcoded `"reference_worker_demo"` instead of the
authenticated operator; the rejected-header fence sat inside `authenticateContext`, so `/health` and
`/console` accepted the spoof header and returned 200; and `verify-chain` opened the database
writable, so its constructor's `PRAGMA journal_mode = WAL` could persistently mutate the file it was
only supposed to read.

**Driver fix, recorded openly:** the executor's unforgeable-identity brand was defeated by **object
spread**. `[AUTHENTICATED]: true` assigned in an object literal is an *enumerable* own symbol, so
`{ ...principal, actor: victim }` copies the brand and passes an `in` check — meaning any caller
holding one valid credential could still record events as any principal. Demonstrated by probe,
then closed by replacing the property check with an identity-based `WeakSet` of minted principals: a
spread produces a new object, which can never be a member. Verified both the hand-built and the
spread forgery are now refused.

The lesson generalises past this branch: **a brand carried as a property is copyable; only object
identity is not.** Same family as the three fail-open guards already recorded — a check that tests
for the presence of a marker rather than the provenance of the object is not a check.
