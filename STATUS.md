# OpenMAO Status

**Last updated:** 2026-07-25
**Current phase:** post-v0.5.0 — trust-minimum work landed; adoption gate running
**Current gate:** none. The v0 gate system was abandoned on 2026-05-28; see "Gate system outcome" below.
**Release target:** v0.6.0 — cut an honest CHANGELOG over the merged trust-minimum work. Under
ADR-0008 clause 4, no new milestones until the adoption gate is decided.

This file is public as of 2026-07-25, under
[ADR-0006](docs/adr/ADR-0006-public-or-dead-governance-records.md). It records the project's actual
state, including the parts that are unflattering. Operational mechanics that involve third parties —
correspondence, outreach, contributor names — stay private; nothing else does.

## Honest current state

- **Code:** `main` carries v0.5.0 plus the M0–M4 and wedge instrumentation, the LIMITATIONS and
  POSITIONING documentation pass, the five trust-minimum pull requests #124–#128 (merged in the order
  `102→101→105→113→120`), a persistence hardening fix (#129), and the reconcilability ADR and
  enforced-mode topology from issue #111 (#131) — the first work here shaped by external
  collaborators. Run `make check` for current lint, typecheck, and test results; this file
  deliberately does not restate counts it has not measured, because asserting untested numbers is one
  of the failures the 2026-06-10 audit found.
- **What is real:** the enforcement core — an in-process capability gateway with blocked-path tests,
  durable approvals with a restart-replay at-most-once proof, SQL-trigger append-only events,
  deterministic world-model rebuild, and approval-gated memory promotion with corroboration. This is
  the repository's verifiable asset.
- **What is not yet real:** the flywheel. Only one org-change applier exists (memory cleanup); other
  "applied" changes record a recommendation string rather than changing behavior, and ADR-0009's
  truth-in-status fix (#105/#125) exists to stop that being mislabeled. No path consumes memory into
  subsequent work, so "compounding" remains unproven.
- **Trust boundary:** improved but not finished. Per-worker tokens and approval integrity landed
  (#127, #124), closing the shared-token and proposer-equals-approver gaps that the audit recorded as
  F8 and F9. ADR-0011's capability scoping — ephemeral scoped credentials and attenuated delegation —
  remains target-state, deliberately gated behind the adoption gate rather than solo-built.
- **External demand:** effectively zero organic. Most stars arrived from a star/fork farm on
  2026-06-07 and should not be read as interest. The real signals are two external pull requests, one
  of them substantive and on-thesis, and a set of warm replies from outreach.
- **Console:** a redesign from read-only inspector toward an operator cockpit exists as a plan, a
  data-model specification, prototypes, and a first implementation wave. All of it was lost with a
  deleted git worktree and recovered from session transcripts on 2026-07-24; it is not yet merged.
  The loss went unnoticed for roughly seven weeks.

## Governance records (2026-07-25)

Under ADR-0006 Option A, the decision apparatus is now public: [`docs/adr/`](docs/adr/README.md)
holds all nineteen accepted ADRs, [`DECISIONS.md`](DECISIONS.md) indexes them, and the two audit
records behind them are published in redacted form in [`docs/audits/`](docs/audits/). Redaction
removes third-party identities and private-channel evidence only — no finding was softened. The
triple "ADR-0003" identifier collision recorded as audit finding F16 is resolved.

What stays private is unchanged in kind: session transcripts and notes, outreach material,
third-party correspondence, and the contents of `internal/`.

## Gate system outcome (recorded, not retconned)

The v0 gate and tracker system froze on 2026-05-28 at "Gate 6" and was never updated while v0.1.0
through v0.5.0 shipped, including past an unchecked "Human approval required for v0 release
candidate" checkbox. The releases were driven by a dual-model audit loop instead of the documented
gates. That is the factual outcome. The structural fixes are ADR-0006 (public-or-dead governance
records) and ADR-0010, which reserves the word "independent" for review by a non-founder human — a
bar this project has not yet met.

## Next actions (ordered)

1. **Answer the humans.** Review the open external pull requests and work the reply queue from
   outreach; several substantive replies, including one offer of a call, went unanswered for weeks.
   This has been the top-priority item since 2026-06-10 and remains it. Details are private.
2. **Land the recovered console work.** The Wave 1 implementation and the redesign documents are
   recovered but unpushed. Uncommitted work in a worktree is how they were lost the first time.
3. **Cut v0.6.0** with an honest CHANGELOG over the merged trust-minimum work.
4. **Adoption gate (ADR-0008).** Day-0 was 2026-06-11. Name the candidate adopter and post the
   tracking issue's first status update; the day-90 decision point is what it is.
5. **Housekeeping.** Remove the stray macOS " 2" duplicate files. Note that
   `check-public-hygiene` scans the git index, so it passes vacuously on a checkout whose index is
   damaged.

## Current risk register

| Risk | Status | Mitigation |
| --- | --- | --- |
| Burst-crash attention pattern; meta-work displacing market contact | Realized 2026-05-31..06-10 | ADR-0008 adoption gate; the "no new milestones" rule; the ordering above. This governance pass is itself the pattern's shape, run deliberately and timeboxed. |
| Warm contributor pipeline decays unanswered | Active, acute | Next action 1; a 48-hour response target on external pull requests. |
| Uncommitted work lost to deleted worktrees | Realized twice | Commit before a worktree dies. The 2026-07-24 recovery succeeded only because session transcripts survived — and three prototypes were unrecoverable because theirs had not. |
| Flywheel status inflation (`applied` markers that change nothing) | Active, partially mitigated | ADR-0009 landed via #125; the remaining applier gap is real. |
| Capability scoping: a handle over a broad long-lived credential is indirection, not scoping | Active | ADR-0011 as target state; implementation gated behind the adoption gate to avoid an over-build. |
| A hyperscaler claims the coding-CLI governance surface | Active since 2026-06-11 | Differentiation documented in LIMITATIONS and POSITIONING; the adapter lane is pre-named as the first post-gate milestone; interop-not-compete stance. |
| Public claims exceed public evidence | **Mitigated 2026-07-25** | ADR-0006 executed: governance records, decision index, status, and audit records are public. |
