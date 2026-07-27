# OpenMAO Roadmap

This roadmap is the staged path described by [NORTH_STAR.md](../NORTH_STAR.md): from the adoptable
wedge to the full flywheel and the autonomy dial.

OpenMAO starts with a deterministic local release that proves the organizational substrate:
accountable work, governed handoff, approval suspension/resume, memory promotion, audit events,
traces, and a rebuildable world model. The roadmap keeps that substrate stable while turning the
flywheel and widening what the organization can safely do on its own.

> **The wedge is enforced capability governance. The destination is a self-correcting organization.**
> Governance is the substrate that makes the destination safe; it is not the product's identity.
> The failure mode to avoid is mistaking the wedge for the destination.

## How This Roadmap Is Organized

Phases map to two ideas from the charter:

- **The autonomy dial** (`Organization.autonomy_level`): `advisory` -> `supervised` -> `bounded`
  -> future `board-governed`. Autonomy widens only on audited evidence of safe behavior.
- **The flywheel:** governance -> institutional memory -> self-correction -> self-learning ->
  audited track record -> widened autonomy.

Each phase must keep the flywheel whole. A stage shipped in isolation that never feeds the loop is
drift, even if it works.

## Sequencing Principle

The wedge funds the runway; the loop is the destination. Land where OpenMAO is immediately useful:
enforced governance, audit, and accountable work for organizations that cannot or will not run on a
closed cloud. Build visibly toward the self-correcting organization so each release is demonstrably
closer to "the organization that gets better and more autonomous over time," not just a more
polished control plane.

## Phase 0: Substrate Skeleton

**Foundational release (`v0.1.0`). Autonomy:** `supervised`.

The frame of the flywheel exists; it does not yet turn. Memory promotion is manual, and
self-correction and self-learning are seams only.

The initial public release provides:

- local TypeScript runtime;
- SQLite persistence;
- canonical contracts and generated JSON Schema;
- deterministic two-agent demo;
- approval-gated memory promotion;
- workspace-scoped events and run traces;
- API, CLI, and minimal operator console;
- public hygiene checks for secrets and internal process leaks.

See [docs/release/v0.1.0_acceptance_evidence.md](release/v0.1.0_acceptance_evidence.md) for
initial release evidence.

## Phase 1: Enforced Capability Governance

**The wedge. Autonomy:** `supervised` -> `bounded`.

This phase makes governance real: enforced, not cooperative, so the organization can be trusted to
act. It is the safety foundation every later phase rests on and the first release where OpenMAO is
useful with real agents, tools, and workflows. It is the on-ramp, not the destination.

The Phase 1 promise:

> A developer can create accountable work in OpenMAO, assign it to an external worker, gate risky
> actions before execution, resume safely after approval, review the outcome, and inspect the
> resulting events, traces, memory, and world model.

Phase 1 is not a hosted enterprise platform. It is the first release that makes at least one
side-effecting capability enforceable rather than merely cooperative.

### Phase 1 User Journey

1. A developer installs OpenMAO locally.
2. They create or import accountable work with an owner, reviewer, criteria, risk, and capability grants.
3. OpenMAO assigns bounded work to an external worker through the TypeScript SDK.
4. The worker executes the bounded task in its own framework/runtime.
5. The worker requests a side-effecting capability action through OpenMAO because the relevant credential/provider is brokered by OpenMAO.
6. OpenMAO checks role permissions and policy.
7. A high-risk action creates a durable approval request before execution.
8. The operator approves or rejects through CLI, API, or console.
9. Approved work resumes exactly once.
10. The worker returns an outcome and artifact reference.
11. OpenMAO records events, traces, policy decisions, memory proposals, and a world-model update.
12. The operator reviews or closes the work in OpenMAO.

### Phase 1 Required Work

**1. Work substrate.** Ship the public work-intake and assignment path: create/import work, assign
owner and reviewer, produce bounded work envelopes, track lifecycle state, and close or review work
after worker outcomes return.

**2. SDK mode.** Ship a TypeScript client for governed workers covering worker identity, work
envelopes, authorization checks, event recording, approval requests, artifact/outcome submission,
and memory promotion proposals.

