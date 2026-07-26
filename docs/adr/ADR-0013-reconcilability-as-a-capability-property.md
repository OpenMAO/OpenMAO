# ADR-0013: Reconcilability as a Declared Capability Property

**Status:** Accepted (ratified 2026-07-25; revision 1 same day — see Revision History)
**Date:** 2026-07-25
**Proposed by:** Converged design thread on [#111](https://github.com/OpenMAO/OpenMAO/issues/111) (maintainer + external collaborators Whatsonyourmind and hypeprinter007-stack; provenance is the public issue thread)
**Owner:** Human Product Owner

---

## Context

Issue #111 makes the enforced/cooperative boundary provable rather than asserted. The audit
question is not "is this gateway claim true?" but its inversion: **the effect is evidence a claim
should exist.** For every externally-observable effect there must be a matching gateway claim, and
for every recorded intent a terminal outcome. Two reconciliation directions, two failure classes:

- **effect-without-claim** — a worker reached an outward door and the gateway never recorded it: a
  perimeter breach, the most serious class.
- **intent-without-outcome** — the process died between the external commit and the outcome
  record: a liveness / at-most-once gap, recoverable.

These two directions require two different read-back operations. Answering
"did the effect for *this known call* happen?" starts from a claim; answering "what effects exist
that I hold *no* claim for?" starts from the world. An interface that supports only the first
cannot detect the second — and the second is the class this ADR exists to make detectable.

Reconciliation can only backstop capabilities whose effects are recoverable from evidence we hold.
Fire-and-forget effects, and providers with no queryable receipt, cannot be reconciled — which is
exactly where omission hides. That makes reconcilability a property the contract must carry, not
an implementation detail.

## Decision

### 1. The declared field

`CapabilitySchema` gains:

```
reconcilable: "receipt" | "downstream_state" | "none"   (default "none")
```

- `receipt` — the effect echoes a gateway-minted correlation id we persist; reconciliation reads
  it back directly.
- `downstream_state` — no echoed id, but the effect is observable in queryable downstream state.
- `none` — not recoverable from any evidence we hold.

The zod default is `"none"`: an omitted field deserializes to the most-restrictive value at the
schema layer, so a caller can never gain autonomy by omission. The fail-closed-default precedent
in the contract is `default_permission` (which defaults to `approval_required`); `side_effecting`
and `risk_level` default permissive and are instead coerced upward at the gate — `reconcilable`
combines both disciplines: restrictive default *and* upward coercion.

### 2. The provider declaration and the two read-back directions

The `CapabilityProvider` runtime type gains three members:

```
reconcilable?: "receipt" | "downstream_state" | "none"        (absent → "none")
observeEffect?(call: CapabilityCall): Promise<EffectObservation>
listEffects?(window: EffectWindow): Promise<ObservedEffect[]>
```

Absent `reconcilable` collapses to `"none"` — a provider predating the field is automatically
most-restricted, never silently trusted (the same rule as the intrinsic `sideEffecting`
declaration).

- **`observeEffect` (outcome direction, claim → effect).** Queries the provider for evidence of
  the effect of one known call. Detects **intent-without-outcome**. Required for any declared
  level above `none` — a declaration without it is decorative and is treated as a mismatch.
- **`listEffects` (discovery direction, effect → claim).** Enumerates externally-observable
  effects in a bounded window (cursor/watermark semantics) so the reconciliation pass can find
  effects for which no gateway record exists. This is the only operation that can detect
  **effect-without-claim** — the breach class. Optional per provider, but its absence is
  recorded as a named coverage gap: a capability whose providers lack `listEffects` is
  **discovery-blind**, and the reconciliation pass must report that blindness per capability
  rather than silently reporting "no breaches".

`EffectObservation` is tri-state — `observed` (with the effect payload and multiplicity),
`absent`, or `unobservable` (provider unreachable / evidence window expired) — never a bare
null. Conflating "the provider was down" with "the effect does not exist" would let an outage
manufacture false liveness-gap violations, and conflating single with multiple observations
would hide a planted or duplicated effect carrying a copied marker.

A terminal `failed` capability result is **not** evidence the remote effect is absent — the
timeout-after-commit window means failed-with-effect is a first-class expected case, and the
reconciliation pass must treat it as a match candidate, not an anomaly.

### 3. Correlation identity is gateway-minted

The correlation id is the recorded capability call's id (`call.id`) — the same key the registry's
durable `NodeEffect` guard already threads (`${call.id}:provider`). One id for dedup *and*
reconciliation, so a call can never be deduped-correct but reconciliation-blind. No second id
family is introduced.

For that id to carry evidentiary weight it must be **gateway-minted, not caller-chosen**. The API
boundary today accepts a caller-supplied call id; under this ADR the rule becomes:

- a **new** capability call gets a server-minted id at first persistence; a caller-supplied id on
  a new call is rejected (or ignored and re-minted — the implementation picks one and tests it);
- a **retry** is matched by `idempotency_key`, returns the already-recorded call, and therefore
  reuses the already-minted id. Retry/idempotency semantics are preserved by keying on the
  idempotency key — never by trusting a caller-echoed id.

Where the correlation id is injected into an outward call or embedded as a marker, the marker is
namespaced and bound to the call (`omao:{workspace_id}:{call_id}` plus an args-hash where the
payload allows), so a copied or guessed marker on an unrelated effect fails the match instead of
laundering an omission into a `matched`.

### 4. The lattice and the gate sites

Effective reconcilability is computed down the lattice `receipt > downstream_state > none`,
fail-closed toward `none`:

```
effective = min(declared, min over bound providers)
```

Min across providers is the weakest link, since any listed provider can serve the call.

**Registration gates the declaration; invoke gates reality.** (`registry.ts` already re-checks
the provider's intrinsic `sideEffecting` at the invoke-time gate regardless of what the
capability record says; this ADR extends that invoke-time re-derivation discipline to
reconcilability and adds the registration-time check that `sideEffecting` never had.)

- **`register()` — reject on contradiction with bound reality.** If one or more of the
  capability's declared providers are bound at registration time, `effective` is computed and a
  declaration exceeding it (including a declared level above `none` whose bound provider lacks
  `observeEffect`) **fails registration**. Loud on config drift, fails before anything binds,
  and the registration path has no liveness cost.
- **Unbound registration is provisional, not vacuous.** If no declared provider is bound yet
  (legitimate registration-before-binding order, and the default credential-free process where
  real providers only bind under explicit environment opt-in), registration succeeds with the
  declaration recorded as **unverified** — and the invoke-time gate below is the unconditional
  enforcement point. A min over an empty set never silently validates an over-claim.
- **invoke — re-derive on every execute path, coerce + warn, never reject.** The gate re-derives
  `effective` against whatever is bound *now*, on **all** paths that reach provider execution:
  the fresh-decision path, the approved-approval resume path, and the recorded-decision replay
  path. (The same three-path discipline the grant-suspension work of #120 had to enforce with
  its resume-time re-check; a gate that only guards the fresh path is bypassed by resuming.)
  Late-binding a weaker provider can never widen a capability that registered clean: the call
  collapses to the stricter gate and a mismatch signal is emitted for the diagnosis pass.
  Rejecting at invoke would turn config drift into a runtime outage for a call that was about to
  be gated synchronously anyway.

The reject-at-registration / coerce-at-invoke asymmetry stands on its own operational argument:
registration is a configuration-time act where failing loud costs nothing and reaches the
operator who caused it, while invoke is a runtime act where the strictest useful response is the
synchronous gate the call was heading for anyway.

### 5. What effective `none` forces — and what it cannot buy

For a **side-effecting** capability whose effective reconcilability is `none`:

- `default_permission` cannot widen past `approval_required`;
- the invoke path forces the synchronous approval gate regardless of caller-declared risk (the
  same higher-of coercion idiom as `risk_level`);
- the autonomy dial cannot widen the grant.

The forcing is scoped to side-effecting capabilities. An unreconcilable *read* is not the
omission threat this ADR exists to close, and forcing synchronous approval on every mock lookup
would make the default local mode unusable. Because `side_effecting` itself defaults false, this
scoping leans on the existing intrinsic-provider coercion (a side-effecting provider forces the
capability and call to be marked side-effecting at the gate); a capability that escapes *that*
net is a misclassification bug in the side-effect gate, not in this ADR's forcing rule.

**Stated honestly: forced approval is authorization control, not omission detection.** For the
`none` class, reconciliation cannot backstop the audit log — an unlogged effect through such a
provider remains undetectable by this mechanism. That blind spot is intrinsic to the class, it
is why the class is gated hardest, and the reconciliation pass must name it as standing coverage
exclusion rather than let "no violations found" imply "no violations".

### 6. Relation to #69

Reconcilability is a fourth classification axis alongside reversibility and blast radius.
[#69](https://github.com/OpenMAO/OpenMAO/issues/69)'s capability classes **consume** the declared
field; they do not own it. This keeps the contract change orthogonal to the payment-gated
perimeter work.

## Consequences

- PR 1 (issue #111 thread): the schema field, the provider members (`reconcilable`,
  `observeEffect`, `listEffects`), and both gate sites — with invoke-site re-derivation on all
  three execute paths — with the contract/registry tests binding to the exported enum. `npm run
  schema:generate` must accompany the contract change — the contracts test asserts the committed
  canonical schema equals the generated bundle. Test (b2) must cover the resume path, not only
  the fresh-invoke path.
- Slice 2: the intent/outcome execution-claim pair becomes auditable events emitted in the same
  transaction as the existing durable `NodeEffect`, closing "enforced provably distinct from
  self-attested".
- Slice 3: the reconciliation pass keys off `reconcilable`/`observeEffect`/`listEffects`,
  reports tri-state (`matched` / `pending` inside the window / `violation` past it), classifies
  effect-without-claim strictly above intent-without-outcome, and reports per-capability
  coverage (outcome-direction, discovery-direction, or none) so blindness is never silent.
- The GitHub issue-comment provider is the honest worked example: its documented
  timeout-after-create reconciliation procedure becomes `observeEffect`; listing an issue's
  comments in a window becomes `listEffects`; and until a correlation marker is recoverable from
  the created comment it registers as `downstream_state`, not `receipt`.
- Scope statement for the at-most-once claim: the durable node-effect guard holds **per backing
  database**. Multi-replica deployments sharing no database are outside the verified claim; the
  crash-window harness (test (a) in the #111 plan) is the verification vehicle.

## Alternatives considered

- **Coerce+warn at registration too.** Rejected: a silently-downgraded capability looks
  registered-clean in the durable record, and the registration path is the one place strictness
  costs nothing.
- **Reject at invoke.** Rejected by both external reviewers independently: config drift would
  become a runtime outage for calls the stricter gate was about to handle synchronously anyway.
- **Reject at registration when no provider is bound.** Rejected: it would fail every
  registration in the default credential-free process (real providers bind only under explicit
  environment opt-in), colliding with the no-credentials-in-default-demo rule. Provisional
  registration + unconditional invoke-time re-derivation keeps the gate non-vacuous without
  breaking the default mode.
- **A single read-back method.** Rejected at revision 1: `observeEffect(call)` alone can only
  answer claim→effect and is structurally unable to detect effect-without-claim, the breach
  class — the tri-model audit's converged finding.
- **Carry the provider's level on the capability contract.** Rejected: `providers` stays
  names-only; the registry owns the bound-provider map and computes the min without widening the
  contract surface.
- **Own the axis inside #69's capability classes.** Rejected: would couple this to the
  payment-gated work; the classes consume the field instead.

## Revision History

**Revision 1 (2026-07-25).** Amended the same day as ratification, before any implementation
began, on a three-model adversarial audit (GPT-5.6 Codex: REFUTE; Kimi K3: SHIP-WITH-FIXES;
Claude Opus 5: SHIP-WITH-FIXES) run under the project's independent-review discipline. The three
audits converged on one structural defect and several load-bearing inaccuracies in revision 0,
all folded in above:

1. **Discovery direction added** (`listEffects`, §2): revision 0's `observeEffect(call)` could
   only detect intent-without-outcome; effect-without-claim — the class the ADR exists to catch,
   and acceptance test (d) — was undetectable against the declared interface.
2. **Correlation id pinned as gateway-minted** (§3): the API boundary accepts caller-supplied
   call ids, so revision 0's "gateway-minted" was false as stated; the mint-on-first-persistence
   / match-retries-by-idempotency-key rule and the namespaced, hash-bound marker format close the
   spoof/replay surface without breaking retry semantics.
3. **All-execute-paths re-derivation** (§4): the approval-resume and recorded-decision replay
   paths reach provider execution without re-running the fresh-path gate (the same hole #120
   patched for suspensions); a gate on the fresh path alone is bypassed by resuming.
4. **Unbound-provider semantics pinned** (§4): revision 0 implied both "unbound ⇒ reject" (which
   breaks the credential-free default) and "unbound ⇒ skip" (which makes the register gate
   vacuous); revision 1 makes unbound registration provisional with the invoke site as the
   unconditional gate.
5. **Citation and honesty fixes** (§1, §4, §5): the fail-closed-default precedent is
   `default_permission`, not `side_effecting`/`risk_level` (those default permissive and are
   coerced at the gate); the `sideEffecting` idiom is an invoke-time re-check, not a two-site
   gate, and the registration check is new with this ADR; tri-state observation replaces
   nullable; `failed` is not evidence of absence; and §5 now states plainly that forced approval
   is control, not detection — reconciliation cannot backstop the `none` class.

## Note on numbering

This is the first ADR published in-repo. ADR-0001–0012 predate the public `docs/adr/` directory
and publish under the ADR-0006 (public-or-dead governance records) hygiene pass; the numbering
continues the existing private sequence rather than restarting it.
