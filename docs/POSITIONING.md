# Where OpenMAO Fits

This is a short orientation to how OpenMAO relates to the wider ecosystem of agent and AI
infrastructure projects.

Positioning snapshot: May 2026; related-work section refreshed June 2026. This landscape moves
quickly.

OpenMAO is an open, self-hostable organization-of-record for AI-native organizations: the substrate
that owns work, roles, ownership, policy, approvals, memory, and the audit trail, so an organization
of agents and humans can operate accountably and earn autonomy over time. See
[NORTH_STAR.md](../NORTH_STAR.md) for the full charter.

## The Shape of the Ecosystem

Most of the surrounding ecosystem solves one layer, and solves it well:

- **Agent frameworks** orchestrate how individual agents reason and act.
- **Memory layers** give agents and applications recall, personalization, and knowledge retrieval.
- **Governance and control planes** add policy, identity, and guardrails around agent calls.
- **Durable-execution substrates** make long-running, reliable workflows possible.
- **Enterprise autonomous-suite platforms** bring "the business runs itself" to large proprietary
  stacks.

These are complementary capabilities. OpenMAO is designed to sit with them, not to replace them.

## Where OpenMAO Sits

OpenMAO operates at the organization altitude, above any single agent or framework, and ties these
layers into one accountable system of record.

Two properties define the niche:

1. **Open and self-hostable.** The organization owns its substrate, data, memory, and audit trail.
   This matters for sovereignty, regulated environments, and teams that cannot put their operating
   brain inside a closed cloud.
2. **Autonomy is earned.** OpenMAO starts supervised and widens autonomy only on an audited track
   record, with a governed self-correction loop as the long-horizon goal.

In short:

> open + self-hostable + cross-framework + organization-of-record + governed self-correction, as one
> coherent thing.

## How It Composes

OpenMAO is bring-your-own by design: bring your agents, agent framework, model providers, memory
store, and durable-execution substrate.

OpenMAO provides the organizational layer above them:

- accountable work items, owned natively rather than delegated to an external tracker;
- roles, owners, and reviewers;
- policy and approvals;
- promoted institutional memory;
- event and audit history;
- world-model projection;
- evidence-backed improvement proposals.

A reference worker and sensible defaults can help users get started, but nothing is fused. OpenMAO's
value is meant to survive swapping the framework underneath.

## Related Work

This is a non-exhaustive, respectful map of neighboring projects and what they focus on. OpenMAO
complements rather than competes with most of these; the one deliberate overlap is named below:

- **Agent frameworks** such as LangGraph, CrewAI, and OpenAI Agents SDK orchestrate agent reasoning
  and multi-step execution. OpenMAO can govern and learn above any of them.
- **Memory layers** such as Mem0, Zep, Letta, and Cognee provide recall and personalization.
  OpenMAO governs and promotes institutional memory at the organization level and can sit above a
  memory store.
- **Runtime governance toolkits** such as Microsoft's Agent Governance Toolkit provide in-process
  policy checks, identity, and guardrails around individual agent calls, integrating through each
  framework's native extension points, with a deliberately stateless policy engine. They govern the
  moment of the call. OpenMAO operates one altitude up and is stateful by design: it owns the
  durable record the call belongs to — the work item, the approval as durable state that survives
  restarts, the hash-chained log of intent and outcome, and the institutional memory the
  organization keeps. The two compose: an agent instrumented by such a toolkit can run as a worker
  under OpenMAO authority.
- **Runtime sandboxes** confine what an agent process can physically touch — filesystem, network,
  processes — from outside the agent. OpenMAO does not sandbox; it governs which organizational
  actions may happen at all, and records them. Use both layers for defense in depth.
- **Observability and tracing** tools such as Langfuse capture what agents did, for analysis.
  OpenMAO's event log is different in kind: it is the authorizing record, written before execution
  and sealed after it, not telemetry collected alongside.
- **Work trackers** such as Jira, Linear, and Notion own the human work backlog. This is the one
  adjacent category OpenMAO overlaps on purpose: the record that authorizes a task and the record
  that holds it should not be different systems, so work items are native rather than delegated.
  What differs is what the record carries — an OpenMAO work item is delegable to an agent under
  policy, carries the approval and audit trail, and feeds institutional memory. Matching a
  dedicated tracker's planning surface is not the goal, and sync with one is an opt-in
  integration, not a dependency.
- **Policy engines** such as OPA and Cedar evaluate authorization policies given a request.
  OpenMAO's governance gate is a natural place to consult such an engine; OpenMAO additionally owns
  what they do not — approvals as durable state, memory promotion, and the organization-of-record.
- **Durable-execution substrates** such as Temporal, Restate, Inngest, and DBOS make reliable
  long-running workflows possible. OpenMAO is designed to run on top of such a substrate when the
  local spine outgrows simple persistence.
- **Self-improving agents** improve at the agent or skill level. OpenMAO's frontier is governed
  organizational self-correction: the organization revising its own roles, policies, SOPs,
  capabilities, and workflows from evidence.

## Questions That Separate the Layers

When comparing any two projects in this space, including OpenMAO, these questions cut through
shared vocabulary:

1. Can it block an agent from ever holding the raw credential, or does it check calls made with
   credentials the agent already has?
2. Is an approval a durable state that survives a crash, or an in-memory callback?
3. Is the audit trail the authorizing act, written before execution, or telemetry written after?
4. Does anything remember what the organization learned, with governance over how that memory is
   promoted?
5. Does it remain valuable if you swap the agent framework underneath?
6. Where does enforcement physically live — inside the agent's process, or outside it?

OpenMAO's own answers, including the places where they are honest "not yet"s, are in
[LIMITATIONS.md](LIMITATIONS.md).

If a project belongs here, or a description needs correcting, contributions are welcome.
