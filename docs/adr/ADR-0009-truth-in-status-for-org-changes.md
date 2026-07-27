# ADR-0009: Truth-in-Status for Org Changes (Retire the Marker Path)

**Status:** Accepted (ratified 2026-06-11)
**Date:** 2026-06-10
**Proposed by:** External diligence audit, converged Claude (Fable 5) + GPT-5.5/Codex pass (see `../audits/2026-06-10-diligence-audit-public-record.md`)
**Owner:** Human Product Owner

---

> **Publication note (2026-07-25).** Provenance links point to the public audit records; the
> unredacted internal versions stay private because they name third parties who did not consent.
> Redaction is limited to identities and private-channel evidence — every finding, caveat, and
> criticism is published. Decision content below is unchanged.

> **Ratified 2026-06-11** by the Human Product Owner, on the converged diligence audit (Claude + GPT-5.5) plus an independent Fable 5 second opinion (UNISON-WITH-CAVEATS). Durable record: `../audits/2026-06-11-adr-ratification-public-record.md`. Implementation in progress: branch `claude/issue-105-truth-in-status` (#105).

## Context

Exactly one org-change type has a real applier (`memoryCleanupApplier`, `ts/src/org/apply.ts:77-88`). Every other change type takes the legacy marker path (`ts/src/org/changes.ts:180-223`): the proposal's status flips to `applied`, an `org_change.applied` event is emitted (with `applied_as_marker_only: true`), and **nothing changes** — the "patch" is a hardcoded recommendation string. Executed verification (2026-06-10) showed the only operator-reachable loop turn (repeated_blocker → approve → apply) produces such a marker, and `learning revert` then fails with "no applied change found" because marker applications record no `OrgChangeApplication`.

NORTH_STAR.md:66 — self-correction "must never become a cosmetic retry loop. It must change future behavior." A status named `applied` that changes nothing, and cannot be reverted, is status inflation at the heart of the flywheel.

## Decision

An org change's recorded status must match its real effect:

1. A change type without a registered applier **cannot reach `applied`**. Marker-path outcomes are renamed to an honest terminal status (e.g. `acknowledged`), distinct in contracts, events, world model, and operator surfaces.
2. Every status that `apply` can produce has a defined revert semantics: real applications revert through the engine; `acknowledged` records are withdrawable (and `learning revert` says so, rather than erroring).
3. `applied`/`verified` counts used as autonomy track-record evidence (M4) count only real applier output — `acknowledged` markers never feed the dial.
4. New change types graduate from `acknowledged` to `applied` only by shipping an applier with plan/inspect/apply/revert and tests, per the existing `ChangeApplier` contract.

## Consequences

- CHANGELOG/README language about "self-correction loop turns" becomes verifiable: a turn is closed only when behavior actually changed reversibly.
- The M4 track record stops being inflatable by recommendation markers.
- Some current "applied" rows become historically mislabeled; a one-time migration relabels marker applications.

## Alternatives Considered

- Keep the marker path as-is for continuity. Rejected: it is the audited counterexample to the charter's own "must never become" clause.
- Block apply entirely for applier-less types with no acknowledged state. Rejected: recording a ratified recommendation has audit value; it just must not be called `applied`.

## Follow-Up

- [ ] Contracts + persistence migration for the `acknowledged` status and marker relabeling.
- [ ] Fix or redefine `learning revert` for acknowledged records.
- [ ] Exclude markers from autonomy track-record counting; add tests for all three.
