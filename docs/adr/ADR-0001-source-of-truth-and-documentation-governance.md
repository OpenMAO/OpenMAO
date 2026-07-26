# ADR-0001: Source of Truth and Documentation Governance

**Status:** Accepted  
**Date:** 2026-05-27  
**Owner:** Human Product Owner / Lead / Contracts / Integration

---

> **Publication note (2026-07-25).** The paths below describe the layout as it stood in May 2026 and
> are left unrewritten, per this ADR's own append-only rule. Two have since changed: ADRs now live in
> the tracked `docs/adr/`, not the private `decisions/`, and `SPEC.md` was deleted before publication
> without a superseding ADR — an omission the diligence audit caught and ADR-0006 resolved. The
> current precedence order names `NORTH_STAR.md` first.

## Context

OpenMAO is beginning from a high-context planning process: audited SPEC versions, a refined build plan, agent topology decisions, and audit-governance decisions. If these remain only in chat, future implementation agents will re-litigate settled questions or silently drift.

The repo needs a documentation system before implementation begins.

## Decision

Adopt the following documentation structure:

- `SPEC.md` is the canonical product and architecture source for v0.
- `BUILD_PLAN.md` is the canonical build-process source for v0.
- `STATUS.md` records current phase, gate, risks, and next actions.
- `DECISIONS.md` indexes accepted and pending decisions.
- `decisions/ADR-*.md` stores durable decisions.
- `sessions/*.md` stores chronological work/session records.
- `docs/templates/` stores reusable templates.
- `docs/research/` stores approved bounded research briefs.
- `docs/audits/` stores internal and independent review reports.

Source precedence:

1. `SPEC.md`
2. `BUILD_PLAN.md`
3. accepted ADRs in `DECISIONS.md` / `decisions/`
4. `STATUS.md`
5. session notes and audit reports
6. inline comments and agent suggestions

Session notes are historical evidence. ADRs are policy.

## Consequences

- Future agents have a stable entry path into the project.
- Decisions become durable and reviewable.
- Implementation can start with less risk of scope drift.
- Changing an accepted decision requires a new ADR or explicit supersession.

## Alternatives Considered

- Keep decisions only in chat history.
  - Rejected because future agents may not have full conversational context.
- Put all decisions in `BUILD_PLAN.md`.
  - Rejected because build-plan edits would mix stable policy with live execution state.

## Follow-Up

- [ ] Update `STATUS.md` at each gate.
- [ ] Add session notes for major implementation and audit turns.
- [ ] Add audit reports under `docs/audits/` once code work starts.
