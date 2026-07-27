# ADR-0012: Native, Agent-First Work Management

**Status:** Accepted (ratified 2026-07-25)
**Date:** 2026-07-25 (records a product-owner decision made 2026-06-02)
**Proposed by:** Human Product Owner, 2026-06-02, in `docs/OPERATOR_CONSOLE_REDESIGN.md` §2 (recovered and committed 2026-07-24 as `3495a21` on `claude/heuristic-ishizaka-cb69b0`). Encoded and independently reviewed 2026-07-25.
**Owner:** Human Product Owner

---

> **Ratified 2026-07-25** by the Human Product Owner, on two independent second opinions scored
> against the Drift Test (GPT-5.6 and Claude Sonnet; both REVISE-BEFORE-APPLYING, 0 FAIL). The
> no-parity bound was explicitly confirmed at ratification: *"We can later connect project-management
> apps, but OpenMAO in itself is not that."* Connecting an external tracker is an integration;
> being one is not the identity.

## Context

`NORTH_STAR.md` and `docs/ROADMAP.md` carried a non-goal — "a general-purpose project-management
app", and "a replacement for Jira, Linear, Notion, …" — that the product owner consciously revised
on 2026-06-02 while planning the operator console. The revision was recorded in the console
redesign plan, explicitly flagged as needing a charter wording update, and then lost when the
authoring worktree was deleted. It was recovered on 2026-07-24 but never applied. The charter has
therefore contradicted a live product decision for seven weeks, and the console work already
depends on the revised direction.

ADR-0001 requires a new ADR to change an accepted decision. This is that record.

## Decision

**Work management is native and first-class, and it is agent-native.** OpenMAO owns the work it
governs: the record that authorizes a task and the record that holds it should not be different
systems. Work is grouped into projects; recurring work is expressed through the existing
`Cadence` standing obligation; operator surfaces sit over both.

Two rules bound this, and are the reason it is not a re-scoping of the project:

1. **Agent-native, not a human-only clone.** Every unit of work is delegable to an agent, governed
   by approvals and earned autonomy, and feeds institutional memory. The differentiator is the
   institutional-learning loop wrapped around the work — memory that compounds and autonomy earned
   on an audited record — not the absence of task management, and not governance, which
   `NORTH_STAR.md` § Differentiator correctly calls table stakes.
2. **Operator-first vocabulary.** Operator surfaces say *task* and *project*, never *issue*;
   operators are not all software teams. Kernel type names (`WorkItem`, `TaskEnvelope`, `Cadence`)
   do not change — the mapping is presentation-layer, with developer names behind a toggle.

**Bounds adopted at encoding time, on two independent reviews (see Provenance):**

- **No parity objective.** The originating note said "as capable for planning and tracking as
  Paperclip or Linear." That is deliberately *not* adopted as charter wording. Both reviewers
  identified an unbounded parity target against mature, well-funded tools as the point where this
  decision would become drift. Matching a dedicated tracker's planning surface is not an
  acceptance criterion at any phase.
- **No new kernel vocabulary.** Projects and recurrence extend the existing work-item spine and
  `Cadence`. Adding a `Project` type requires its own justification under Principle 7 ("no
  speculative kernel").
- **Sequencing.** This does not precede the Phase 1 acceptance criteria.
- **Named systems stay non-goals.** OpenMAO is not a *drop-in replacement* for Jira, Linear, or
  Notion. External-tracker sync is a later opt-in, never a dependency.

## Consequences

- `NORTH_STAR.md` § Non-Goals: the "replacement for Jira, Linear, Notion, …" bullet becomes "drop-in
  replacement"; "a generic, human-only project-management app" becomes its own bullet; a
  clarifying paragraph states the direction, the two rules, and what exists today versus what is
  ahead.
- `docs/ROADMAP.md` § Non-Goals: the compound bullet splits, and a paragraph records the scope
  bound and the Phase 1 sequencing gate.
- `docs/POSITIONING.md`: work trackers are added to Related Work as the one deliberate overlap,
  and the section's "complements rather than competes with most of these" framing now names the
  exception rather than eliding it.
- `docs/VOCABULARY.md`: the operator label mapping is recorded next to the type it labels, and
  recurring work is pinned to `Cadence` so it cannot become a duplicate concept.
- **Nothing here is a capability claim.** As of this ADR, `WorkItemSchema`
  (`ts/src/contracts/models.ts`) has no project, hierarchy, or recurrence fields, and the "Tasks"
  operator label exists only on the unmerged `claude/heuristic-ishizaka-cb69b0`. The charter
  wording is written as direction for that reason.
- **Residual risk, from the GPT-5.6 review: audit volume is not trust.** High-volume recurring
  work can inflate an apparent track record without producing evidence of *safe judgment*. If
  recurring work later feeds autonomy widening, the autonomy case must weight risk and outcome,
  not task count. Ledgered here; not solved here.
- **Residual risk, from both reviews: the rules constrain shape, not amount.** Nearly any generic
  PM feature can be rationalized as "agent-native" by adding an agent assignee and an audit event.
  The no-parity bound above is the mitigation; if feature pressure recurs, that bound is the thing
  to re-litigate, not the two rules.

## Alternatives Considered

- **Keep the old non-goal and drop native work management.** Rejected by the product owner
  2026-06-02: an organization of record that cannot hold its own work is not an organization of
  record, and operator productivity is the point of the console.
- **Apply the originating wording verbatim, including the Linear-parity clause.** Rejected on both
  independent reviews: it converts a bounded product decision into an unbounded competitive
  objective on the surface where OpenMAO is weakest and least differentiated.
- **Leave the charter contradicting the decision and let the code lead.** Rejected: silent drift
  is precisely what ADR-0001 and the Drift Test exist to prevent, and the originating note itself
  said "flagged to update NORTH_STAR/ROADMAP wording — not silently rewritten."

## Provenance

Two independent second opinions, per the standing rule that major direction calls are scored on
the NORTH_STAR Drift Test by a different model family rather than paraphrased:

- **GPT-5.6 (`gpt-5.6-sol`, xhigh, read-only):** REVISE-BEFORE-APPLYING. Drift Test 3 PASS /
  4 CONCERN / 0 FAIL — no categorical FAIL, so no charter escalation trigger, but the CONCERNs
  "would become failures if dedicated-tool parity were treated as an acceptance criterion."
- **Claude Sonnet:** REVISE-BEFORE-APPLYING. Drift Test 4 PASS / 3 CONCERN / 0 FAIL (Flywheel,
  Substrate-not-identity, Wedge-vs-destination).

Both reviews' required fixes are folded into the Bounds and Consequences above. The review reports
themselves were working session output and are not preserved as durable artifacts; their operative
content — verdicts, scores, and every required fix — is reproduced in this record. Under ADR-0010
these were **dual-model audit passes**, not independent review: no non-founder human has reviewed
this decision.

## Follow-Up

- [x] Human Product Owner ratifies, amends, or rejects. — **Ratified 2026-07-25**, no-parity bound
      confirmed.
- [x] Publish into the public governance slice under ADR-0006 Option A. — **Done 2026-07-25**; this
      record was written while `docs/adr/` was still private and moved with the rest of the series.
- [ ] If projects or recurrence later need kernel representation, justify against Principle 7
      before adding a type; the current answer is "extend `WorkItem` and `Cadence`."
- [ ] Revisit the autonomy-inflation risk before recurring work feeds any autonomy case.
