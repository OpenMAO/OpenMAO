# Changelog

All notable public release changes for OpenMAO are documented here.

## Unreleased

Signed authority: per-principal cryptographic identity and signed governance decisions
([ADR-0020](docs/adr/ADR-0020-signed-authority.md)).

### Added

- Per-principal identity across every surface: principals, Ed25519 keys, credentials,
  enrolment attestations, and revocations are first-class stored rows. HTTP, console, and CLI
  all authenticate a per-principal credential; the actor on every event is resolved from it.
  The shared operator token and the self-asserted actor header are **deleted** — a presented
  actor header is rejected with 400, and the CLI's `--by` flag is a hard error naming the
  replacement.
- Signed governance decisions: approval approve/reject, autonomy widening ratification,
  org-change apply/revert, key enrolment and revocation, and chain-head attestations carry
  Ed25519 signatures over the RFC 7515 detached-JWS signing input — implemented on
  `node:crypto` with zero new runtime dependencies, so any JOSE-capable verifier can check
  them. Signing happens inside the state-transition transaction, verified against the signer's
  stored enrolled key before commit. Separation-of-duties guards now compare stable principal
  ids. The unsigned `actor === null` escape is deleted and `reject()` carries the same
  self-guard as `approve()`.
- Signed chain-head attestations (`openmao attest`): the operator key pins the event-chain head
  (sequence, hash, event count), and `verify-chain` re-verifies each surviving attestation's
  signature at read time, so truncation of the newest events is detected **relative to an
  attestation that survives or was exported**.
- Exportable chain evidence: `tsx scripts/export-chain-evidence.ts` emits an event-log slice
  plus its signed attestation and the signer's public key as one JSON bundle;
  `tsx scripts/verify-chain-evidence.ts` verifies it with no database. See
  [docs/CHAIN_EVIDENCE.md](docs/CHAIN_EVIDENCE.md).
- Signer custody through a broker that never returns key material; a root-of-trust ceremony
  (`openmao principals init`) establishes the first operator key at 0600/0700 file modes; a
  dev-bootstrap path keeps `make demo` one command while its signatures report
  `development_bootstrap` trust rather than production trust.
- The missing `WorkerCredentialStore.revoke()` and a fix for disabled-worker tokens still
  authenticating (worker identity status is re-checked on resolve).

### Honest scope — what this does not do

- Signing is **server-side**: a signature attests the substrate signed on presentation of the
  principal's credential — credential-strength, not individual non-repudiation. Device-held
  keys are not implemented.
- Direct write access to the SQLite file remains equivalent to root; chain attestation is
  tamper-evidence relative to a surviving or exported anchor, not tamper-resistance.
- Rotating a signing key voids the anchors it made (revocation is untimestamped, so
  verification fails closed); re-attest after rotation.
- The server remains loopback-only; the remote-access plan is written in
  [docs/DEPLOYMENT_MODES.md](docs/DEPLOYMENT_MODES.md) and deliberately unimplemented.
