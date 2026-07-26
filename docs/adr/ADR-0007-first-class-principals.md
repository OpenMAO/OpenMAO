# ADR-0007: First-Class Principals at the Trust Boundary

**Status:** Accepted (ratified 2026-06-11)
**Date:** 2026-06-10
**Proposed by:** External diligence audit, converged Claude (Fable 5) + GPT-5.5/Codex pass (see `../audits/2026-06-10-diligence-audit-public-record.md`)
**Owner:** Human Product Owner

---

> **Publication note (2026-07-25).** Provenance links point to the public audit records; the
> unredacted internal versions stay private because they name third parties who did not consent.
> Redaction is limited to identities and private-channel evidence — every finding, caveat, and
> criticism is published. Decision content below is unchanged.

> **Ratified 2026-06-11** by the Human Product Owner, on the converged diligence audit (Claude + GPT-5.5) plus an independent Fable 5 second opinion (UNISON-WITH-CAVEATS). Durable record: `../audits/2026-06-11-adr-ratification-public-record.md`. Note (Fable 5): landing #97 then #63 early also hardens ADR-0008's gate evidence, since within-deployment actor attribution rests on a self-asserted header until this lands.

## Context

The HTTP boundary authenticates with a single shared operator token (`x-openmao-operator-token`, `ts/src/api/server.ts:64`) and accepts a self-asserted actor header (whitespace-only actors pass the `!actor` check at `server.ts:160-164`). Every separation-of-duty rule the substrate enforces in-process — proposer ≠ applier, ratifier ≠ proposer, reviewer ≠ submitter — is therefore defeatable at the boundary by changing a header. On main, approval resolution has no proposer≠approver guard at all (`ts/src/governance/approvals.ts:122-178`).

Work that closes parts of this already exists but is stranded: `claude/per-worker-auth` (scoped worker tokens, 6 commits), `claude/busy-lichterman-dcc630` (proposer-integrity + blank-actor fixes), and open issues #92 (bind acting identity at the HTTP boundary), #93 (first-class Principal/Member), #94 (separation of duties under many humans), #96 (multi-human governance epic).

## Decision

Acting identity is bound at the trust boundary, never asserted by the client:

1. Retire the shared operator token + free actor header. Every request authenticates as a specific principal; the actor recorded in events is derived from the authenticated principal, not a header.
2. Workers receive per-worker scoped tokens (land `claude/per-worker-auth`).
3. Humans become first-class principals (Member), symmetric with WorkerIdentity (issue #93), so separation-of-duty rules are enforceable rather than cooperative.
4. Separation-of-duty guards (proposer≠approver, ratifier≠proposer) are enforced at the service layer against authenticated identity (land `claude/busy-lichterman-dcc630` as the first slice).

## Consequences

- The "enforcement, not etiquette" principle (NORTH_STAR Principle 2) becomes true at the boundary that matters, not only in-process.
- No real multi-human organization can safely adopt OpenMAO until this lands; it is the gating prerequisite for any external deployment.
- Single-operator local mode stays simple: one Member principal, but identity still flows from auth, not headers.

## Alternatives Considered

- Keep the shared token for v0 and document the limitation. Rejected: the product's value proposition is trust; a defeatable trust boundary makes every downstream guarantee cooperative.

## Follow-Up

- [ ] Merge `claude/busy-lichterman-dcc630` (proposer integrity, blank/whitespace actor, corroboration floor).
- [ ] Merge or rebase `claude/per-worker-auth`.
- [ ] Implement Member principal per issue #93; supersede the actor header per issue #92.
