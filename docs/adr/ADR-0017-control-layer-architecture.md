# ADR-0017: Organizational Control Layer Architecture

**Status:** Accepted
**Date:** 2026-05-28
**Owner:** Maintainer

---

> **Renumbered 2026-07-25.** This decision was authored as `docs/adr/0004-control-layer-architecture.md`
> on its stated date, deleted from the public tree in commit `09e3204` ("chore: clean public v0
> surface"), and restored from git history under ADR-0006. It was renumbered from ADR-0004 to
> ADR-0017 to resolve the identifier collision recorded as F16 in the diligence audit — three
> distinct accepted decisions shared the identifier "ADR-0003". Decision content and original date
> are unchanged; references to sibling technical ADRs were remapped to the new numbers.

## Context

Early v0 planning described OpenMAO as a native agent runtime kernel. That framing helped clarify
contracts, approvals, events, memory promotion, persistence, and world-model semantics, but it risks
turning OpenMAO into another full agent framework.

The product direction is now Option B: OpenMAO is the organizational intelligence and control layer
for AI-native organizations. Agent execution mechanics may be delegated to governed workers and
capabilities, including Hermes, OpenClaw, CrewAI, LangGraph, custom agents, MCP tools, or local mock
workers.

## Decision

OpenMAO owns organizational truth, not every execution loop.

OpenMAO remains authoritative for:

- organization, role, agent, work, capability, policy, approval, memory, event, trace, and world-model
  semantics;
- authority and permission checks;
- approval state and approval-gated suspension/resume;
- collective-memory promotion;
- audit/event semantics;
- the rebuildable world model;
- the source-of-truth persistence boundary.

External runtimes may execute work only through OpenMAO-governed worker/capability adapters. They may
produce artifacts, proposed memory, status updates, and events for OpenMAO to validate and persist.
They must not become the source of organizational truth, bypass policy, mutate collective memory
directly, own approval state, or replace OpenMAO's event semantics.

ADR-0018 supersedes ADR-0014 for canonical implementation language. The deterministic local demo can
use native mock workers, but those workers are a reference adapter path for proving control
semantics, not a commitment to rebuild all agent execution systems inside OpenMAO.

## Consequences

- The v0 architecture should be described as a control-plane walking skeleton.
- The `spine` is the organizational control spine: it owns state transitions, checkpoints, policy
  gates, approvals, events, traces, and world-model updates.
- Worker execution can be native, mocked, or delegated, but all side effects must return through
  OpenMAO services.
- Future integration work should add governed worker/capability adapters rather than deep runtime
  forks or cloned framework internals.
- Public documentation must not imply that OpenMAO is trying to replace LangGraph, CrewAI, Hermes,
  OpenClaw, MCP, or custom agent systems.

## Alternatives Considered

- Alternative: Full native agent runtime kernel.
- Reason rejected: It creates unnecessary competition with existing agent systems and pushes OpenMAO
  toward execution mechanics instead of organizational accountability.
- Alternative: Thin adapter hub over external runtimes.
- Reason rejected: It would make external runtimes semantic authorities and weaken OpenMAO's policy,
  approval, memory, audit, and world-model guarantees.

## Follow-Up

- [x] Update `SPEC.md` language from native runtime kernel to control layer.
- [ ] Define the first explicit governed worker adapter contract before adding real external runtime
      execution.
- [ ] Keep the default v0 demo local, deterministic, and credential-free.
