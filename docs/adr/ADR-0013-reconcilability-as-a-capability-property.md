# ADR-0013: Reconcilability as a Declared Capability Property

**Status:** Accepted (ratified 2026-07-25)
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
schema layer, so a caller can never gain autonomy by omission. Same fail-closed idiom as
`side_effecting` / `risk_level`.

### 2. The provider declaration

The `CapabilityProvider` runtime type gains two members:

```
reconcilable?: "receipt" | "downstream_state" | "none"   (absent → "none")
observeEffect?(call: CapabilityCall): Promise<ObservedEffect | null>
```

Absent `reconcilable` collapses to `"none"` — a provider predating the field is automatically
most-restricted, never silently trusted (the same rule as the intrinsic `sideEffecting`
declaration). `observeEffect` is the read-back: it queries the provider's receipt or downstream
state for evidence of the effect keyed by the gateway-minted correlation id. **A declared level
above `none` without an `observeEffect` implementation is a contradiction** — the declaration
would be decorative — and is treated exactly like a declared/provider mismatch below.

### 3. The lattice and the two gate sites

Effective reconcilability is computed down the lattice `receipt > downstream_state > none`,
fail-closed toward `none`:

```
effective = min(declared, min over bound providers)
```

Min across providers is the weakest link, since any listed provider can serve the call.

**Registration gates the declaration; invoke gates reality** (mirroring the `sideEffecting`
two-site idiom in `registry.ts`):

- **`register()` — reject.** A capability whose declared `reconcilable` exceeds what its
  currently-bound providers support (including a missing `observeEffect`) fails registration.
  Loud on config drift, fails before anything binds, and the registration path has no liveness
  cost. A capability registered before its provider binds is gated by the invoke site below.
- **invoke — coerce + warn, never reject.** The gate re-derives `effective` against whatever is
  bound *now*. Late-binding a weaker provider can never widen a capability that registered clean:
  the call collapses to the stricter gate and a mismatch signal is emitted for the diagnosis pass.
  Rejecting at invoke would turn config drift into a runtime outage for a call that was about to
  be gated synchronously anyway.

The asymmetry is deliberate and is this ADR's ruling on the coerce-vs-reject question left open in
the #111 thread.

### 4. What effective `none` forces

For a **side-effecting** capability whose effective reconcilability is `none`:

- `default_permission` cannot widen past `approval_required`;
- the invoke path forces the synchronous approval gate regardless of caller-declared risk (the
  same higher-of coercion idiom as `risk_level`);
- the autonomy dial cannot widen the grant.

The forcing is scoped to side-effecting capabilities. An unreconcilable *read* is not the omission
threat this ADR exists to close, and forcing synchronous approval on every mock lookup would make
the default local mode unusable.

### 5. One id threads idempotency and reconciliation

The correlation id is `call.id` — the key the registry's durable `NodeEffect` guard already
threads (`${call.id}:provider`). The intent record is written under that id before the outward
call, the id is injected into the call where the provider supports it, and the outcome closes it.
One id for dedup *and* reconciliation, so a call can never be deduped-correct but
reconciliation-blind. No second id family is introduced.

### 6. Relation to #69

Reconcilability is a fourth classification axis alongside reversibility and blast radius.
[#69](https://github.com/OpenMAO/OpenMAO/issues/69)'s capability classes **consume** the declared
field; they do not own it. This keeps the contract change orthogonal to the payment-gated
perimeter work.

## Consequences

- PR 1 (issue #111 thread): the schema field, the provider members, and both gate sites, with the
  contract/registry tests binding to the exported enum. `npm run schema:generate` must accompany
  the contract change — the contracts test asserts the committed canonical schema equals the
  generated bundle.
- Slice 2: the intent/outcome execution-claim pair becomes auditable events emitted in the same
  transaction as the existing durable `NodeEffect`, closing "enforced provably distinct from
  self-attested".
- Slice 3: the reconciliation pass keys off `reconcilable` and `observeEffect`, reports tri-state
  (`matched` / `pending` inside the window / `violation` past it), and classifies
  effect-without-claim strictly above intent-without-outcome.
- The GitHub issue-comment provider is the honest worked example: its documented
  timeout-after-create reconciliation procedure becomes `observeEffect`, and until a correlation
  marker is recoverable from the created comment it registers as `downstream_state`, not
  `receipt`.
- Scope statement for the at-most-once claim: the durable node-effect guard holds **per backing
  database**. Multi-replica deployments sharing no database are outside the verified claim; the
  crash-window harness (test (a) in the #111 plan) is the verification vehicle.

## Alternatives considered

- **Coerce+warn at registration too.** Rejected: a silently-downgraded capability looks
  registered-clean in the durable record, and the registration path is the one place strictness
  costs nothing.
- **Reject at invoke.** Rejected by both external reviewers independently: config drift would
  become a runtime outage for calls the stricter gate was about to handle synchronously anyway.
- **Carry the provider's level on the capability contract.** Rejected: `providers` stays
  names-only; the registry owns the bound-provider map and computes the min without widening the
  contract surface.
- **Own the axis inside #69's capability classes.** Rejected: would couple this to the
  payment-gated work; the classes consume the field instead.

## Note on numbering

This is the first ADR published in-repo. ADR-0001–0012 predate the public `docs/adr/` directory
and publish under the ADR-0006 (public-or-dead governance records) hygiene pass; the numbering
continues the existing private sequence rather than restarting it.
