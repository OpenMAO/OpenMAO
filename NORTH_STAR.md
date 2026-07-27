# OpenMAO North Star

**Status:** canonical direction document. Read this first.

This document defines why OpenMAO exists and where it is going. The architecture, roadmap,
vocabulary, and scope documents define how the current implementation gets there.

Precedence rule:

> When another document or proposed change conflicts with this charter's direction, this charter
> wins on direction. Implementation documents win on current detail. A genuine conflict is escalated,
> not silently resolved by drifting.

The one-line litmus for every decision:

> Does this strengthen an organization's ability to run itself accountably, and does it earn or
> extend autonomy on audited evidence rather than assume it?

## North Star

> **Organizations that run themselves, accountably.**

OpenMAO is the open, self-hostable substrate for self-correcting organizations, where the human role
can recede from operator to board as the system earns trust.

The human does not disappear. The human moves up: from doing the work, to approving the work, to
governing the organization that does the work and intervening by exception. Autonomy is never
granted by default. It is earned through audited, reversible, human-governed widening.

## Vision

A user should be able to define an organization: mission, values, goals, roles, policies,
capabilities, memory, and review loops. OpenMAO should help that organization run increasingly large
parts of itself:

- agents execute and coordinate bounded work;
- the organization learns from outcomes and accumulates institutional memory;
- it proposes improvements to roles, policies, workflows, SOPs, tools, and capabilities;
- humans govern direction and intervene by exception rather than approving every action forever;
- the whole system remains accountable, auditable, reversible, and owned by the organization.

This is not just agents doing tasks. It is a persistent, self-correcting institution.

OpenMAO exists to make that path safe enough to be real.

## Mission

Build the open substrate that makes bounded autonomy safe today and lets autonomy expand on a proven
track record.

OpenMAO gives an organization a self-hostable system of record for accountable AI work:
governance, institutional memory, self-correction, audit, and a live world model that any agent
framework or model can plug into.

The near-term wedge is enforced governance, audit, and accountable work. The destination is the
self-correcting organization.

## The Flywheel

OpenMAO is one mechanism seen from several sides. The product is the loop, not the parts.

| Stage | Role in the loop | Must never become |
| --- | --- | --- |
| Governance and enforcement | Makes actions safe, bounded, and non-bypassable for real side effects. | The whole product identity. It is the substrate, not the differentiator. |
| Institutional memory | Accumulates what the organization learns and promotes evidence-backed knowledge into collective truth. | Mere storage or retrieval. It is the compounding asset. |
| Self-correction | Turns memory and outcomes into better future decisions. | A cosmetic retry loop. It must change future behavior. |
| Self-learning and self-construction | Improves the organization's own structure: roles, policies, SOPs, workflows, tools, and capabilities. | A permanent someday. It is the research frontier and differentiator. |
| Audit and world model | Records and reflects what happened, replayably, as the evidence base for trust. | Compliance theater. It is what earns wider autonomy. |

Each turn of the flywheel, proven in the audit trail, is what justifies widening the autonomy dial.
Anyone can ship one stage. The hard and valuable thing is building the loop.

## Autonomy Dial

Autonomy is a parameter that rises with earned trust, encoded in `Organization.autonomy_level`.
OpenMAO starts tight and widens on evidence.

| Level | Human role | Earned when |
| --- | --- | --- |
| `advisory` | Human does the work; OpenMAO suggests and records. | Default for new or unproven organizations. |
| `supervised` | Agents act; human approves consequential actions. | Governance, audit, and memory behavior are working and trusted. |
| `bounded` | Agents act inside enforced limits; humans approve high-risk or out-of-bounds actions. | The organization has a reliable record inside the enforced perimeter. |
| Future `board-governed` | Agents run operations; humans govern strategy and policy, intervening by exception. | A long audited record of safe self-correction, not a feature flag. |

Autonomy is always reversible.

## Differentiator

OpenMAO's differentiator is the institutional-learning loop and organization-of-record altitude:
accountable work over time, owners, reviewers, handoffs, promoted institutional memory,
self-understanding world model, and governed self-construction.

Enforced governance is table stakes. It is required for trust, but it is not enough to make OpenMAO
chosen. Treating governance as the differentiator is drift.

The moat, in order of depth:

1. **Compounding institutional asset:** ratified memory, evolved structure, and audit/world-model
   history. Organization-specific and earned over time.
2. **Trust track record:** audited evidence of safe operation that unlocks more autonomy.
3. **System-of-record lock-in:** accountability, memory, and world-model history across teams and
   frameworks.
4. **Open, self-hostable, sovereign posture:** the distribution and trust position for organizations
   that cannot or will not put their operating brain on a closed hyperscaler.

