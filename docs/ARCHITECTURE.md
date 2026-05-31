# OpenMAO Architecture

OpenMAO is the organizational substrate for AI-native work. It is where work items, ownership,
authority, approvals, memory consequences, event history, and the world model live.

The project direction is defined in [NORTH_STAR.md](../NORTH_STAR.md): organizations that run
themselves, accountably. This architecture is the safety and memory substrate for that direction,
not just a governance control plane.

Agents, tools, workflows, and external runtimes may execute bounded tasks, but OpenMAO remains the
system of record for the work and its organizational consequences.

For high-risk capabilities, OpenMAO must be in the execution path. Governance is enforceable only
when agents receive capability access through OpenMAO-managed providers or credential brokers, not
through raw credentials they can use directly.

The product principle:

> Bring your agents and tools. OpenMAO gives the work a place to live.

## Vision

OpenMAO is designed to support four long-term organizational capabilities:

1. **Enforced actions:** high-risk work routes through OpenMAO-managed capabilities before execution.
2. **Governed tools:** agents use business tools, MCP servers, APIs, databases, browsers, shells,
   file systems, and SaaS products through scoped OpenMAO tool/capability contracts.
3. **Trusted memory:** individual observations and artifacts become collective memory only through
   governed promotion.
4. **Self-learning:** repeated blockers, missing capabilities, stale memory, weak handoffs, and
   policy gaps become proposed improvements instead of silent drift.

OpenMAO should help an AI-native organization remember what happened, understand what is true,
improve how it works, and stay accountable to human authority.

Governance makes that path safe; institutional memory, self-correction, and earned autonomy are the
compounding direction.

## Core Invariants

A change that violates these invariants is a bug.

1. OpenMAO owns organizational truth.
2. Work items, owners, reviewers, lifecycle, approvals, memory consequences, event history, and world-model truth live in OpenMAO.
3. Every state-changing action goes through services and emits an event.
4. Shared memory changes only through promotion and approval.
5. High-risk capability execution is enforced before it runs; agents must not receive raw credentials that bypass OpenMAO.
6. State-changing UI and API paths are adapters over services; they do not orchestrate or write
   directly to storage.
7. The world model is a rebuildable projection, not a source of truth.
8. External runtimes can execute bounded tasks, but they cannot own policy, approval state, collective memory, events, or organizational work lifecycle.
9. The default local demo requires no external credentials, live LLM calls, hosted services, or networked tools.

## Product Shape

OpenMAO models the durable substrate under AI work:

- **Workspace:** local tenant boundary for runs, state, memory, and events.
- **Organization:** mission, roles, policies, goals, and operating context.
- **Role:** responsibility, permissions, capability grants, and reporting structure.
- **Agent:** role-bound worker with scoped memory and model binding.
- **WorkItem:** accountable unit of work with owner, reviewer, criteria, risk, and gates.
- **Run:** one execution attempt over work.
- **Tool:** external system, API, MCP server, browser, shell, file surface, or SaaS product an agent
  wants to use.
- **Capability:** governed declaration that exposes a tool action through canonical schemas, risk,
  provider, credential handle, policy, approval behavior, and audit semantics.
- **ApprovalRequest:** durable human gate for high-risk actions.
- **MemoryEntry:** individual or collective knowledge.
- **PromotionCandidate:** proposal to move individual memory into trusted collective memory.
- **Corroboration:** independent, auditable evidence (a distinct actor and a distinct memory entry) supporting a promotion candidate; it raises confidence and can gate ratification, but human approval still governs the collective write.
- **OrgChangeProposal:** evidence-backed proposal to review or improve roles, policies, SOPs,
  workflows, memory, capabilities, or org graph.
- **Event:** durable record of what happened.
- **Trace:** run-node execution record.
- **WorldModelSnapshot:** materialized operational view built from source state.

The executable contracts live in [ts/src/contracts/models.ts](../ts/src/contracts/models.ts), and
the generated portable schema lives in [schemas/canonical/v0.schema.json](../schemas/canonical/v0.schema.json).

## Layer Model

```text
OpenMAO work items, roles, policies, approvals, memory, events, world model
  -> bounded work envelopes and governed capability adapters
  -> agents, tools, external runtimes execute tasks
  -> high-risk capabilities route back through OpenMAO-managed providers
  -> outcomes, traces, artifacts, and memory proposals return to OpenMAO
  -> CLI, API, operator console inspect the organizational record
```

