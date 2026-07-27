# ADR-0004: Audit Governance: Internal and Independent Review

**Status:** Accepted  
**Date:** 2026-05-27  
**Owner:** Human Product Owner / Lead / Contracts / Integration

---

## Context

The project needs two layers of audit:

1. implementation agents should not hand off unchecked work;
2. release gates still need independent QA, Security, and Architecture review.

The user proposed that each implementation agent run `/ship-with-audit` on its own work as an internal departmental audit before handing work to Lead / Integration.

The Codex `$ship-with-audit` skill was created as local operator tooling. It flips an existing Claude Code workflow: current Codex implements, then a fresh GPT-5.5 Codex session and a separate Claude session audit the diff.

## Decision

Require each implementation agent to run internal `$ship-with-audit` before handing work to Lead / Integration.

Internal implementation audit requirements:

- use a fresh GPT-5.5 Codex audit surface;
- use a separate Claude audit surface;
- auditors are read-only;
- merge findings by union, not intersection;
- resolve all in-scope P0/P1/P2 findings before handoff;
- document deferred P3 or out-of-scope items;
- include the audit summary in the implementation handoff.

Lead / Integration must also run `$ship-with-audit` after combining slices when integration changes are non-trivial.

Internal audits do not satisfy independent review gates. QA, Security, and Architecture auditors remain separate release-blocking reviewers.

## Consequences

- Implementation streams catch local issues earlier.
- Lead / Integration receives higher-quality slices.
- Independent auditors can focus on cross-system correctness, security, and architecture rather than obvious local bugs.
- Governance remains clear: internal departmental audit is not independent release approval.

## Alternatives Considered

- Only run QA/Security/Architecture review at the end.
  - Rejected because late findings are more expensive and cross-module bugs become harder to isolate.
- Count each implementation agent's internal audit as independent review.
  - Rejected because the implementation stream still owns the work and fix decisions.

## Follow-Up

- [ ] Patch `BUILD_PLAN.md` with internal handoff audit rules.
- [ ] Add audit report templates for implementation handoffs.
- [ ] Create `docs/audits/` reports once implementation begins.