**3. Gateway mode.** Ship one enforced side-effecting capability path. The first provider should be
narrow and developer-visible, such as a GitHub issue/comment/pull-request action. Credentials must
be handled by provider code and never exposed to workers, events, traces, or capability payloads.
Policy and approval must run before execution, and approval resume must execute at most once.

> Status: `v0.4.0` ships the first real provider — an opt-in GitHub issue-comment provider with
> an environment-backed credential broker and capability-bound credential handles. It is registered
> only when explicitly enabled, so the default runtime stays mock-only and credential-free.

In OpenMAO terms, tools are concrete things agents want to use: GitHub, email, Slack, a database, a
browser, a shell, an MCP server, or an internal API. Capabilities are the governed declarations that
expose those tools safely: named action, schema, provider, risk, credential handle, policy, approval
behavior, and audit payload.

**4. Ingestion mode.** Ship an event/trace/outcome ingestion path for external runtimes that already
execute work elsewhere. Ingested records must be idempotent, authenticated, workspace-scoped, and
projected into the world model only through approved rules.

**5. Reference external worker.** Ship a small example worker outside the local spine that
demonstrates the contract boundary: the worker executes bounded work, while OpenMAO owns authority,
policy, approval state, memory, events, traces, and world-model truth.

If the reference worker uses a known framework such as LangGraph, CrewAI, OpenAI Agents SDK, or a
similar runtime, frame it as one interchangeable worker under OpenMAO authority. The adapter must
not turn that framework into OpenMAO's spine, source of truth, approval model, memory model, or
category positioning.

**6. Operator review loop.** Improve the console enough for the Phase 1 story: runs, pending approvals,
capability calls, events, traces, artifacts, memory proposals, and world-model state should be easy
to inspect during the external-worker demo.

### Phase 1 Acceptance Criteria

- A clean clone can run the local deterministic demo without external credentials.
- A developer can create/import a work item, assign ownership, and hand bounded work to an external worker.
- With configured test credentials or a mock remote provider, a developer can run the external-worker demo end to end.
- At least one external worker integrates without becoming the source of OpenMAO truth.
- Replacing the reference worker runtime would not change OpenMAO's work, authority, approval, memory, event, or world-model contracts.
- At least one side-effecting capability is enforceable through an OpenMAO-managed provider or credential broker.
- The external worker cannot execute that side effect with raw credentials in the default external-worker demo path.
- Approval resume works after process restart and executes the approved action at most once.
- SDK, gateway, and ingestion writes require workspace identity, actor/source identity, and idempotency keys.
- Raw secrets never appear in events, traces, capability-call payloads, artifacts, or logs.
- The world model reflects external-worker activity through rebuildable projection rules.
- The operator can inspect what happened, who/what requested it, which policy applied, who approved it, how the work state changed, and what changed afterward.

### Phase 1 Non-Goals

Phase 1 does not ship a hosted SaaS control plane, multi-tenant enterprise authentication, a full
provider marketplace, compatibility adapters for every agent framework, execution-framework
internal checkpointing/retry semantics, broad credential brokering for every external system,
unreviewed autonomous self-improvement, or broad sandboxed browser/shell/file execution.

## Phase 2: Institutional Memory That Compounds

**Autonomy:** `bounded`.

The flywheel's memory stage deepens, and the compounding moat begins to accrue. Memory stops being
storage and becomes the organization's growing institutional asset.

- evidence-backed organizational memory search and review;
- transactive memory, meaning who knows or owns what, as a first-class plane;
- corroboration-based ratification of promoted knowledge, with human review still required for high-impact items;
- memory decay, contradiction detection, and stale-memory review;
- the world model graduates from an inspection surface to a decision input for planning, routing,
  and capability-gap detection while remaining a rebuildable projection.

Exit signal: the organization visibly accumulates and reuses ratified knowledge, and operators can
see the asset growing across runs and teams.

> Status: `v0.5.0` ships the first Phase 2 slice — corroboration-based ratification (the accumulate
> half: independent, evidence-backed, human-gated) and evidence-backed memory retrieval (the reuse
> half), surfaced in the CLI, API, console, and the world model's `collective_memory`. Transactive
> memory, memory decay/contradiction detection, and the world model as a decision input remain ahead.

