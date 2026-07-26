# GOAL — Signed Authority (identity + cryptographic signing)

> A resuming session has **no conversation history**. This file plus the rest of `.goal/` and the
> committed tree is the entire memory. Read it fully before acting.

## objective

Give OpenMAO real per-principal cryptographic identity and signed governance decisions, replacing a
shared bearer token plus a self-asserted `x-openmao-actor` header. Ed25519 via `node:crypto`, signed
using the **RFC 7515 detached-JWS signing input**, with **zero new runtime dependencies**. Framed as
execution of ADR-0007 (first-class principals) and as evidence for the ADR-0008 adoption gate.

Full approved plan: `.goal/PLAN.md` (committed beside this file). It is authoritative for design
detail; this file is authoritative for loop control.

## topology (role → model)

| Role | Model | Notes |
|---|---|---|
| driver | Claude (the cron session) | runs the Turn Cycle each tick |
| architect | Claude (same session) | milestone sequencing, replanning, tradeoffs |
| executors | **K3** (`k3-worker`) | writes all code |
| auditors | **GPT-5.6-sol** (`gpt-worker`) | read-only review; MUST NOT edit |
| judge | Claude (the driver) | adjudicates auditor-vs-executor disagreement on cited evidence |

**Cross-family rule:** the auditor family (GPT) must never be the executor family (K3). If K3 is
unavailable, do **not** substitute GPT as executor and keep GPT as auditor — that destroys
independence. Pause and flag instead.

## permissions (operator-granted 2026-07-26)

GRANTED: create branches, commit, push branches, open PRs. Run tests/build/lint freely. Read anything.

**DENIED — the loop must never do these:**
- merge anything to `main` (branch-protected; the operator merges)
- reply to, comment on, or close **external** contributors' PRs/issues (e.g. PR #99 by `yarikoptic`,
  issue #123 by `ralyodio`) — these are messages in the operator's voice
- comment on or close the operator's own PRs/issues (not granted this run)
- modify CI workflows (`.github/`), branch protection, or repo settings
- force-push, rebase away, or otherwise destroy existing commits

## scope_guards (do NOT touch)

