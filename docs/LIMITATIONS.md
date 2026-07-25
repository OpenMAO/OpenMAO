# Known Limitations

**Status:** maintained honesty document. Last reviewed 2026-07-25.

A governance project should state its own boundaries instead of letting reviewers discover them.
Every claim below is meant to match the code on `main`. If a statement here overstates or
understates what the code does, that is a bug — please open an issue.

Each limitation links the tracking issue where one exists.

## 1. Enforcement is credential ownership plus deployment discipline

The capability gateway, policy checks, and credential broker run inside the OpenMAO process. An
agent can take a governed side effect only through the gateway, because the broker holds the real
secret and resolves it inside the provider at execution time; agents hold opaque handles and have
nothing to authenticate with on their own.

What this does not cover: if an operator hands a worker raw credentials outside OpenMAO, that
worker is ungoverned. No software layer here can prevent that. "Non-bypassable" therefore means
bypassable only by violating the deployment contract, not by anything an agent can do inside it.
The topology that makes enforced mode true — and what each deployment mode actually provides —
is now stated in [DEPLOYMENT_MODES.md](DEPLOYMENT_MODES.md) ("Enforced-mode topology"). Making
the boundary provable rather than asserted — execution-claim events that are verifiably distinct
from worker self-reports, plus omission detection — is
[#111](https://github.com/OpenMAO/OpenMAO/issues/111), with the contract-level design settled in
[ADR-0013](adr/ADR-0013-reconcilability-as-a-capability-property.md).

## 2. The platform trust boundary on main is weaker than the capability boundary

Per-worker scoped tokens ([#102](https://github.com/OpenMAO/OpenMAO/issues/102)) and the
approval-integrity fixes — proposer must not approve, blank-actor rejection, a production
corroboration floor ([#101](https://github.com/OpenMAO/OpenMAO/issues/101)) — are now on `main`
(2026-07-25). Workers authenticate with their own scoped, default-deny tokens; their actor and
workspace are forced to the resolved identity and cannot be spoofed through headers.

What remains: the *operator* surface still uses a single shared token with a self-asserted actor
header, so a holder of the operator token can act as any operator-side actor. Binding acting
identity at the HTTP boundary and a first-class Member/Principal model are
[#92](https://github.com/OpenMAO/OpenMAO/issues/92) and
[#93](https://github.com/OpenMAO/OpenMAO/issues/93). Until then, treat the operator token as
single-trusted-operator.

## 3. At-most-once has a crash window at the provider edge

OpenMAO guarantees at most one provider invocation per capability call (durable intent before
execution, node-effect and in-flight guards, restart-replay tested). It cannot guarantee remote
exactly-once: if a request times out after the remote system performed the effect but before the
result is recorded, the call is recorded as failed even though the effect exists. The GitHub
provider documents this window and the reconciliation step. Scope: the durable node-effect guard
holds **per backing database** — multi-replica deployments that do not share the backing store
are outside the verified claim. Making the window detectable (intent-without-outcome
reconciliation) and fault-injection-verifying it is part of
[#111](https://github.com/OpenMAO/OpenMAO/issues/111) /
[ADR-0013](adr/ADR-0013-reconcilability-as-a-capability-property.md).

## 4. The event log is tamper-evident; two auditability gaps remain

Events are append-only (enforced with SQL triggers) and hash-chained (SHA-256, each event carrying
the previous event's hash back to a fixed genesis value), the intended call is logged before
execution, and chain verification has a one-command operator surface (`openmao verify-chain`,
[#119](https://github.com/OpenMAO/OpenMAO/issues/119), shipped). Two gaps: events do not yet carry
an expected-vs-actual decision envelope that would make regressions detectable from the log alone
([#114](https://github.com/OpenMAO/OpenMAO/issues/114)), and events reported by cooperative
workers are attested by the worker, not yet provably distinct from enforced-path events
([#111](https://github.com/OpenMAO/OpenMAO/issues/111)).

## 5. Resolved: the demo covers approve and deny

`make demo` and `make demo-approve` show suspend-on-approval, durable resume, and the promoted
memory; `make demo-deny` ([#118](https://github.com/OpenMAO/OpenMAO/issues/118), shipped) shows a
rejected approval and a blocked ungranted call on the record. Kept here so the section numbering
below stays stable.

## 6. The self-correction loop is partially real

Learning signals and organization-change proposals are real and deterministic. But exactly one
change type has a real applier today (memory cleanup); every other "applied" change is recorded
truthfully as `acknowledged` — a decision on the record, not a changed behavior — and is
revertible/withdrawable from the operator surface
([#105](https://github.com/OpenMAO/OpenMAO/issues/105), shipped). The causal-diagnosis layer is a
library with tests, advisory by design, with no operator surface. Autonomy *narrowing* is now
automatic on ratified evidence with a CLI surface (`autonomy narrow`,
[#120](https://github.com/OpenMAO/OpenMAO/issues/120)); the *widening* service exists with tests
but still has no CLI, API, or console surface — autonomy cannot be widened in a running
deployment yet, which is the intended asymmetry until it can.

## 7. Resolved: memory provenance is a hard invariant

Provenance is now mandatory ([#113](https://github.com/OpenMAO/OpenMAO/issues/113), shipped):
every memory entry derives a trust tier from its provenance — a capability result, an event, or a
proof-backed operator attestation — and promotion, corroboration, and recall are all
provenance-gated. Unprovenanced memory is permanently untrusted: excluded from recall and the
world model by default, promotable never. Kept here so the section numbering below stays stable.

## 8. Single human operator, single organization

There is no Member model. Multi-human roles (separate proposer, approver, board), and structural
multi-tenant isolation, are future work. Workspace isolation today is logical, not enforced
per-tenant. The supported deployment is a single organization in local mode (see
[DEPLOYMENT_MODES.md](DEPLOYMENT_MODES.md)).

## 9. No mid-run revocation channel

Approval gates run before execution, and evidence-triggered grant suspension
([#120](https://github.com/OpenMAO/OpenMAO/issues/120)) now narrows an actor's grants
automatically — but both act on *future* calls. Once a long-running bounded task is underway,
there is no built-in way to revoke a call already in flight. A mid-flight revocation channel is
part of the capability-scoping design work
([#112](https://github.com/OpenMAO/OpenMAO/issues/112), ADR-0011).

## 10. Action governance, not reasoning governance

OpenMAO governs what agents do — capability calls, work, memory — not what models think. A prompt
injection can still shape what an agent proposes. The gate bounds the blast radius to deniable,
auditable actions; it does not sanitize cognition.

## 11. No runtime sandbox

OpenMAO does not confine the filesystem, network, or process behavior of worker processes. That is
a different layer; compose OpenMAO with a runtime sandbox if you need it. See
[POSITIONING.md](POSITIONING.md) for how the layers relate.

## 12. Scale honesty

The spine is local SQLite with a deterministic demo topology. No Postgres, no multi-replica, no
multi-run concurrency target yet. The design intent is to sit on a durable-execution substrate when
deployments outgrow the local spine.

## OWASP Agentic Top 10 mapping

Status against the OWASP Top 10 for Agentic Applications (December 2025), stated honestly:

| Risk | Where OpenMAO stands today | Open gap |
| --- | --- | --- |
| Tool misuse | Addressed: deny-by-default capability grants, typed schemas, approval gates, broker-held credentials, per-worker scoped tokens | Per-call scoped-credential minting (ADR-0011) |
| Human-agent trust exploitation | Addressed: approvals are durable state with recorded rejection; proposer must not approve; production corroboration floor ([#101](https://github.com/OpenMAO/OpenMAO/issues/101)) | Structural multi-human separation of duties ([#94](https://github.com/OpenMAO/OpenMAO/issues/94)) |
| Identity abuse | Partial: workers hold scoped, unspoofable identities ([#102](https://github.com/OpenMAO/OpenMAO/issues/102)); the operator surface is still a shared token | [#92](https://github.com/OpenMAO/OpenMAO/issues/92), [#93](https://github.com/OpenMAO/OpenMAO/issues/93) |
| Memory poisoning | Addressed: human-ratified promotion, independent corroboration, provenance as hard invariant with provenance-gated recall ([#113](https://github.com/OpenMAO/OpenMAO/issues/113)) | Audit-payload hardening ([#80](https://github.com/OpenMAO/OpenMAO/issues/80)) |
| Rogue agents | Partial: autonomy starts advisory and bounded; evidence-triggered suspension narrows grants automatically, widening is human-only ([#120](https://github.com/OpenMAO/OpenMAO/issues/120)) | No mid-flight revocation (§9); widening has no operator surface (§6) |
| Cascading failures | Partial: bounded work envelopes, at-most-once invocation guards | Provider-edge crash window (§3) |
| Goal hijacking | Out of scope: reasoning-layer risk; the gate bounds blast radius (§10) | — |
| Code execution | Out of scope: runtime-sandbox layer (§11) | — |
| Insecure communications | Out of scope in local mode: transport security is the deployment's responsibility | Revisit for networked modes |
| Supply chain | Out of scope today: no plugin marketplace; standard dependency hygiene applies | — |

"Out of scope" rows are deliberate: OpenMAO composes with the layers that own those risks rather
than claiming them.
