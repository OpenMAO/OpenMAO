# ADR-0016: Contract Freeze Format

**Status:** Superseded by [ADR-0018](ADR-0018-typescript-canonical-runtime.md) for executable contracts
**Date:** 2026-05-28
**Owner:** Maintainer

---

> **Renumbered 2026-07-25.** This decision was authored as `docs/adr/0003-contract-freeze-format.md`
> on its stated date, deleted from the public tree in commit `09e3204` ("chore: clean public v0
> surface"), and restored from git history under ADR-0006. It was renumbered from ADR-0003 to
> ADR-0016 to resolve the identifier collision recorded as F16 in the diligence audit — three
> distinct accepted decisions shared the identifier "ADR-0003". Decision content and original date
> are unchanged; references to sibling technical ADRs were remapped to the new numbers.

## Context

OpenMAO v0 treats the canonical type system in `SPEC.md` Section 8 as the keystone for all
parallel implementation work. Builders need a freeze record that is easy to inspect in prose and
easy to verify in code, without inventing a second source of truth.

ADR-0018 moves the executable contract implementation from Python/Pydantic to TypeScript/Zod. The
contract-freeze intent of this ADR remains valid, but the implementation technology is superseded.

## Decision

The original Gate 1 contract freeze was recorded in two forms:

- this ADR, which records the public decision and change-control expectations;
- `schemas/canonical/v0.schema.json`, originally generated from the Pydantic models in
  `src/openmao/contracts/` and to be regenerated from TypeScript/Zod contracts after ADR-0018.

For the Python reference/prototype, Pydantic models remain the executable contract implementation.
For the canonical v0 implementation, TypeScript/Zod models will become the executable contract
implementation. The generated schema artifact is a review and compatibility artifact, not a
hand-edited source file.

## Consequences

Any future semantic contract change must update the TypeScript/Zod models, schema-valid fixtures,
contract tests, and generated schema artifact together. While the Python reference exists, ports
should also compare behavior against the Python contract tests. Changes that alter field names,
required fields, policy outcome vocabulary, run states, workspace identity, capability schema names,
or approval semantics require explicit maintainer approval before implementation agents proceed.

## Alternatives Considered

- Alternative: ADR only.
- Reason rejected: Good for maintainers, but weak for automated schema drift checks.
- Alternative: Generated schema only.
- Reason rejected: Good for tooling, but too opaque as a governance record.
- Alternative: Hand-written schema.
- Reason rejected: Creates a second editable contract surface that can drift from the executable
  contract models.

## Follow-Up

- [ ] Regenerate `schemas/canonical/v0.schema.json` from the TypeScript contract layer.
- [ ] Require tests to fail when the generated schema artifact drifts.
