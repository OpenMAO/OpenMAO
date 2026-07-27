# Architecture Decision Records

Accepted decisions that shape OpenMAO's contracts, governance, and architecture. Each ADR states its
context, the decision, the consequences, and the alternatives rejected — so a change of course later
is a recorded reversal, not a silent drift.

That includes the decisions that went badly. This directory became fully public on 2026-07-25 under
[ADR-0006](ADR-0006-public-or-dead-governance-records.md), which holds that a project selling
accountable AI organizations cannot keep its own accountability layer private.

[`../../DECISIONS.md`](../../DECISIONS.md) is the index with statuses and dates. Session notes may
reference ADRs, but only ADRs define durable decisions.

## Index

| ADR | Title | Status |
| --- | --- | --- |
| [ADR-0001](./ADR-0001-source-of-truth-and-documentation-governance.md) | Source of truth and documentation governance | Accepted |
| [ADR-0002](./ADR-0002-v0-build-topology-and-contract-freeze.md) | v0 build topology and contract freeze | Accepted |
| [ADR-0003](./ADR-0003-external-research-boundary.md) | External research boundary | Accepted |
| [ADR-0004](./ADR-0004-audit-governance-internal-and-independent-review.md) | Audit governance: internal and independent review | Accepted |
| [ADR-0005](./ADR-0005-public-documentation-and-open-source-hygiene.md) | Public documentation and open-source hygiene | Accepted |
| [ADR-0006](./ADR-0006-public-or-dead-governance-records.md) | Public-or-dead governance records | Accepted — Option A (ratified 2026-06-11; reversible to B) |
| [ADR-0007](./ADR-0007-first-class-principals.md) | First-class principals at the trust boundary | Accepted (ratified 2026-06-11) |
| [ADR-0008](./ADR-0008-falsifiable-adoption-gate.md) | Falsifiable adoption gate | Accepted (ratified 2026-06-11, amended; day-0 = 2026-06-11) |
| [ADR-0009](./ADR-0009-truth-in-status-for-org-changes.md) | Truth-in-status for org changes | Accepted (ratified 2026-06-11) |
| [ADR-0010](./ADR-0010-independent-review-terminology.md) | "Independent review" means a non-founder human | Accepted (ratified 2026-06-11) |
| [ADR-0011](./ADR-0011-capability-scoping-and-delegation-model.md) | Capability scoping and delegation model | Accepted — as direction (ratified 2026-06-11; implementation gated by ADR-0008) |
| [ADR-0012](./ADR-0012-native-agent-first-work-management.md) | Native, agent-first work management | Accepted (ratified 2026-07-25) |
| [ADR-0013](./ADR-0013-reconcilability-as-a-capability-property.md) | Reconcilability as a declared capability property | Accepted (ratified 2026-07-25; revision 1 same day) |
| [ADR-0014](./ADR-0014-python-toolchain.md) | Python toolchain | Superseded by ADR-0018 |
| [ADR-0015](./ADR-0015-ci-baseline.md) | CI baseline | Superseded by ADR-0018 for canonical runtime checks |
| [ADR-0016](./ADR-0016-contract-freeze-format.md) | Contract freeze format | Superseded by ADR-0018 for executable contracts |
| [ADR-0017](./ADR-0017-control-layer-architecture.md) | Organizational control layer architecture | Accepted |
| [ADR-0018](./ADR-0018-typescript-canonical-runtime.md) | TypeScript canonical runtime | Accepted |
| [ADR-0019](./ADR-0019-positioning-integration-and-openness.md) | Position OpenMAO at the intersection of integration and openness | Accepted |
| [ADR-0020](./ADR-0020-signed-authority.md) | Signed authority — Ed25519 signatures over bound identity | Accepted (2026-07-27) |

## Rules

- **Append-only once accepted.** Supersede with a new ADR rather than rewriting history. Where a
  record has gone stale, a dated publication note is added above the original text; the original text
  stays.
- **One identifier, one document.** Three separate decisions once shared the identifier "ADR-0003" —
  finding F16 of the [2026-06-10 diligence audit](../audits/2026-06-10-diligence-audit-public-record.md).
  That is resolved: see the numbering note below.
- **Changing an accepted decision requires a new ADR**, not an edit ([ADR-0001](ADR-0001-source-of-truth-and-documentation-governance.md)).
- **Major direction calls get independent second opinions** scored against the NORTH_STAR Drift Test
  before they are accepted. Where those opinions came from AI models rather than a non-founder human,
  the record says so — [ADR-0010](ADR-0010-independent-review-terminology.md) reserves the word
  "independent" for humans.

## Numbering

The numbering gap this file previously described as "deliberate, not an error" is now closed.

ADR-0001 through ADR-0012 are the process and product series, kept at their original numbers.
ADR-0013 was the first record authored directly in this public directory (issue #111), and was
numbered on the reservation this file set aside for the pass below.

ADR-0014 through ADR-0018 are the technical series, authored 2026-05-28 as `docs/adr/0001-…0005-`,
deleted from the public tree in commit `09e3204` ("chore: clean public v0 surface"), and restored
here from git history. They were renumbered to end the identifier collision; each carries a note
recording its original number and filename. Their dates and content are unchanged.

ADR-0019 is the positioning decision, also authored as "ADR-0003", which had been kept private as a
strategy record. ADR-0006 permits withholding only for privacy, secrets, or transcripts — not
strategy — so it was published.

## What is still private

Session transcripts and notes, outreach material, third-party correspondence, and the contents of
`internal/`. Audit records are published in redacted form: identities of third parties who have not
consented are removed, and private-channel evidence is summarized rather than quoted. Findings are
never softened — see the two public audit records in [`../audits/`](../audits/) for what that looks
like in practice.

`scripts/check-public-hygiene.ts` enforces the line on every commit. It fails on a link to private
material, and on any link that does not resolve to a tracked file — the "link-valid" requirement
ADR-0006 asked for.
