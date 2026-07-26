# ADR-0010: "Independent Review" Means a Non-Founder Human

**Status:** Accepted (ratified 2026-06-11)
**Date:** 2026-06-10
**Proposed by:** External diligence audit, converged Claude (Fable 5) + GPT-5.5/Codex pass (see `../audits/2026-06-10-diligence-audit-public-record.md`)
**Owner:** Human Product Owner

---

> **Publication note (2026-07-25).** Provenance links point to the public audit records; the
> unredacted internal versions stay private because they name third parties who did not consent.
> Redaction is limited to identities and private-channel evidence — every finding, caveat, and
> criticism is published. Decision content below is unchanged.

> **Ratified 2026-06-11** by the Human Product Owner, on the converged diligence audit (Claude + GPT-5.5) plus an independent Fable 5 second opinion (UNISON-WITH-CAVEATS). `../audits/2026-06-11-adr-ratification-public-record.md` is the first durable review output this ADR requires.

## Context

ADR-0004 defines "independent review" as fresh GPT-5.5 Codex and Claude sessions auditing a diff — model sessions operated by the same single human. Every review record on GitHub (issues #12–#14, #33–#35) is a self-comment by the founder's account; release notes claim promotion "after independent QA, Security, and Architecture review gates"; no transcript, output, or second identity corroborates any of it. The audits were substantively useful (real findings traced to real fix commits), but the label "independent" is not true, and in a trust product an untrue trust-word is more expensive than no claim.

## Decision

1. The word **"independent"** (in reviews, gates, release notes, evidence docs) is reserved for review by a human who is not the founder.
2. AI second-opinion passes are renamed **"dual-model audit pass"** (or similar) everywhere, including future CHANGELOG/release language. Past public claims are corrected per ADR-0006's chosen posture.
3. Per the GPT-5.5 convergence correction: every audit pass that is cited as evidence must persist a **durable review output** — the structured findings/verdict document (not private session transcripts, which repo protocol forbids committing) — in the audit record location chosen by ADR-0006, so a third party can at least see what was claimed, when, and what changed in response.
4. The dual-model audit ceremony itself is downgraded from mandatory-per-change to risk-triggered (security-relevant or contract-changing diffs), reflecting the audit finding that the ceremony consumed ~25% of commits while its bookkeeping half was abandoned within 48 hours.

## Consequences

- Public claims become accurate without abandoning the genuinely useful audit practice.
- External PR #98's author, and contributors like them, become the first candidates for actual independent review — converting the trust vocabulary into a contributor-engagement mechanism.
- Less ceremony per change; founder-hours move toward the ADR-0008 adoption gate.

## Alternatives Considered

- Keep the terminology, add disclaimers. Rejected: a disclaimer on a trust-word in a trust product reads as exactly what it is.
- Drop AI audits entirely. Rejected: they caught real bugs (v0.1 enforcement overclaim, v0.5 snapshot-id collision).

## Follow-Up

- [ ] Sweep ADR-0004, GOVERNANCE.md, CHANGELOG.md, release evidence for the terminology change.
- [ ] Define the risk triggers for the dual-model pass.
- [ ] Record durable review outputs for future passes (this audit's record is the first instance).