- Authority remains binary (principal vs worker): `AuthorityGrant`, quorum, and impact-gated
  approval authority (#94) are out of scope.
- No canonical contract fields were added and `SCHEMA_VERSION` stays 8, so existing databases
  and hash chains are unaffected.

### Verification

- `make check`
- `rm -rf .openmao && make demo && make demo-approve && make demo-deny && make verify-chain`
- `npm run cli -- attest`, then `tsx scripts/export-chain-evidence.ts /tmp/bundle.json` and
  `tsx scripts/verify-chain-evidence.ts /tmp/bundle.json` — the bundle verifies with no
  database access.

### Added (earlier in this cycle)

- Chief of Staff communication loop: a built-in, scheduled organizational agent that senses
  organization state on a cadence and reports evidence-backed observations to the operator, without
  taking any side effect. Sensors cover institutional-learning proposals, stale operational
  approvals, and a periodic status digest.
- `Cadence` (standing-obligation) and `Notification` contracts and SQLite stores. Cadences are
  organization-of-record objects, not agent-local state, so any worker can read or advance them.
- CLI (`cos init|tick|inbox|read`, `cadence list|add`) and HTTP/console surfaces (`POST /cos/tick`,
  `GET /cos/notifications`, `POST /cos/notifications/<id>/read`, `GET /cadences`, and a Chief of
  Staff inbox view).
- Every observation is attributed to the `chief_of_staff` actor and backed by a recorded event. The
  loop takes time as an explicit parameter and records it on a `cadence.fired` event, so it replays
  deterministically; timestamps are normalized to canonical second precision for correct due-checks.
- M0 causal instrumentation: events carry optional causal fields (`causal_parent_event_id`, consumed/produced refs) and the live work-lifecycle emitters populate them, so failures can be traced backward over real history rather than hand-built fixtures (#52, #59).
- M1 reversible apply: a transactional org-change apply engine with blast-radius caps, proposer/applier separation, evidence requirements, an audited kill-switch, post-apply verification, and revert with conflict detection. Honest scope: exactly one change type has a real applier today (`memory_cleanup` — retiring stale memory entries); all other change types still take a marker path that records the decision without changing behavior and is not revertible from the operator surface (#55; marker-path truth-in-status and revert semantics tracked in #105).
- M2 advisory heartbeat: a deterministic, report-only beat that senses via the Chief of Staff and delivers digests; it never applies changes or moves autonomy (#56).
- M3 advisory causal diagnosis: backward-trace over the M0 causal graph with a structural counterfactual score; emits `diagnosis.suggested` only and feeds no action by design (#57).
- M4 earned-autonomy mechanism: the dial widens only via a human-ratified, evidence-backed `AutonomyCase`, one step at a time, under a ceiling, after an audited track record; narrowing is always allowed. Honest scope: library + tests only — no CLI/API/console surface can yet propose or ratify a widening, so the dial does not move in a running deployment (#58; surface tracked with issues #70/#87 and PR #62).
- Idempotency-replay boundary locked loud-safe: replaying a legacy (pre-M0) event under an enriched emitter raises a typed conflict instead of silently duplicating; the one-time causal backfill for legacy rows is tracked as follow-up (commit 9c28e83, issue #109).

### Verification

- `make check`
- Deterministic local Chief of Staff smoke: `cos init` then `cos tick` seeds cadences, fires the
  sensors, and surfaces evidence-backed notifications; re-ticking at the same time is a no-op.
- Self-correction loop turn over the operator surface: two blocked work items -> `learning scan` (repeated_blocker) -> approve -> `learning apply`; documented limitation: the resulting marker application records a recommendation and is not revertible (`learning revert` reports no applied change) — tracked in #105.

## v0.5.0 - 2026-05-30

Makes institutional memory compound: knowledge accumulates with evidence and becomes reusable.

### Added

- Corroboration-based ratification: independent memory entries can corroborate a pending promotion as linked, auditable evidence. Each corroboration must come from a distinct actor (not the proposer) and a distinct, non-rejected/stale individual memory entry; it raises the ratified entry's confidence and can be required as a minimum bar. Human approval remains mandatory for every collective-memory write.
- Evidence-backed memory retrieval: a deterministic ranked search over stored memory that returns results with their evidence (confidence, corroboration count, source promotion). Confirmed-tier only; owned individual memory stays private to its owner; results are workspace-scoped.
- Operator surfaces: `memory search | list | corroborate` (CLI), `GET /memory/search` and an idempotent `POST /memory/promotions/:id/corroborate` (API), and a Memory Search console view with corroboration counts on promotions.
- World model: a `collective_memory` summary (kind, confidence, corroboration count) so operators can see the institutional-memory asset accumulating, derived as a rebuildable projection.

### Notes

- Corroboration recording is idempotent: re-submitting the same corroboration returns the existing record rather than double-counting. The API attributes a corroboration to the authenticated actor.

### Upgrade note

- This release adds the `Corroboration` model, a `promotion_corroborations` table, and a `collective_memory` field on the world-model snapshot. All additions are backward-compatible; a local `.openmao` database created before v0.5.0 keeps working.

### Verification

- `make check`
- `rm -rf .openmao && make demo && make demo-approve && rm -rf .openmao`

## v0.4.0 - 2026-05-29

Adds the first real, side-effecting capability provider behind OpenMAO authority.

### Added

- GitHub issue-comment provider: a real, side-effecting capability provider that creates a comment on a GitHub issue. The credential is resolved at execution time and sent only in the Authorization header; it never appears in capability calls, results, events, traces, or logs.
- Credential broker: an environment-backed broker resolves a non-secret `cred_*` handle to a secret inside provider code only. `Capability.credential_handle` binds a capability to a specific handle, and the gateway rejects a call whose handle does not match, so a worker cannot steer credential resolution to another configured secret.
- Async capability execution: providers may perform real network I/O. The gateway awaits provider execution outside the database transaction while preserving at-most-once execution through a durable node-effect guard plus an in-process in-flight join.
- Opt-in real-provider wiring: the GitHub provider is registered only when `OPENMAO_GITHUB_ENABLED=1` and `OPENMAO_CRED_GITHUB` is set. With no configuration the runtime is mock-only, so the default demo and CI need no credentials.

### Changed

- Side-effecting providers declare themselves so the side-effect / approval gate is enforced even if a capability is misregistered as non-side-effecting.
- The runtime secret guard also rejects GitHub fine-grained (`github_pat_`) tokens.

### Semantics

- OpenMAO guarantees at most one provider invocation per capability call, not remote exactly-once: if a request times out after GitHub created the comment but before OpenMAO records success, the call is recorded as failed even though the comment exists. Reconcile by inspecting the issue's comments before retrying.

### Upgrade note

- This release adds `Capability.credential_handle` and enforces capability-bound credentials. A local `.openmao` database created before v0.4.0 that holds a credential-requiring capability without the new field will block such calls; reset local state (`rm -rf .openmao`) or re-register the capability when upgrading. The default demos already reset local state.

### Verification

- `make check`
- `rm -rf .openmao && make demo && make demo-approve && rm -rf .openmao`
- `rm -rf .openmao && npm run cli -- worker demo && npm run cli -- approvals approve approval_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb && rm -rf .openmao`
- Optional, gated (real network, throwaway repo): `OPENMAO_GITHUB_ENABLED=1 OPENMAO_CRED_GITHUB=… ` drive a governed GitHub issue-comment capability end to end.

## v0.3.1 - 2026-05-29

Patch release for public documentation and clarity fixes after the v0.3.0 release.

### Fixed

- Added the missing `docs/POSITIONING.md` file linked from the README and docs index.
- Clarified repeated-blocker detector semantics in code comments.
- Clarified that `OrgChangeProposal.status = "pending"` is retained for compatibility while the
  service creates `proposed` proposals.

## v0.3.0 - 2026-05-29

Stable institutional learning loop release.

This promotes `v0.3.0-rc.1` after implementation checks, smoke verification, and independent QA,
Security, and Architecture review gates.

## v0.3.0-rc.1 - 2026-05-29

Release candidate for the institutional learning loop milestone.

### Added

- Institutional learning scan that detects repeated blockers, failed handoffs, approval bottlenecks, missing/disabled capabilities, and stale memory.
- Evidence-backed `OrgChangeProposal` lifecycle with proposal review approval, rejection, and explicit applied-marker events.
- CLI, API, console, and world-model visibility for learning proposals.
- Acceptance evidence at `docs/release/v0.3.0_acceptance_evidence.md`.

### Verification

- `make check`
- `rm -rf .openmao && make demo && make demo-approve && rm -rf .openmao`
- `rm -rf .openmao && npm run cli -- worker demo && npm run cli -- approvals approve approval_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb && rm -rf .openmao`
- deterministic local learning smoke: create repeated blockers, run `learning scan`, approve the generated proposal, mark it applied, and remove `.openmao`.

## v0.2.0-rc.1 - 2026-05-29

Release candidate for the enforced capability governance milestone.

### Added

- Enforced capability governance candidate.
- Framework-neutral reference worker demo with bounded work, approval-required side effect, outcome submission, ingestion, review, and world-model projection.
- External-worker capability gateway checks for worker identity, capability grants, provider availability, credential handles, approval, and at-most-once execution.
- API, CLI, and console surfaces for the external-worker flow, capability calls, and capability results.
- Acceptance evidence at `docs/release/v0.2.0-rc.1_acceptance_evidence.md`.

### Verification

- `make check`
- `rm -rf .openmao && make demo && make demo-approve && rm -rf .openmao`
- `rm -rf .openmao && npm run cli -- worker demo && npm run cli -- approvals approve approval_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb && rm -rf .openmao`

## v0.1.0 - 2026-05-29

First accepted OpenMAO release.

This promotes `v0.1.0-rc.2` after acceptance verification. It includes the deterministic local
runtime, canonical contracts, approval-gated execution and memory promotion, event/trace audit
records, rebuildable world model, CLI/API/operator console surfaces, and security reporting path.

## v0.1.0-rc.2 - 2026-05-29

Second public release candidate with review-blocker fixes.

### Changes

- Added high-risk capability enforcement: enabled high-risk calls now require approval before provider execution.
- Added a regression test for high-risk enabled capability approval.
- Fixed the operator console work table to display the canonical `owner` field.
- Enabled and documented GitHub private vulnerability reporting.
- Aligned public architecture and vocabulary docs with the implementation boundary and projection model.

### Verification

- `make check`
- `npm run hygiene:public`
- `rm -rf .openmao && make demo && make demo-approve && rm -rf .openmao`

## v0.1.0-rc.1 - 2026-05-29

First public release candidate for OpenMAO as an organizational substrate for AI-native work.

### Ships

- TypeScript runtime on Node.js 22.
- Zod canonical contracts with generated JSON Schema.
- SQLite persistence for workspace state, runs, checkpoints, events, traces, approvals, memory, and world model snapshots.
- Deterministic local demo with no external API keys, live LLM calls, hosted services, or networked tools.
- Two-agent governed handoff through the OpenMAO spine.
- Approval suspension and durable resume.
- Approval-gated collective memory promotion.
- Rebuildable world model projection.
- API, CLI, and minimal local operator console.
- Public hygiene checks for secrets and internal process leaks.

### Verification

- `make check`
- `npm run hygiene:public`
- `rm -rf .openmao && make demo && make demo-approve && rm -rf .openmao`

See [docs/release/v0.1.0_acceptance_evidence.md](docs/release/v0.1.0_acceptance_evidence.md) for the release-candidate evidence map.
