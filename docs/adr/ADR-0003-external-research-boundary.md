# ADR-0003: External Research Boundary

**Status:** Accepted  
**Date:** 2026-05-27  
**Owner:** Human Product Owner / Lead / Contracts / Integration

---

## Context

OpenMAO may learn from public projects such as LangGraph, CrewAI, AG2/AutoGen, Hermes, Suna/Kortix, Paperclip, MetaGPT, and ChatDev. The SPEC allows influence but forbids cloning, vendoring, forking, embedding, or adopting foreign runtime APIs as OpenMAO contracts.

The user clarified that "borrow" or "influence" requires looking into projects first, but not copying code.

## Decision

Allow a bounded Researcher Agent only when the Human Product Owner approves a specific research question.

The Researcher Agent may inspect public documentation, READMEs, examples, and limited source references to answer that question.

The Researcher Agent must not:

- clone external repositories into OpenMAO;
- vendor, fork, embed, or copy external implementation code;
- introduce foreign public APIs into OpenMAO contracts;
- make an external framework an architectural authority;
- ask builders to implement from external source code.

Research output must be recorded as a brief under `docs/research/` using the research template.

## Consequences

- External research becomes useful without becoming dependency drift.
- Build agents receive OpenMAO-native pattern briefs, not foreign source-code tasks.
- The project can cite influence while preserving its native runtime boundary.

## Alternatives Considered

- Forbid all external research.
  - Rejected because it prevents useful pattern learning.
- Let implementation agents browse and borrow freely.
  - Rejected because it risks hidden framework leakage and accidental copying.

## Follow-Up

- [ ] Create `docs/research/` when the first approved research brief is needed.
- [ ] Require each brief to name the OpenMAO concern it fills.