- `ts/src/persistence/serialization.ts` — `dumpJson` is the hardened canonicalizer (#129). Sign
  **over** it; do not modify it.
- `EventSchema`, `EventPayloadSchema`, `ExternalActorRefSchema` in `ts/src/contracts/models.ts` —
  **adding any field silently breaks every already-chained event** (verified: re-parse materialises
  defaulted keys, changing the recomputed hash; every existing test builds a fresh DB so none catch
  it). **This branch adds ZERO canonical contract fields.** No `principal_id` on the actor ref, no
  `resolved_by` on approvals, no schema regeneration, no fixture change.
- `ts/src/persistence/checkpoints.ts` — already exists (run-resumption checkpoints). Chain
  attestations go in a **differently named** module/table.
- ADR-0011 capability scoping, `AuthorityGrant`/quorum (#94), remote/TLS surface — explicitly out.
- `sessions/`, `internal/`, private audit records (only redacted `*-public-record.md` files are ever published) — private, never publish.

## budget (countable caps only)

- `ticks`: **24**
- `wall_clock_hours`: **12**
- `max_iterations_per_milestone`: **3** (+1 regression extension)
- `max_resumes_without_progress`: **3**

At any cap → **clean-pause**: write `.goal/HANDOFF.md`, push, disable the routine, stop.

## state_paths

- `.goal/GOAL.md` (this file) · `.goal/PLAN.md` (approved design) · `.goal/PROGRESS.md` (milestone log)
- `.goal/baseline.json` · `.goal/ledger.json` · `.goal/event-log.jsonl` · `.goal/control.json`
- `.goal/HANDOFF.md` (written on any terminal state)

## milestones

Sequenced. Each ends green (`make check`) and is a reviewable commit. **Node 25 required** —
`export PATH="/opt/homebrew/opt/node@25/bin:$PATH"`; default Node 22 false-reds the whole suite via a
better-sqlite3 ABI mismatch (NODE_MODULE_VERSION 141 vs 127).

| # | Milestone | risk_tier | Gist |
|---|---|---|---|
| M1 | Crypto core | high | `signing.ts` (detached-JWS signing input, domain-tag table, verifier), `signing-broker.ts` (`sign(handle,bytes)` — never returns a key), sensitive-material extension, **17 negative vectors** pinned as a test |
| M2 | Identity storage | high | 6 tables + stores (principals, keys, credentials, attestations, revocations, signatures) + `PrincipalAuthService` + key revocation + the missing `WorkerCredentialStore.revoke()` and the `WorkerIdentity.status` re-check bug |
| M3 | Custody + bootstrap | high | signer implementations across the custody matrix, root-of-trust ceremony, profile/token persistence, CLI call sites behind one `AuthenticatedPrincipal` abstraction |
| M3a | Console extraction | low | move inline console HTML to its own module — pure move, no behaviour change |
| M4 | Atomic cutover | high | `authenticateContext`; actor header **rejected 400**; `/ingestion` body-actor closed; console + CLI + HTTP migrate together; legacy token path deleted **in this wave** |
| M5 | Signed decisions | high | signatures on approve/reject/ratify/apply inside the state-transition txn; **delete the `actor === null` escape**; add the missing `reject()` self-guard |
| M6 | Chain attestations | high | attestation table + triggers, `verifyChain` truncation arm, **chain-durability-across-schema-evolution test** |
| M7 | Docs + evidence | low | ADR-0020, LIMITATIONS truth-up, deployment modes + remote-access plan, CHANGELOG |

**Ordering is a correctness constraint, not a preference:** no green commit may contain a privileged
*unsigned* compatibility path, which forces M4 to cut HTTP+console+CLI together and forces M3 to land
first. M5's deletion is only safe once M3+M4 supply a principal everywhere.

## done_criteria

Verified as a **delta from `.goal/baseline.json`** — a criterion green at baseline can never count.

| id | verify_command | expect | tier |
|---|---|---|---|
| make_check_green | `make check` (Node 25) | exit 0 **and test count > 329** | high |
| signing_module | `test -e ts/src/security/signing.ts` | exists (absent at baseline) | high |
| signing_broker | `test -e ts/src/security/signing-broker.ts` | exists; grep proves no API returns a private key | high |
| negative_vectors | vector suite runs | ≥17 negative cases, each a typed failure — never `true`, never a throw | high |
| principal_stores | `test -e ts/src/persistence/principals.ts` | exists | high |
| worker_revoke | `grep -c 'revoke(' ts/src/persistence/worker-credentials.ts` | ≥1 (0 at baseline) | high |
| null_escape_gone | `grep -c 'actor === null' ts/src/governance/approvals.ts` | 0 (1 at baseline) | high |
| reject_guard | reject-self test present and passing | new test | high |
| actor_header_rejected | spoof test: actor header → 400 | new test | high |
| chain_durability | pre-existing-DB re-parse test | passes | high |
| artifact_relevance | — | diffs touch the named modules, not just tests | — |

**Goal-level done** = every row above satisfied **and** every milestone accepted **and** a PR open for
the work. Anything less at budget exhaustion is a **clean-pause**, not a done.

## Turn Cycle reminders specific to this goal

1. **Precondition each tick:** `git fetch origin`. PR #133 (ADR publication) must be merged before M7
   cites `docs/adr/` paths; if `origin/main` has moved, merge it into `claude/signed-authority` before
   working. Never rebase away commits.
2. **Three traps that fail silently** — put these in every executor brief:
   - signed bodies take timestamps **from the stored row**, never `utcNow()` (breaks replay + the
     "replays already approved approvals" test);
   - separation of duties compares **stable principal ids**, never key ids (rotation would defeat it);
   - **no field may be added** to the event/payload/actor-ref schemas (see scope_guards).
3. **Signatures live in a sibling table**, never in an event payload — the approval event embeds the
   whole approval object, so contract-level signature fields would land inside the payload.
4. Auditor is read-only. If GPT edits code, reject the audit and re-run it.