## Concern Ownership

| Concern | Owner |
| --- | --- |
| Canonical contracts and IDs | `ts/src/contracts/` |
| SQLite schema and stores | `ts/src/persistence/` |
| Workspace-local events and audit records | `ts/src/persistence/events.ts` |
| Runs, checkpoints, and node effects | `ts/src/persistence/runs.ts`, `checkpoints.ts`, `effects.ts` |
| Organization and role registry | `ts/src/org/` |
| Policy decisions and approvals | `ts/src/governance/` |
| Capability registry and providers | `ts/src/capabilities/` |
| Memory promotion, corroboration, and evidence-backed retrieval | `ts/src/memory/` |
| World model projection | `ts/src/world/` |
| Deterministic model routing | `ts/src/modeling/` |
| Control spine and demo flow | `ts/src/spine/` |
| Local runtime wiring | `ts/src/runtime/` |
| HTTP API and console | `ts/src/api/` |
| CLI | `ts/src/cli.ts` |
| Reversible org-change apply and revert | `ts/src/org/apply.ts` |
| Advisory causal diagnosis | `ts/src/diagnosis/` |
| Earned-autonomy dial | `ts/src/org/autonomy.ts` |
| Chief of Staff loop and heartbeat | `ts/src/chief_of_staff/`, `ts/src/heartbeat/` |
| External-worker capability initiation and network SDK | `ts/src/api/server.ts`, `ts/src/sdk/` |

## Substrate Boundary

OpenMAO owns organizational state, not every execution detail.

| OpenMAO owns | Execution layer owns |
| --- | --- |
| Work item and objective | Execution of a bounded task |
| Owner, reviewer, role, and authority | Model calls, tool loops, and worker-local planning |
| Lifecycle: queued, in progress, blocked, review, done | Framework-specific internal steps and retries |
| Handoffs between roles/workers | Per-task scratchpads and transient context |
| Policy decisions and approval state | Provider-specific execution details |
| Capability grants, credential handles, and risk classification | How a provider performs an approved action |
| Cross-run memory and promotion | Per-run working memory |
| Workspace event log and world model | Per-call telemetry unless ingested into OpenMAO |

The word "run" can appear on both sides of this boundary. OpenMAO owns the organizational run or
work state: what is assigned, blocked, approved, reviewed, or complete. Execution frameworks may own
their internal run state: retry counts, model steps, tool-loop checkpoints, or provider-specific
execution graphs.

### Framework Neutrality

External frameworks are interchangeable workers under OpenMAO authority. A LangGraph, CrewAI,
OpenAI Agents SDK, Hermes, script, cron job, or human-operated worker may execute bounded work, but
none of them defines OpenMAO's canonical contracts, lifecycle, approval model, memory model, audit
events, or world model.

Reference adapters must prove the boundary without narrowing the product category. The adapter can
translate an OpenMAO work envelope into the worker runtime's native shape and translate the outcome
back into OpenMAO contracts. It must not make the external runtime OpenMAO's spine, checkpointer,
policy engine, credential holder, memory authority, or source of organizational truth.

The portability test is simple: if a team replaces one execution runtime with another, OpenMAO
should still preserve the same work history, authority decisions, approvals, capability records,
memory consequences, and world-model projection.

## Control Spine

The spine is the only component that coordinates organizational work. It creates runs, checkpoints
state, routes handoffs, invokes workers through bounded envelopes, evaluates capability boundaries,
suspends for approval, resumes after approval, writes traces, and updates source state through
services.

The deterministic local demo also bootstraps its default organization, roles, agents, work item, and
mock capability through the spine so the release can run without external files or credentials. That
bootstrap is demo fixture wiring, not a second owner for organization or capability semantics.

The local release supports one active non-terminal run per workspace. This keeps approval/resume and
idempotency behavior deterministic. A run in `queued`, `running`, or `suspended_approval` holds the
workspace active-run lock; the lock is released only when the run reaches `completed` or `failed`.

## Approval Flow

Approval is durable state, not an in-memory callback.

