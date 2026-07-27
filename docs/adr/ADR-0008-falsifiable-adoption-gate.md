# ADR-0008: Falsifiable Adoption Gate

**Status:** Accepted (ratified 2026-06-11, amended; day-0 = 2026-06-11)
**Date:** 2026-06-10
**Proposed by:** External diligence audit, converged Claude (Fable 5) + GPT-5.5/Codex pass (see `../audits/2026-06-10-diligence-audit-public-record.md`)
**Owner:** Human Product Owner

---

> **Publication note (2026-07-25).** Provenance links point to the public audit records; the
> unredacted internal versions stay private because they name third parties who did not consent.
> Redaction is limited to identities and private-channel evidence — every finding, caveat, and
> criticism is published. Decision content below is unchanged.

> **Ratified 2026-06-11 (amended)** by the Human Product Owner, on the converged diligence audit (Claude + GPT-5.5) plus an independent Fable 5 second opinion (UNISON-WITH-CAVEATS). Durable record: `../audits/2026-06-11-adr-ratification-public-record.md`.

## Ratification amendments (2026-06-11)

Folded in at ratification (Fable 5 review). **Day-0 of the clock is 2026-06-11**; four candidate adopters, all reached through outreach, to be confirmed as calls land (names withheld pending their consent).
1. **Evidence artifact (defined).** "Visible in the audit trail" means an exported, hash-chain-verifiable event-log slice — or periodic chain-head attestations — using the tamper-evident chain merged in PR #98. A screenshot does not count.
2. **"Governed side-effecting call" excludes the in-repo mock provider** (no `mock_*` provider satisfies the gate).
3. **Maintenance mode is reversible.** It is not a one-way ratchet: the same test, passed at any later point, reopens active development. (A gate whose downside is irreversible is one the founder will fudge at day 90.)
4. **Single decision point at day 90.** Condition: the 4-consecutive-week test met at any point by then, OR ≥2 external contributors with merged substantive PRs plus one founder-independent deployment. (Replaces the day-60-test + day-90-review split, which invited relitigation.)

## Context

NORTH_STAR.md contains no quantified adoption criterion; its "earned when … working and trusted" clauses name no truster, which for a solo founder makes every trust claim self-certification. The converged audit found organic external demand is effectively zero (vanity metrics are bot-farm noise; the one substantive external PR was outreach-converted), founder-hours are the scarcest input, and the documented failure pattern is meta-work expansion (new milestones, planning epics, repositioning) in place of market contact.

Per the GPT-5.5 convergence correction, the gate must be **repo-observable** — measured in OpenMAO's own audit trail — not based on stars, traffic, or other gameable/farm-pollutable signals.

## Decision

Adopt a charter-level, falsifiable adoption gate:

1. **The test (day 60 from ratification):** at least one operator who is not the founder runs real work through an OpenMAO deployment, producing ≥1 governed, side-effecting capability call per week — approved through OpenMAO's approval flow and visible in that deployment's audit trail — for 4 consecutive weeks.
2. **The go/no-go (day 90 from ratification):** if the test is passing, or ≥2 external contributors have substantive merged PRs and one deployment exists the founder does not operate, OpenMAO continues active development. Otherwise OpenMAO enters **maintenance mode**: respond to issues/PRs, merge good contributions, no new roadmap work, founder-hours redirect to the intended flagship dogfood organization until it can genuinely pull OpenMAO behind it.
3. **Anti-gaming clause:** stars, forks, watchers, traffic, and founder-operated deployments do not count toward the gate.
4. New milestones (M5+, new epics, console redesigns, new vocabulary) are out of scope until the gate is decided, except work that directly serves a named candidate adopter or ADR-0007.

## Consequences

- The "demand ahead of market" hard truth gets an expiry date instead of functioning as a permanent excuse.
- The burst-crash build pattern gets a binding constraint: the next unit of proof must involve a human who is not the founder.
- Maintenance mode is a defined, honorable outcome — not a silent abandonment like the current frozen-tracker state.

## Alternatives Considered

- Star/traffic-based gates. Rejected (GPT-5.5 correction): farm-pollutable, not evidence of consequential use.
- No gate ("keep building until ready"). Rejected: this is the documented over-build/under-ship failure mode.

## Follow-Up

- [ ] Ratify, set the day-0 date, and record the gate in NORTH_STAR.md or ROADMAP.md per ADR-0006's chosen posture.
- [ ] Open the public tracking issue (adoption-gate tracking) and name the candidate adopters being worked.
