# ADR-0015: CI Baseline

**Status:** Superseded by [ADR-0018](ADR-0018-typescript-canonical-runtime.md) for canonical runtime checks
**Date:** 2026-05-28
**Owner:** Maintainer

---

> **Renumbered 2026-07-25.** This decision was authored as `docs/adr/0002-ci-baseline.md`
> on its stated date, deleted from the public tree in commit `09e3204` ("chore: clean public v0
> surface"), and restored from git history under ADR-0006. It was renumbered from ADR-0002 to
> ADR-0015 to resolve the identifier collision recorded as F16 in the diligence audit — three
> distinct accepted decisions shared the identifier "ADR-0003". Decision content and original date
> are unchanged; references to sibling technical ADRs were remapped to the new numbers.

## Context

OpenMAO is private until v0 release acceptance, but public release needs a clear quality baseline.
The project also needs to avoid maintainer-only workflow leaking into public contribution docs.

## Decision

Start CI with the same checks contributors run locally through `make check`:

- `ruff check .`
- `mypy src tests`
- `pytest`

CI runs on pull requests and pushes to `main`. Secret scanning, docs link checks, coverage gates,
and release automation are deferred until the implementation surface exists.

ADR-0018 moves canonical v0 implementation to TypeScript. This CI baseline remains useful for the
Python reference/prototype, but canonical CI must be replaced by TypeScript lint, typecheck, and
Vitest gates.

## Consequences

The baseline protects code style, typing, and behavior without pretending the v0 repo has release
infrastructure yet. New gates may add CI jobs only when they protect a real implemented surface.

## Alternatives Considered

- Alternative: Add secret scanning immediately.
- Reason rejected: Useful before public release, but better added once config and env examples exist.
- Alternative: Add docs link checks immediately.
- Reason rejected: Low value while docs are local-only markdown with few external links.
- Alternative: No CI until v0 is complete.
- Reason rejected: Too easy for scaffold regressions to accumulate.

## Follow-Up

- [ ] Add secret scanning before public visibility.
- [ ] Add docs link checks before public visibility if docs gain external references.
- [ ] Consider coverage gates after core services are implemented.
