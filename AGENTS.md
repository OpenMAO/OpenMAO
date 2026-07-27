# AGENTS.md - OpenMAO Agent Protocol

This file is for coding agents working in the OpenMAO repository.

## Start Here

Read in this order:

1. `NORTH_STAR.md` - why the project exists and where it is going. **Read this first.**
2. `README.md`
3. `docs/ARCHITECTURE.md`
4. `docs/ROADMAP.md`
5. `CONTRIBUTING.md`
6. `SECURITY.md`
7. `GOVERNANCE.md`

## Stay on Course

`NORTH_STAR.md` governs direction. This protocol and the implementation docs govern how and what
now.

> When a proposed change conflicts with the north star's direction, the north star wins. Raise the
> conflict; do not resolve it by drifting.

Two anchors are easy to lose under delivery pressure:

- **Governance is the substrate, not the product.** Enforced governance, audit, and approvals are
  table stakes that make the system trustworthy. They are not the differentiator. The differentiator
  is the organization-of-record altitude and the self-correction/self-learning loop. Do not let the
  build collapse OpenMAO into a governance, policy, or audit control plane.
- **The flywheel is the product.** Governance -> institutional memory -> self-correction ->
  self-learning -> audited track record -> widened autonomy. A stage shipped in isolation that never
  feeds the loop is drift, even if it works.

## Hard Rules

- Preserve one owner per concern.
- Use deterministic/mock defaults.
- Do not require external credentials for the default demo.
- Do not clone, vendor, fork, embed, or copy external agent framework code.
- External runtimes may execute bounded tasks, but OpenMAO owns the work item, authority, approvals,
  memory promotion, events, and world-model truth.
- Tool access must be modeled as scoped capabilities before it is treated as governed.
- High-risk external actions must not be described as governed unless they run through
  OpenMAO-managed providers or credential brokers.
- **Cross-framework neutrality: integrate, do not fuse.** OpenMAO governs across agent frameworks
  and models. A bundled default worker is a convenience on a neutral core; it must never become the
  product's identity or a dependency of the core. Apply the swap test.
- **Autonomy is earned, never assumed.** `Organization.autonomy_level` rises only on audited
  evidence of safe behavior and is always reversible. Do not grant autonomy by default, and do not
  permanently hard-cap it.
- **The self-correction loop stays on the roadmap.** `OrgChangeProposal` and the self-learning seam
  may be deferred for the current release, but they are the differentiator, not a someday. Never
  silently drop them, and never auto-apply an org change without explicit human authorization and an
  audited event.
- Do not copy closed-source project content into this repo.
- Do not commit internal communications, private strategy notes, session transcripts, model
  conversations, scratch decisions, or pre-public build-process records.
- Tests are part of the deliverable.
- **Test the thing, not its marker.** A check that tests the presence of a marker — a brand
  property, a status column, a signature reference, a comment asserting a check happens —
  rather than the provenance or immutability of the thing itself is not a check. Markers can be
  copied, spread, redefined, or fabricated; provenance cannot. The usual companion failure is a
  security gate keyed on the *absence* of a signal: refuse unless the condition affirmatively
  holds, never allow unless it visibly fails.
- Every state-changing action must pass through services, policy, and event logging.
- The UI never orchestrates and never writes directly to storage.
- The world model is a rebuildable projection, not source of truth.

## Working Protocol

Before work:

1. Check `git status --short`.
2. Read the relevant public docs, starting with `NORTH_STAR.md`.
3. Identify whether the change touches canonical contracts, security, persistence, approvals, or public API behavior.

During work:

1. Keep changes scoped.
2. Update tests with implementation changes.
3. Add unresolved public design questions to GitHub issues when they are ready for public tracking.
4. Do not overwrite unrelated user changes.

Before handoff:

1. Summarize what changed.
2. List tests/checks run.
3. Note contract, security, or migration impact.
4. Note known risks and deferred items.
5. Run the Drift Test below. Any "no" must be raised in the summary, not coded around.

## Drift Test

Run this before every handoff or pull request. Each question must be answerable "yes." A "no" is a
signal of drift and must be escalated, not silently resolved.

1. **Flywheel:** Does this strengthen one of the loop's stages and keep the loop whole?
2. **Substrate, not identity:** Am I treating governance/enforcement as the foundation, not letting it become the product's identity?
3. **Earned autonomy:** Does this help autonomy be earned and widened on audited evidence, rather than granting unearned autonomy or hard-capping it forever?
4. **Swap test:** Would OpenMAO's value survive the user swapping the underlying agent framework or model tomorrow, with a second team on a different stack still aggregating into one audit trail and world model?
5. **Real enforcement:** If this claims to govern or enforce, is it actually non-bypassable, not merely cooperative? Cooperative is allowed but must be labeled advisory, never enforced.
6. **Wedge vs destination:** Am I building the adoptable wedge without mistaking it for the destination and abandoning the learning loop?
7. **Ownership:** Does this keep the organization's institutional asset, including memory, structure, and audit, owned, portable, and self-hostable?

## Public Context

Public contributors must be able to understand the product from committed docs, issues, pull
requests, and code.

## Documentation Types

- Public docs: durable product and contributor-facing information.
- Pull request: implementation history and review discussion.
- Issue: public task, bug, feature request, or audit finding.

## Do Not Commit

- real secrets or credentials;
- `.env` files with live values;
- private customer data;
- closed-source repo excerpts;
- copied third-party framework code;
- internal communications, model conversations, session notes, or private strategy drafts;
- generated caches, local runtime files, or large artifacts unless explicitly approved.
