# ADR-0018: TypeScript Canonical Runtime

**Status:** Accepted
**Date:** 2026-05-28
**Owner:** Maintainer

---

> **Renumbered 2026-07-25.** This decision was authored as `docs/adr/0005-typescript-canonical-runtime.md`
> on its stated date, deleted from the public tree in commit `09e3204` ("chore: clean public v0
> surface"), and restored from git history under ADR-0006. It was renumbered from ADR-0005 to
> ADR-0018 to resolve the identifier collision recorded as F16 in the diligence audit — three
> distinct accepted decisions shared the identifier "ADR-0003". Decision content and original date
> are unchanged; references to sibling technical ADRs were remapped to the new numbers.

## Context

ADR-0017 reframed OpenMAO as the organizational intelligence and control layer for AI-native
organizations. Under that Option B direction, OpenMAO's adoption path is developer-facing and
product-layer oriented rather than a Python-native backend kernel.

The intended wedge now includes npm distribution, Vercel deployment paths, MCP integration,
web-native operator surfaces, and dogfooding from TypeScript AI applications. Python remains useful
as an executable reference for the already-proven contracts and control semantics, but it is no
longer the best canonical implementation target.

## Decision

TypeScript is the canonical runtime for OpenMAO v0.

Use:

- TypeScript 5.x for the source language;
- Node.js 22 LTS as the default local runtime;
- Zod as the executable contract/schema layer;
- generated JSON Schema as the portable contract artifact;
- SQLite for local-first persistence;
- a lightweight TypeScript HTTP server/API layer;
- a TypeScript CLI;
- Vitest for tests;
- pnpm/npm-compatible package scripts for install, check, demo, and console commands.

The current Python implementation is preserved as an executable reference/prototype for:

- canonical contracts and schema intent;
- service boundaries;
- event semantics;
- workspace-scoped persistence;
- approval suspension/resume;
- memory promotion;
- world-model projection;
- deterministic demo behavior;
- acceptance and security test ideas.

It must not continue to expand as the canonical v0 implementation.

## Consequences

- ADR-0014 is superseded for canonical v0 runtime/toolchain decisions.
- ADR-0016 is superseded for the executable contract implementation, but its contract-freeze intent
  remains valid.
- `SPEC.md` must treat Pydantic/Python syntax as reference history only; canonical contracts should
  move to TypeScript/Zod plus generated JSON Schema.
- Future implementation work should port the proven Python behaviors into TypeScript rather than
  continuing Python gates.
- Independent review should evaluate the TypeScript implementation before v0 acceptance.

## Alternatives Considered

- Alternative: Continue Python for v0 and revisit TypeScript after release.
- Reason rejected: The cost of switching rises after v0 hardens, and Option B's adoption path is
  TypeScript-native.
- Alternative: Keep Python core and generate a TypeScript SDK.
- Reason rejected: OpenMAO is an embedded product/control layer where developers author
  organization logic; a generated SDK would make TypeScript a second-class authoring experience.
- Alternative: Maintain Python and TypeScript canonical implementations in parallel.
- Reason rejected: Too much contract drift risk for v0.

## Follow-Up

- [ ] Port canonical contracts from Pydantic models to TypeScript/Zod.
- [ ] Generate `schemas/canonical/v0.schema.json` from the TypeScript contract layer.
- [ ] Port persistence, approvals, capability, memory, world-model, API, CLI, console, and demo
      behavior from the Python reference.
- [ ] Re-run QA, Security, and Architecture release reviews on the TypeScript implementation.
