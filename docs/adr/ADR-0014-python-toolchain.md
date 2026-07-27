# ADR-0014: Python Toolchain

**Status:** Superseded by [ADR-0018](ADR-0018-typescript-canonical-runtime.md)
**Date:** 2026-05-28
**Owner:** Maintainer

---

> **Renumbered 2026-07-25.** This decision was authored as `docs/adr/0001-python-toolchain.md`
> on its stated date, deleted from the public tree in commit `09e3204` ("chore: clean public v0
> surface"), and restored from git history under ADR-0006. It was renumbered from ADR-0001 to
> ADR-0014 to resolve the identifier collision recorded as F16 in the diligence audit — three
> distinct accepted decisions shared the identifier "ADR-0003". Decision content and original date
> are unchanged; references to sibling technical ADRs were remapped to the new numbers.

## Context

OpenMAO v0 originally needed a Python package scaffold, dependency manager, repeatable local
commands, linting, type checking, tests, and CI. The earlier spec required Python 3.12+, Pydantic
v2, FastAPI, SQLite, pytest, and a local-first demo that did not require external credentials.

ADR-0018 supersedes this toolchain for canonical v0 implementation. The Python implementation
remains an executable reference/prototype, not the canonical runtime.

## Decision

For the Python reference/prototype, use `uv` with `pyproject.toml` as the package and dependency
workflow. The default Python version for CI and local bootstrapping is Python 3.12. Use:

- Pydantic v2 for contracts;
- FastAPI for the API;
- Typer for the CLI;
- pytest for tests;
- ruff for linting and formatting;
- mypy for type checking;
- `make` wrappers for common local commands.

## Consequences

The Python reference has one fast local install path: `make install`. Its quality gates run through
`make check`. Future canonical implementation gates move to TypeScript per ADR-0018 while preserving
the same service-boundary lessons.

## Alternatives Considered

- Alternative: Poetry.
- Reason rejected: More workflow surface than v0 needs.
- Alternative: Hatch-only environment workflow.
- Reason rejected: `uv` gives simpler, faster dependency resolution and lockfile generation.
- Alternative: Plain `pip` and `venv`.
- Reason rejected: Less reproducible for contributors and CI.

## Follow-Up

- [ ] Keep dependency additions narrow and tied to SPEC.md gates.
- [ ] Revisit tooling only if it blocks public contribution or release acceptance.
