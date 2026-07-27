# ADR-0006: Public-or-Dead Governance Records

**Status:** Accepted — Option A (ratified 2026-06-11; reversible to B)
**Date:** 2026-06-10
**Proposed by:** External diligence audit, converged Claude (Fable 5) + GPT-5.5/Codex pass (see `../audits/2026-06-10-diligence-audit-public-record.md`)
**Owner:** Human Product Owner

---

> **Publication note (2026-07-25).** Provenance links point to the public audit records; the
> unredacted internal versions stay private because they name third parties who did not consent.
> Redaction is limited to identities and private-channel evidence — every finding, caveat, and
> criticism is published. Decision content below is unchanged.

> **Ratified 2026-06-11 as Option A** by the Human Product Owner, on the converged diligence audit (Claude + GPT-5.5) plus an independent Fable 5 second opinion (UNISON-WITH-CAVEATS). Durable record: `../audits/2026-06-11-adr-ratification-public-record.md`.

## Ratification amendments (2026-06-11)

Folded in at ratification (Fable 5 review):
1. **The public/private line is privacy- and consent-based, never image-based.** Unflattering decision history (the Gate-6 fiction, the bypassed gates, this audit's own findings) publishes as-is — a credible failure record beats a polished façade, and image-based curation is the prohibited half-posture in disguise. Private = third-party names without consent, operational secrets, session transcripts.
2. **Prerequisite deliverable: a redacted public audit record.** The 2026-06-06..10 ADRs cite the diligence audit as provenance, and that file contains third-party data drawn from private correspondence (F27, including named individuals). Before publishing, produce a redacted public audit record (repo-verifiable findings only; private-channel evidence summarized and withheld) and re-point ADR provenance at it — otherwise Option A either dangles links or leaks third-party data.
3. **Timebox the hygiene pass (~1 day), sequenced after the reply queue.** Restoring the deleted `docs/adr/`, resolving the triple ADR-0003 collision, and extending `check-public-hygiene` must not become the meta-work spiral this ADR exists to end.

## Context

OpenMAO's pitch is accountable, audited AI organizations — yet its entire accountability apparatus is private. `.gitignore` excludes STATUS.md, BUILD_PLAN.md, DECISIONS.md, MODULE_OWNERSHIP.md, WORK_BREAKDOWN.md, `decisions/`, `sessions/`, `docs/adr/`, `docs/audits/`, `docs/evidence/`, `docs/audit-trails/`, `docs/runbooks/`, the sign-off/approval templates, and the audit harness itself ("never publish"). An outside contributor cannot verify any claimed gate, review, human approval, or decision. The product-shaping technical ADRs (control-layer architecture, TypeScript runtime) were deleted from the public tree in the pre-public scrub and survive only in local git history, while DECISIONS.md still links to them. The release evidence that IS public contains commands but no captured outputs.

A trust product with a private trust layer converts every accountability claim into "trust me" — the exact posture the product exists to replace.

## Decision

Adopt one of the two consistent postures (to be selected at ratification):

**Option A — Publish (recommended).** Commit a curated public slice of the governance layer:
- a public `STATUS.md` (honest current state, no private session mechanics);
- a public `docs/adr/` containing all accepted technical and process ADRs (restored from history where deleted), with the triple "ADR-0003" collision resolved by renumbering;
- audit and release evidence that includes captured command outputs, so a stranger can replay and diff;
- the decision index (`DECISIONS.md`) tracked and link-valid.
Private remains: session transcripts, outreach material, anything under `internal/`.

**Option B — Retire the claims.** Keep the apparatus private, and remove every public claim that depends on it (gate language, "accepted release after review gates" phrasing, accountability framing in README/CHANGELOG) so public claims and public evidence match.

Half-postures (private records + public claims) are prohibited going forward.

## Consequences

- Option A makes the repo its own first proof artifact: the audit trail of OpenMAO's development becomes the demo of organization-of-record accountability.
- Option A requires a one-time hygiene pass (the existing `check-public-hygiene` script extended to the newly tracked files) and restoring the deleted technical ADRs from history.
- Option B is cheaper but forfeits the strongest available credibility asset and weakens the README/CHANGELOG narrative.

## Alternatives Considered

- Status quo (private apparatus, public claims). Rejected: the converged audit found this is the single largest credibility gap (claims F16–F19).

## Follow-Up

- [x] Ratify Option A or B. — **A, 2026-06-11.**
- [x] If A: restore the deleted technical ADRs from commit history; renumber to resolve the ADR-0003 collision; track STATUS.md and DECISIONS.md; extend hygiene checks. — **Done 2026-07-25.**
- [ ] If B: sweep README, CHANGELOG, and release docs for apparatus-dependent claims. — *not applicable; A was ratified.*

## Execution record (2026-07-25)

The prerequisite and the hygiene pass ran together, on explicit product-owner instruction, ahead of
the "after the reply queue" sequencing this ADR's amendment 3 preferred.

1. **Prerequisite met.** Two public audit records were produced — the
   [diligence audit](../audits/2026-06-10-diligence-audit-public-record.md) and the
   [ratification record](../audits/2026-06-11-adr-ratification-public-record.md) — redacted for
   third-party identity and private-channel evidence only. Every finding, caveat, and criticism is
   published, including the ones that reflect badly on this project. ADR provenance now points at
   them.
2. **Identifier collision resolved (audit finding F16).** The five technical ADRs deleted in
   `09e3204` were restored from git history and renumbered ADR-0014…ADR-0018; the positioning
   decision that had lived only in the gitignored session notes was published as ADR-0019. One
   identifier, one document.
3. **Newly public:** `docs/adr/` (18 records), `DECISIONS.md`, `STATUS.md`, and the two audit
   records.
4. **Still private, and unchanged in kind:** session transcripts and notes, outreach material,
   third-party correspondence, anything under `internal/`, and the local audit harness.
5. **Two hygiene rules were retired as image-based curation**, which amendment 1 prohibits: the ban
   on referencing ADRs at all, and the ban on mentioning the Python reference implementation. The
   project's toolchain history — that it began in Python and moved to TypeScript — is recorded in
   ADR-0014 through ADR-0018 and is not a secret. The replacement rules block links to material that
   is genuinely private, and fail on links that dangle.
