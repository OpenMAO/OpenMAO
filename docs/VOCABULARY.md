# OpenMAO Vocabulary

OpenMAO uses native names for its organizational substrate concepts. This page maps product vocabulary
to the current contract model names. If a concept is not listed here, defer to
[docs/ARCHITECTURE.md](./ARCHITECTURE.md) and the executable contracts in
[ts/src/contracts/models.ts](../ts/src/contracts/models.ts).

A few contract types are marked below as reserved (defined in the contracts but not yet wired into
the runtime); their hard removal is a future breaking change staged for founder ratification, not
done here.

## Positioning Terms

| Term | Meaning |
| --- | --- |
| Organizational substrate | The durable place where AI work lives: work items, owners, reviewers, lifecycle, policy, approvals, memory consequences, events, and world-model state. |
| Execution layer | The agent framework, worker, tool loop, model provider, or workflow engine that executes a bounded task. |
| Reference worker | An example external worker used to prove OpenMAO's integration boundary. It is interchangeable and must not become OpenMAO's spine or source of truth. |
| Framework adapter | A translation layer between OpenMAO work envelopes and an external runtime's native task/run shape. The adapter executes no OpenMAO truth directly. |
| Tool | A concrete external system an agent wants to use: MCP server, API, database, browser, shell, file surface, SaaS product, or internal service. |
| Capability | The OpenMAO-governed declaration that exposes a tool action with schema, provider, risk, credential handle, policy, approval, and audit semantics. |
| Enforced capability | A side-effecting action that can only execute through an OpenMAO-managed provider or credential broker, after policy and approval checks. |
| Credential broker | The component that resolves a non-secret `cred_*` handle to the underlying secret inside provider code at execution time; the secret never reaches a worker, capability call, result, event, or trace. |
| Credential handle | A non-secret `cred_*` identifier a capability is bound to; the gateway requires a call's handle to match the capability's declared handle so a worker cannot select another configured secret. |
| Cooperative integration | A worker voluntarily calls OpenMAO to record or request governance actions. Useful, but weaker than enforced capability access. |
| System of record for AI work | OpenMAO's role: preserving the accountable work history and organizational consequences across runs, agents, tools, and frameworks. |
| Organizational memory | The governed memory plane where individual observations, artifacts, and decisions can become trusted collective knowledge through promotion. |
| Governed self-learning | The loop where OpenMAO proposes improvements to roles, policies, workflows, memory, and capabilities based on observed evidence, subject to review. |
| Autonomy dial | The gradual widening of what the organization may do without per-action human approval, based on audited evidence of safe operation. |
| Self-correcting organization | The long-term target: an organization that uses governed memory, audit, and world-model evidence to propose and ratify improvements to its own behavior and structure. |

## Canonical Types

| Concept | OpenMAO type | Notes |
| --- | --- | --- |
| Workspace (tenant) | `Workspace` | Every persisted resource carries `workspace_id`. |
| Organization | `Organization` | Holds `mission`, `vision`, `values`, `goals` as fields. |
| Mission | field on `Organization` | Not a standalone type in the current contracts. |
| Goal | `Goal` | Independent because goals outlive missions and have lifecycle. |
| Role | `Role` | Purpose, permissions, capability grants, reports-to. |
| Agent | `Agent` | Role-bound worker with private memory scope. |
| External worker identity | `WorkerIdentity` | Registered external runtime principal with allowed capabilities and status. |
| Unit of work | `WorkItem` | Accountable: owner, reviewer, criteria, risk, gates. |
| Delegated task | `TaskEnvelope` | Bounded handoff between spine and agent. |
| External handoff | `BoundedWorkEnvelope` | Bounded envelope issued to an external worker: objective, allowed capabilities, gates, expiry. |
| Agent return | `AgentOutcome` | Structured outcome with artifacts and cost. (reserved; not yet wired — staged for removal pending founder ratification) |
| Worker return | `WorkerOutcome` | Idempotent outcome submitted by an external worker against an envelope. |
| Execution unit | `Run` | Status includes `suspended_approval`. |
| Tool (declared record) | `Tool` | Declared external system record with kind, provider, scopes, and credential policy. (reserved; not yet wired — staged for removal pending founder ratification) |
| Capability (declaration) | `Capability` | Canonical input/output schemas. |
| Capability invocation | `CapabilityCall` | Persisted before approval evaluation. |
| Capability result | `CapabilityResult` | Output, artifacts, status. |
| Memory entry | `MemoryEntry` | Scope is `individual` or `collective`. |
| Promotion proposal | `PromotionCandidate` | Individual memory to collective memory requires approval. |
| Corroboration | `Corroboration` | Independent evidence (distinct actor and memory entry) supporting a promotion; raises confidence, never replaces approval. |
| Artifact | `Artifact` | Structured output with content hash. |
| Policy | `Policy` | Human-readable policy text in the current release. (reserved; not yet wired — staged for removal pending founder ratification) |
| Policy outcome | `PolicyDecision` | `allow`, `block`, `require_approval`, `log_only`. |
| Approval | `ApprovalRequest` | Resumes run or applies without run. |
| Evaluation | `Evaluation` | Rubric-driven scoring. (reserved; not yet wired — staged for removal pending founder ratification) |
| Audit event | `Event` | Workspace-local `seq`, optional `run_seq`. |
| Ingested external evidence | `IngestionRecord` | Idempotent record of an externally submitted event, trace, outcome, artifact, or memory proposal. |
| Run trace node | `Trace` | Required for every graph node. |
| Idempotency record | `NodeEffect` | Tracks one-time side effects per node. |
| Model request | `ModelRequest` | All inference routes through here. |
| Model response | `ModelResponse` | Persisted with cost. |
| Org change proposal | `OrgChangeProposal` | Evidence-backed proposal for a reviewed role, policy, SOP/workflow, memory, capability, or org-graph change. |
| Change evidence | `OrgChangeEvidence` | Typed, weighted reference backing a proposal, notification, or autonomy case. |
| Applied org change | `OrgChangeApplication` | First-class record of an applied change with hashed before/after target state for verification and revert. |
| Apply kill-switch | `OrgControlState` | Workspace-scoped control state; `apply_paused` halts the apply engine while sense/report stays live. |
| Autonomy widening case | `AutonomyCase` | Human-ratified, evidence-backed request to widen the autonomy dial one step. |
| Standing obligation | `Cadence` | Organization-of-record schedule that any worker can read or advance. |
| Operator notification | `Notification` | Evidence-backed, actor-attributed observation delivered to the operator. |
| Operational view | `WorldModelSnapshot` | Materialized projection from events; cache only. |
| Collective memory summary | `CollectiveMemorySummary` | World-model projection of a collective entry: kind, confidence, corroboration count. |