1. A service creates an `ApprovalRequest`.
2. OpenMAO emits `approval.requested`.
3. The run is checkpointed with `status = "suspended_approval"` when the approval is run-scoped.
4. API, CLI, or console approval records `approval.approved` or `approval.rejected`.
5. Approved run-scoped work resumes from persisted state.
6. Rejected work follows its configured rejection behavior.

Approval-required capabilities suspend before provider execution. Resume reloads the persisted
`CapabilityCall` and executes it once through the node-effect/idempotency protocol.

Real providers resolve credentials through a broker: a capability declares a non-secret `cred_*`
handle, the gateway requires a call to use exactly that handle, and the broker resolves it to a
secret inside provider code only — never into a call, result, event, trace, or log. Provider
execution is awaited outside the database transaction, so a network provider cannot hold a
transaction open; at-most-once still holds via the node-effect guard plus an in-process in-flight
join. OpenMAO guarantees at most one provider invocation per call, not remote exactly-once.

## Enforced Capability Boundary

OpenMAO supports cooperative integration paths, but near-term releases should prioritize enforceable ones.

- **Cooperative path:** a worker calls the OpenMAO SDK to record work, ask for approval, or submit
  outcomes. This is useful for well-behaved workers and integrations.
- **Enforced path:** a worker cannot perform a risky side effect unless it calls an
  OpenMAO-managed capability provider. Credentials and provider handles live behind OpenMAO, policy
  runs before execution, approval-required calls suspend before execution, and every result is
  recorded.

Examples of enforced capabilities include sending email, writing to a code repository, updating a
CRM, triggering a deployment, exporting data, issuing a refund, or mutating production systems.

Tools are the concrete external systems behind those capabilities. OpenMAO should not give agents
ambient access to a tool account. It should expose narrow tool actions as capabilities with schemas,
grants, risk, approval behavior, credential handles, idempotency, and audit records.

The enforced path is what makes OpenMAO more than an advisory audit log. If a worker can bypass
OpenMAO with raw credentials, OpenMAO can observe or reconcile after the fact, but it cannot claim to
govern that action.

## Memory Model

OpenMAO separates private working knowledge from trusted organizational memory.

- Agents may write individual memory.
- Collective memory requires a `PromotionCandidate`.
- Promotion requires approval.
- Approved promotion writes markdown-backed collective memory exactly once.
- Collective memory files are outputs of OpenMAO services, not direct UI or agent writes.

## Events, Traces, and World Model

Events are the durable audit trail. Traces describe run-node execution. The world model is a cache
rebuilt from events and source state so operators can inspect what the organization is doing, what is
blocked, what needs approval, and what changed recently.

Deleting a world-model snapshot must not delete truth. Rebuilding it from source state should produce
the same operational picture.

## Institutional Learning

The learning loop reads OpenMAO source state and events, detects repeated operational patterns, and
creates `OrgChangeProposal` records with evidence references. Initial local detectors cover repeated
blockers, failed or blocked handoffs, approval bottlenecks, missing or disabled capabilities, and
stale memory.

Learning proposals are reviewed through approval state. Approval records that a proposal is accepted
for follow-up; rejection records that the proposal was reviewed and declined. Applying an approved
proposal runs through a separate controlled service (`ts/src/org/apply.ts`) with its own authority:
in-transaction verification, reversibility (a revert refuses on content drift), a per-application
blast-radius cap, and proposer/applier separation — it never silently mutates organization
configuration, roles, policies, capabilities, memory, or org graph. Change types without a
registered applier fall back to an explicit audited marker rather than mutating anything.

## Runtime Choices

The current implementation uses:

- TypeScript 5.x
- Node.js 22 LTS
- Zod contracts
- generated JSON Schema
- SQLite
- a lightweight TypeScript HTTP server
- a TypeScript CLI
- Vitest tests

These choices keep the local release easy to install and deterministic while preserving clear seams
for later providers, hosted storage, and external workers.

## Integration Boundary

OpenMAO can integrate with external services, tools, and runtimes through governed adapters. Those
adapters must translate work into OpenMAO-native contracts and return outcomes, events, traces,
artifacts, and memory proposals through OpenMAO services.

Do not clone, vendor, fork, embed, or copy external framework code. New external dependencies require
maintainer approval and tests proving they preserve OpenMAO authority, policy, approval, memory,
event, world-model, and framework-neutrality invariants.
