# ADR Ratification Record — 2026-06-11 (ADR-0006…0011) — public record

> Durable review output, required by [ADR-0010](../adr/ADR-0010-independent-review-terminology.md).
> Records the judgment behind ratifying six governance ADRs and the caveats folded into each.

**Redaction note.** This is the public version. Named third parties — external contributors,
candidate adopters, and correspondents — appear here by role only; they did not consent to appear in
this project's governance record. Nothing else is withheld: the caveats, the amendments, and the
uncomfortable bottom line are published as written. See the
[public audit record](2026-06-10-diligence-audit-public-record.md) for the same treatment of the
audit that produced these ADRs.

## Process

- **Proposed by:** the 2026-06-10 external diligence audit (Claude + GPT-5.5,
  CONVERGE-WITH-CORRECTIONS, zero refutes —
  [public record](2026-06-10-diligence-audit-public-record.md)).
- **Independent second opinion:** Fable 5, instructed to disagree where warranted — verdict
  **UNISON-WITH-CAVEATS** (concurred with all six directions including 0006 = Option A; required
  modifications to 0006, 0008, and 0011).
- **Ratified:** 2026-06-11 by the Human Product Owner, on that unison, with the caveats below folded
  in.

Note the terminology this record is bound by: per ADR-0010, a second AI model is a **dual-model
audit pass**, not an independent review. Independent review requires a non-founder human. No such
review had occurred at ratification.

## Decisions

| ADR | Status | Product-owner input | Notes |
| --- | --- | --- | --- |
| 0006 Public-or-dead governance records | **Accepted — Option A** | A confirmed (reversible) | line is privacy/consent-based; a redacted public audit record is a prerequisite; hygiene pass timeboxed |
| 0007 First-class principals | **Accepted** | sequencing: after #97 → #63 | landing #97/#63 early also hardens 0008's evidence |
| 0008 Falsifiable adoption gate | **Accepted (amended)** | **day-0 = 2026-06-11**; adopter to be confirmed | evidence = the PR #98 hash-chain slice; mock provider excluded; maintenance mode has a re-entry rule; single day-90 decision |
| 0009 Truth-in-status | **Accepted** | none | implementation started (#105) |
| 0010 "Independent review" = non-founder human | **Accepted** | none | this file is the first durable review output it requires |
| 0011 Capability scoping and delegation | **Accepted — as direction** | none | implementation subordinated to 0008's freeze; built via contributor PRs and 0007-riding slices only |

## Caveats folded in

**0006** — (a) the public/private line is **privacy- and consent-based, not image-based**:
unflattering decision history (the Gate-6 fiction, the bypassed gates, the audit's own findings)
publishes as-is; private means third-party names without consent, secrets, and session transcripts.
(b) **Prerequisite deliverable:** a redacted public audit record — repo-verifiable findings only,
private-channel evidence summarized and withheld — so that ADR provenance links neither dangle nor
leak third-party data, since the 2026-06-10 audit identifies individuals drawn from private
correspondence. (c) The hygiene pass — restore the deleted technical ADRs, resolve the triple
ADR-0003 identifier collision, extend `check-public-hygiene` — is **timeboxed (~1 day) and sequenced
after the reply queue**; it must not become the meta-work spiral it exists to end.

**0008** — four amendments: (a) the gate's **evidence artifact** is an exported,
hash-chain-verifiable event-log slice, or periodic chain-head attestations, built on the merged
PR #98 — not a fabricable screenshot; (b) "governed side-effecting call" **excludes the in-repo mock
provider**; (c) **maintenance mode has a defined re-entry rule** — the same test passed later
reopens active development, so it is not a one-way ratchet; (d) **a single day-90 decision point**,
rather than a day-60 test plus a day-90 review, which would invite relitigation.

**0011** — (a) an explicit subordination clause: implementation follow-ups are subject to ADR-0008's
freeze, and until the gate is decided only slices that land with ADR-0007 or directly serve a named
candidate adopter proceed; (b) the legitimate implementation path is contributor PRs — several
external contributors had volunteered for specific issues — and 0007-riding slices, **not a
maintainer solo build**.

## Inputs still open at ratification

- **0008 named adopter(s):** four candidates, all reached through outreach. The day-0 clock was set
  to 2026-06-11; the named adopter is confirmed when a call lands.
- **0006 Option A versus B:** ratified as A on dual-model unison; reversible if the product owner
  prefers B. Note that B materially weakens 0008's public falsifiability.

## Bottom line

Both models concur that 0008 and 0009 actively repair the two places the project violates its own
charter: self-certified autonomy, and an `applied` state that changes nothing. Ratification is a
signing ceremony — the highest-value hours that week were the unread reply queue, the offered call,
and merging #97, not ADR or feature work.

---

**Execution note (2026-07-25).** ADR-0006's prerequisite and hygiene pass were completed on
2026-07-25: the public audit record was produced, the technical ADRs were restored and renumbered,
the identifier collision was resolved, and `docs/adr/`, `DECISIONS.md`, and `STATUS.md` became
tracked. The pass ran later than the "after the reply queue" sequencing intended, on explicit
product-owner instruction.