## Phase 3: The Self-Correction Loop

**The frontier. Autonomy:** `bounded` and widening.

This is the differentiator and the genuinely hard research frontier. `OrgChangeProposal` has moved
from a dormant seam into an initial institutional-learning loop: OpenMAO can detect early
operational patterns, create evidence-backed proposals, and route them through human review.
Deeper self-correction is still hard: build it carefully, keep humans ratifying, and never
auto-apply.

The loop:

1. OpenMAO detects repeated blockers, missing capabilities, weak handoffs, stale memory, unclear roles, policy gaps, and unreliable workflows.
2. It diagnoses likely causes from events, traces, outcomes, and the world model.
3. It proposes concrete changes: new or revised roles, policies, SOPs, capabilities, or workflows.
4. A human or governance body ratifies or rejects the proposal.
5. OpenMAO versions the configuration and records an audited change event.

Hard constraints:

- no org change is applied without explicit human authorization and an audited event;
- high-impact changes always require human review;
- every proposal and decision is traceable and reversible;
- rejected proposals remain useful as organizational memory rather than disappearing.

Initial institutional-learning scope:

- deterministic local detectors for repeated blockers, failed handoffs, stale memory, missing or
  disabled capabilities, and approval bottlenecks;
- evidence-backed `OrgChangeProposal` records with review approval, rejection, and explicit
  applied-marker events;
- CLI, API, console, and world-model visibility for proposals;
- no automatic mutation of roles, policies, memory, capabilities, or org graph.

This is the stage where outcomes start improving the organization's own structure. The flywheel
turns.

## Phase 4: Earned Autonomy

**Board-governed horizon. Autonomy:** future `board-governed`.

The north-star horizon depends on solving self-correction and on an accumulated, audited track
record of safe behavior. It is not a near-term deliverable; it is the direction the roadmap serves.

- Autonomy widens on audited evidence toward a future `board-governed` mode, where agents run
  operations and humans govern at the policy/strategic level and intervene by exception.
- The trust track record, built from audit and world-model history, becomes the evidence base that
  unlocks each widening and the organization's deepest non-transferable asset.
- Every widening remains reversible, and more autonomy raises, rather than lowers, the bar on
  enforcement, reversibility, and audit integrity.

## Cross-Cutting Enablers

Infrastructure lands across phases as each phase needs it. These support the product; they are not
the product.

- managed Postgres and object-storage backends;
- hosted and self-hostable deployment modes, with sovereign/self-hosted operation remaining first-class;
- a durable-execution substrate for the spine as concurrency and long-suspended approvals outgrow the local SQLite engine;
- tool registry and scoped tool grants for MCP, HTTP APIs, SaaS tools, and internal systems;
- real model-provider routing;
- sandboxed browser, shell, file, and API workers;
- multi-user authentication and permissions;
- organization, role, capability, and policy templates or packs once core contracts are stable enough to reuse;
- enterprise deployment patterns for regulated environments.

## Non-Goals

OpenMAO should not become:

- a governance, policy, or audit control plane as its product identity;
- another agent-orchestration framework competing on the inner loop;
- a per-framework plugin, or a product fused to any single agent framework or model;
- a replacement for every agent framework;
- a generic, human-only project-management app;
- a tool that lets external runtimes own OpenMAO truth;
- a system that silently mutates collective memory or authority boundaries;
- a system that grants autonomy it has not earned, or that auto-applies org changes without human authorization;
- a default path for live external side effects without explicit approval and auditability.

Work management is native rather than delegated to an external tracker: OpenMAO owns the work it
governs. Grouping work into projects, expressing recurring work through the existing standing-obligation
schedule, and the operator surfaces over both extend the current work-item spine — they add no new
kernel vocabulary, and they do not precede the Phase 1 acceptance criteria. Matching a dedicated
tracker's planning surface is not an acceptance criterion at any phase, and sync with an external
tracker is a later opt-in, never a dependency. See `NORTH_STAR.md` for the two rules that bound
this.