## Notable Splits

Three places where OpenMAO's vocabulary diverges from common usage. Each split is intentional.

### Task → `WorkItem` + `TaskEnvelope`

OpenMAO splits "task" into two types because they answer different questions.

- `WorkItem` is *what* must be done: objective, owner, reviewer, success criteria, risk, approval gates. It outlives any single execution attempt.
- `TaskEnvelope` is *how* a piece of work is handed to an agent for one run: bounded objective, allowed capabilities, context refs.

One `WorkItem` can produce many `TaskEnvelope`s across retries or re-delegations.

Operator-facing surfaces label `WorkItem` as **task**, and a grouping of work items as
**project** — never *issue*. The kernel type names do not change; the labels are a
presentation-layer mapping, and developer names stay available behind a toggle. Recurring work is
expressed through `Cadence`, the existing standing obligation, rather than a new type.

### Organizational State → OpenMAO + Execution Runtime

OpenMAO owns organizational state, while execution frameworks own their internal execution state.

- OpenMAO owns work item lifecycle, ownership, review, policy decisions, approvals, memory promotion,
  events, traces, and world-model projection.
- Execution frameworks own model calls, tool-loop internals, provider-specific retries, transient
  scratchpads, and task-local planning.

This keeps OpenMAO from becoming a replacement for every agent framework while still making it the
system of record for AI work.

Runtime-specific adapters should pass the replacement test: if a team swaps one execution runtime
for another, OpenMAO's work items, authority decisions, approvals, memory consequences, events, and
world model still remain intact.

### Cooperative Governance → Enforced Capability Access

OpenMAO distinguishes advisory integration from enforceable integration.

- Cooperative governance means a worker calls OpenMAO because it is designed to do so.
- Enforced capability access means the worker cannot perform a risky side effect without going
  through OpenMAO because the provider credentials or capability handles live behind OpenMAO.

The enforced path is the stronger product boundary for actions such as sending, spending, deploying,
writing, exporting, or mutating shared systems.

### Tool → Capability → Provider

OpenMAO separates what agents want to use from how access is governed.

- A **tool** is the external thing: GitHub, Gmail, Slack, Postgres, an MCP server, a browser, a shell,
  a filesystem, or a private API.
- A **capability** is the OpenMAO contract for a specific action on that tool: name, input/output
  schema, risk, grants, approval behavior, idempotency, and audit payload.
- A **provider** is the implementation that executes the approved capability call and resolves any
  credential handles internally.

This split lets OpenMAO govern tool access without becoming the tool itself.

### WorldModelEvent → `Event` + `WorldModelSnapshot`

OpenMAO is event-recorded and projection-based.

- `Event` is the durable atomic record of something that happened.
- `WorldModelSnapshot` is a materialized projection over events and source state. It is a cache, not
  a source of truth. The world model never writes events; events and source stores feed the world
  model.

### Mission → field on `Organization`

`Mission` is not its own model because the current contract treats a mission as an immutable
statement owned by exactly one `Organization`. If multi-mission organizations ever exist, mission
may become its own type.

## See Also

- [ARCHITECTURE.md](./ARCHITECTURE.md) — current architecture and module ownership.
- [../ts/src/contracts/models.ts](../ts/src/contracts/models.ts) — executable contract definitions.
- [ROADMAP.md](./ROADMAP.md) — where OpenMAO goes next.
- [V0_SCOPE.md](./V0_SCOPE.md) — first-release scope and deferrals.
