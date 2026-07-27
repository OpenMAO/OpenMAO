# OpenMAO Decisions

The index of every durable decision this project has accepted. The records themselves are in
[`docs/adr/`](docs/adr/README.md), public since 2026-07-25 under
[ADR-0006](docs/adr/ADR-0006-public-or-dead-governance-records.md).

## Rules

- ADRs are append-only once accepted. Supersede with a new ADR rather than rewriting history; where a
  record has gone stale, a dated publication note sits above the original text and the original text
  stays.
- Session notes may reference ADRs, but only ADRs define durable project decisions.
- If an implementation detail changes a frozen contract, record an ADR or an amendment before coding
  broadly.
- `NORTH_STAR.md` is the top of the precedence order. `SPEC.md`, which ADR-0001 named as the source
  of truth, was deleted before publication without a superseding ADR — an omission the 2026-06-10
  audit caught, and part of why ADR-0006 exists.

## Index

| ADR | Title | Status | Date |
| --- | --- | --- | --- |
| [ADR-0001](docs/adr/ADR-0001-source-of-truth-and-documentation-governance.md) | Source of Truth and Documentation Governance | Accepted | 2026-05-27 |
| [ADR-0002](docs/adr/ADR-0002-v0-build-topology-and-contract-freeze.md) | v0 Build Topology and Contract Freeze | Accepted | 2026-05-27 |
| [ADR-0003](docs/adr/ADR-0003-external-research-boundary.md) | External Research Boundary | Accepted | 2026-05-27 |
| [ADR-0004](docs/adr/ADR-0004-audit-governance-internal-and-independent-review.md) | Audit Governance: Internal and Independent Review | Accepted | 2026-05-27 |
| [ADR-0005](docs/adr/ADR-0005-public-documentation-and-open-source-hygiene.md) | Public Documentation and Open-Source Hygiene | Accepted | 2026-05-28 |
| [ADR-0006](docs/adr/ADR-0006-public-or-dead-governance-records.md) | Public-or-Dead Governance Records | Accepted — Option A | 2026-06-11 |
| [ADR-0007](docs/adr/ADR-0007-first-class-principals.md) | First-Class Principals at the Trust Boundary | Accepted | 2026-06-11 |
| [ADR-0008](docs/adr/ADR-0008-falsifiable-adoption-gate.md) | Falsifiable Adoption Gate | Accepted (amended) | 2026-06-11 |
| [ADR-0009](docs/adr/ADR-0009-truth-in-status-for-org-changes.md) | Truth-in-Status for Org Changes | Accepted | 2026-06-11 |
| [ADR-0010](docs/adr/ADR-0010-independent-review-terminology.md) | "Independent Review" Means a Non-Founder Human | Accepted | 2026-06-11 |
| [ADR-0011](docs/adr/ADR-0011-capability-scoping-and-delegation-model.md) | Capability Scoping and Delegation Model | Accepted — as direction | 2026-06-11 |
| [ADR-0012](docs/adr/ADR-0012-native-agent-first-work-management.md) | Native, Agent-First Work Management | Accepted | 2026-07-25 |
| [ADR-0013](docs/adr/ADR-0013-reconcilability-as-a-capability-property.md) | Reconcilability as a Declared Capability Property | Accepted | 2026-07-25 |
| [ADR-0014](docs/adr/ADR-0014-python-toolchain.md) | Python Toolchain | Superseded by ADR-0018 | 2026-05-28 |
| [ADR-0015](docs/adr/ADR-0015-ci-baseline.md) | CI Baseline | Superseded by ADR-0018 for canonical runtime checks | 2026-05-28 |
| [ADR-0016](docs/adr/ADR-0016-contract-freeze-format.md) | Contract Freeze Format | Superseded by ADR-0018 for executable contracts | 2026-05-28 |
| [ADR-0017](docs/adr/ADR-0017-control-layer-architecture.md) | Organizational Control Layer Architecture | Accepted | 2026-05-28 |
| [ADR-0018](docs/adr/ADR-0018-typescript-canonical-runtime.md) | TypeScript Canonical Runtime | Accepted | 2026-05-28 |
| [ADR-0019](docs/adr/ADR-0019-positioning-integration-and-openness.md) | Position OpenMAO at the Intersection of Integration and Openness | Accepted | 2026-05 |

**Numbering note.** ADR-0014 through ADR-0018 were authored as `docs/adr/0001-…0005-`, deleted from
the public tree in commit `09e3204`, restored from git history, and renumbered. ADR-0019 was authored
as a third "ADR-0003" and kept private as a strategy record. Renumbering ended the collision the
2026-06-10 audit recorded as F16, where three distinct accepted decisions shared one identifier.
Dates and content are unchanged; each renumbered record says what it used to be called.

## Accepted decisions in brief

1. `NORTH_STAR.md` sits at the top of the documentation precedence order; ADRs are the durable record
   of decisions, and changing one requires a new ADR.
2. v0 froze canonical contracts before parallel implementation began.
3. External projects may influence patterns only through bounded research briefs and OpenMAO-native
   translation; closed-source projects may inspire process and documentation style only.
4. OpenMAO is an organizational intelligence and control layer, not a full native agent runtime
   kernel.
5. TypeScript is the canonical runtime; the Python implementation was retained only as a reference
   and is superseded.
6. Governance records are public or the accountability claims that depend on them are retired. The
   line is privacy- and consent-based, never image-based.
7. Identity is bound at the trust boundary; autonomy is earned on audited evidence and is reversible.
8. Adoption is tested falsifiably against repository-observable evidence, with a single day-90
   decision point and a defined route back to active development.
9. A change type without a real applier cannot be reported as `applied`.
10. "Independent review" means a non-founder human. A second AI model is a dual-model audit pass.
11. The capability grant, not the underlying credential, is the unit of authority.
12. Work management is native and agent-first: delegable, governed, memory-feeding — and explicitly
    not a bid to match a dedicated project-management tool.

## Open decisions

- **ADR-0008:** name the candidate adopter. Day-0 was 2026-06-11.
- **ADR-0006:** Option A is ratified and now executed; it remains reversible to Option B, at the cost
  of materially weakening ADR-0008's public falsifiability.
- **ADR-0011:** decide the MCP per-tool binding question (#112) as the model's first application.

## Implementation status

- ADR-0007 → landed via #124 and #127 (approval integrity, per-worker tokens).
- ADR-0009 → landed via #125.
- ADR-0011 → target state only; contributor pull requests and ADR-0007-riding slices, no solo build
  until the adoption gate is decided.
- ADR-0012 → charter wording reconciled 2026-07-25; the console surfaces are ahead, and do not
  precede the Phase 1 acceptance criteria.
- ADR-0006 → executed 2026-07-25.
