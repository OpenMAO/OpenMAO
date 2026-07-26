# ADR-0019: Position OpenMAO at the Intersection of Integration and Openness

**Status:** Accepted
**Date:** 2026-05 (published 2026-07-25)
**Deciders:** project maintainers
**Informed by:** competitive landscape survey, May 2026

---

> **Renumbered and published 2026-07-25.** This decision was authored as "ADR-0003" and kept in the
> gitignored session notes as a private strategy record. It was the third of three distinct accepted
> decisions sharing that identifier — the collision recorded as F16 in the diligence audit. Under
> ADR-0006 the private/public line is privacy- and consent-based, not strategy- or image-based: this
> record names no third party, carries no secret, and is not a transcript, so there was no valid
> ground to withhold it. Its substance was already public in
> [`docs/POSITIONING.md`](../POSITIONING.md), which remains the reader-facing version. Content is
> unchanged apart from this note and the removal of the "stored privately" framing.

## Context

The market around AI-native organizations is active and contested, but largely layer by layer:

- agent frameworks and agent-level self-improvement are advancing rapidly;
- institutional and agent memory is well served by many providers;
- governance and control-plane tooling is plentiful;
- durable-execution substrates are mature and framework-neutral;
- the "organization runs itself" altitude is occupied by proprietary enterprise suites.

Two structural facts justify the decision below.

First, a gap recurs through every layer: capability is advancing ahead of accountability. Governance,
auditability, and earned autonomy lag raw capability.

Second, there is no open, self-hostable substrate at the organization-of-record altitude that ties
these layers together.

## Decision

Position OpenMAO at the intersection of integration and openness:

> an open, self-hostable, cross-framework organization-of-record with a governed self-correction
> loop, delivered as one coherent, org-owned system, where autonomy is earned rather than assumed.

Concretely:

1. **Governance and enforcement are table-stakes substrate, not the product.** They make autonomy
   safe; they are not the differentiator.
2. **The differentiation is the institutional-learning loop plus the organization-of-record
   altitude.** This is the flywheel in `NORTH_STAR.md`: governance -> memory -> self-correction ->
   audited track record -> wider autonomy.
3. **Openness and sovereignty are load-bearing.** This is hardest for a closed incumbent to match,
   and open agent-level projects are far from reaching this altitude.
4. **Integrate, do not fuse.** Bring your own agents, frameworks, memory, and durable-execution
   substrate. OpenMAO governs and learns above them. A bundled default is fine; framework-as-identity
   is not.

## Consequences

We accept these commitments:

- We must make the whole genuinely more valuable than assembled best-of-breed parts. The
  flywheel and compounding org-owned asset must actually deliver, or adopters will assemble point
  tools themselves.
- We commit to organization-level self-correction, the L3 loop, which is a research frontier rather
  than a solved feature.
- We stay framework- and provider-neutral, foregoing the short-term leverage of fusing with one
  popular framework.
- Openness is a permanent constraint, not a temporary tactic. The core cannot be quietly closed
  without forfeiting the position.

In return we gain:

- a position defensible against closed enterprise suites on openness and sovereignty;
- a position defensible against open agent-level projects on governed org-of-record altitude;
- a compounding, org-specific asset: ratified memory, evolved structure, and audited trust track
  record.

## Alternatives Considered

- **Governance-only control plane:** rejected because it is absorbable by agent frameworks and
  hyperscaler platforms. Per-framework governance fails the swap test.
- **Framework-as-identity:** rejected because it forfeits cross-ecosystem trust and imports framework
  churn.
- **Match proprietary autonomous-enterprise suites feature-for-feature:** rejected because it is the
  wrong game and abandons the open/sovereign edge.
- **Ship a memory or self-improvement point tool:** rejected because that is a commoditized layer,
  not the altitude.

## Revisit When

Revisit when any refresh trigger in the landscape survey fires, notably:

- an open-source organization-of-record substrate with a governed self-correction loop appears;
- a proprietary incumbent ships a genuinely open or self-hostable autonomous-enterprise option;
- a neutral standard commoditizes the substrate.