## Strategic Sequencing

The wedge and destination are complementary.

- **Land:** enforced capability governance, durable approval, audit, and accountable work.
- **Build:** institutional memory and reviewed improvement proposals.
- **Earn:** wider autonomy through a proven record of self-correction.

The failure mode to avoid is mistaking the wedge for the destination. Shipping the governance
substrate while letting the self-correction loop slide into "later" forever is drift.

## Principles

1. **Accountability before autonomy.** Build audit, enforcement, and reversibility before widening
   the dial.
2. **Enforcement, not etiquette.** Real side effects are governed only when the enforcement perimeter
   is non-bypassable. Cooperative integration is allowed, but it is advisory.
3. **Integrate, do not fuse.** External agent frameworks and models are interchangeable workers
   under OpenMAO authority. They must not become the core identity or source of truth.
4. **OpenMAO owns semantics; users own tools.** OpenMAO owns authority, policy, approvals, memory
   promotion, events, work lifecycle, and world model. External runtimes execute bounded work.
5. **The world model is a projection.** It is rebuildable from events and source state, never source
   of truth.
6. **The organization owns its asset.** Memory, structure, and audit history must remain portable
   and self-hostable.
7. **No speculative kernel.** Add vocabulary only when it has a real owner, real behavior, and real
   tests.

## Non-Goals

OpenMAO is not:

- just a governance, policy, or audit control plane;
- another agent orchestration framework competing on plan/act/observe loops;
- a per-framework plugin;
- fused to one agent framework or model;
- a drop-in replacement for Jira, Linear, Notion, Slack, Gmail, Drive, GitHub, Salesforce, or
  internal apps;
- a generic, human-only project-management app;
- a system that grants autonomy it has not earned;
- a hosted, vendor-locked product;
- an uncontrolled swarm of free-acting agents.

One clarification, because the work-management line is easy to misread in both directions.
OpenMAO owns the work it governs, natively: the record that authorizes a task and the record
that holds it should not be different systems. Today that is the work item — objective, owner,
reviewer, success criteria, risk, approval gates. Grouping work into projects, expressing
recurring work through the standing-obligation schedule, and the operator surfaces over both are
direction, not shipped capability. Two rules bound that direction:

1. **Agent-native, not a human-only clone.** Every unit of work is delegable to an agent,
   governed by approvals and earned autonomy, and feeds institutional memory. The differentiator
   is the institutional-learning loop wrapped around the work — memory that compounds and
   autonomy earned on an audited record — not the absence of task management, and not governance,
   which is table stakes.
2. **Operator-first vocabulary.** Operator surfaces say *task* and *project*, never *issue*;
   operators are not all software teams.

Matching a dedicated tracker's planning surface is not the goal, and sync with an external
tracker is a later opt-in, never a dependency.

## Drift Test

Before adding or changing anything, a builder or reviewer should answer the relevant questions.
A "no" is a signal to escalate the decision.

1. **Flywheel:** Does this strengthen one stage of the loop and keep the loop whole?
2. **Substrate, not identity:** Does this treat governance as foundation rather than the entire
   product identity?
3. **Earned autonomy:** Does this help autonomy be widened on audited evidence?
4. **Swap test:** Would OpenMAO remain valuable if the user replaced the underlying framework or
   model tomorrow?
5. **Real enforcement:** If this claims enforcement, is it non-bypassable rather than cooperative?
6. **Wedge vs destination:** Is this building the wedge without abandoning the self-correcting
   organization?
7. **Ownership:** Does this keep the organization's institutional asset owned, portable, and
   self-hostable?

## Hard Truths

- Self-correction is the open problem. Agents can loop, compound errors, and misdiagnose cause.
  OpenMAO treats self-correction as the research frontier, not a switch to flip.
- More autonomy demands stronger governance, not weaker governance.
- Demand for the full autonomous-company vision is ahead of the market. The v0/v1 wedge is how
  OpenMAO earns adoption while the deeper asset forms.
- Consensus can hide drift. The differentiated bet is the self-correcting organization, and it must
  stay visible in roadmap and implementation.

## Relationship to Other Documents

- `NORTH_STAR.md` defines why OpenMAO exists and where it is going.
- `README.md` introduces the project to new contributors and users.
- `docs/ARCHITECTURE.md` defines current architecture, invariants, and module ownership.
- `docs/ROADMAP.md` stages the path from wedge to flywheel to wider autonomy.
- `docs/V0_SCOPE.md` defines what the first release ships and defers.
- `docs/VOCABULARY.md` defines canonical terms.
- `GOVERNANCE.md` and `SECURITY.md` define project process and safety expectations.

If any document drifts from this direction, update the lower-level document or escalate the conflict.
