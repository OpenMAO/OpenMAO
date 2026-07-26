# ADR-0002: v0 Build Topology and Contract Freeze

**Status:** Accepted  
**Date:** 2026-05-27  
**Owner:** Human Product Owner / Lead / Contracts / Integration

---

## Context

OpenMAO v0 is small enough to build quickly, but tightly coupled around canonical contracts, event semantics, approval suspension, idempotency, and projection rules. Too many parallel builders before the contracts are frozen would increase drift risk.

The planning process compared a broad role-catalogue build plan with a lean concern-owned implementation topology.

## Decision

Use the lean topology in `BUILD_PLAN.md`:

1. Phase 0 uses one Lead / Contracts / Integration agent.
2. The Lead freezes canonical contracts before parallel implementation.
3. After Gate 1, four implementation streams may proceed:
   - Persistence / Events / Checkpoints
   - Org / Governance / Capabilities
   - Spine / Agents / Demo Flow
   - Memory / API / CLI / Console
4. QA, Security, and Architecture review remain independent of implementation streams.

The contract freeze is mandatory. Broad implementation cannot begin until Gate 1 passes.

## Consequences

- Parallel work starts later but with lower drift risk.
- Concern ownership mirrors OpenMAO's "one owner per concern" invariant.
- Independent review capacity is preserved for release-blocking audit rather than routine implementation work.

## Alternatives Considered

- Full software-organization topology: PM, project manager, architect, backend, frontend, QA, DevOps, docs, security.
  - Rejected for v0 because it creates coordination overhead before the contracts exist.
- Single-agent implementation for all v0.
  - Rejected after Gate 1 because four concern streams can proceed safely once contracts are frozen.

## Follow-Up

- [ ] Gate 0: create module ownership map.
- [ ] Gate 1: freeze canonical models and record the freeze.
- [ ] After Gate 1: fan out only within the four approved implementation streams.
