# ADR-0011: Capability Scoping and Delegation Model

**Status:** Accepted — as direction (ratified 2026-06-11; implementation gated by ADR-0008)
**Date:** 2026-06-10
**Proposed by:** Consolidated from four independent external design reviews (2026-05-30 .. 2026-06-08; per-suggestion provenance is kept in a private ledger — the reviewers are third parties whose names and correspondence are withheld pending their consent) — assessed against the converged diligence audit
**Owner:** Human Product Owner

---

> **Publication note (2026-07-25).** Provenance links point to the public audit records; the
> unredacted internal versions stay private because they name third parties who did not consent.
> Redaction is limited to identities and private-channel evidence — every finding, caveat, and
> criticism is published. Decision content below is unchanged.

> **Ratified 2026-06-11 as direction** by the Human Product Owner, on the converged diligence audit (Claude + GPT-5.5) plus an independent Fable 5 second opinion (UNISON-WITH-CAVEATS). Durable record: `../audits/2026-06-11-adr-ratification-public-record.md`.

## Ratification amendment (2026-06-11)

**Implementation is subordinate to ADR-0008's freeze.** Until the adoption gate is decided, only slices that land with ADR-0007 or directly serve a named candidate adopter proceed — this ADR fixes the *target model*, it does not authorize a founder solo build of the scoping architecture (the most seductive over-build rabbit hole on the board, per the Fable 5 review). The sanctioned path is contributor PRs (several external contributors volunteered for #111/#112/#113; names withheld pending consent) and ADR-0007-riding slices. The Follow-Up list below is therefore a *target*, not a work queue to start now.

## Context

Four reviewers who have never spoken to each other — all of whom have built or operated this exact surface — converged on the same critique of the current credential model: the `cred_*` handle/broker split is the correct boundary (secret never enters the agent), but **a handle over a broad long-lived credential is indirection over a god-key, not scoping**. If `cred_github` resolves to a broad PAT, every capability using it can do anything the PAT can. They also converged on the delegation gap the project has itself acknowledged: a sub-agent's envelope is granted but not enforced as a subset of its parent's authority.

This ADR fixes the target model now, while it is cheap, so the provider/broker interfaces are shaped by it rather than retrofitted.

## Decision

The capability grant — not the underlying credential — is the unit of authority:

1. **Scope = capability, not role.** A grant is `(resource, action, constraints, ttl)` — e.g. "agent X, for task T, may call `refunds.create` up to $N, expires in 10 min" — never "agent X may use Stripe." Constraints include arg constraints, rate, and spend ceilings; they travel **with the grant** and are enforced **at the broker**, so a policy-layer gap can never mean unbounded authority.
2. **Ephemeral downstream credentials.** The broker exchanges the worker's identity for a short-lived, narrowly-scoped downstream credential per call (token-exchange shape, RFC 8693), minted to the grant's scope — not a lookup of a stored god-key. Where a provider cannot mint narrow tokens (e.g. classic PATs), the gap is documented on the capability as a residual-risk note.
3. **Audience binding.** Tokens are bound to one provider/tool audience (RFC 8707-style resource indicators) so a credential minted for tool A cannot be replayed against tool B (confused-deputy class).
4. **Delegation attenuation.** A child envelope's authority must be a provable subset of its parent's — attenuation may narrow, never widen (macaroon-style caveats or envelope-subset checks at issue time). Enforced, not conventional.
5. **Audit log is the authorizing act.** The durable intended-call record (actor, parent, capability, target, args-hash, justification) precedes execution; approval-required capabilities block on a human decision recorded in the same log. (Already implemented as the durable intent marker — this ADR elevates it from implementation detail to contract.)
6. **Revocation channel.** Long-running work requires mid-flight revocation of a grant, not only short TTLs; the broker checks revocation at credential-mint time.
7. **Binding granularity:** one Capability binds one tool-level action surface (for MCP: one tool, not one server) — issue #112.

## Consequences

- The provider/broker interfaces (`ts/src/security/credential-broker.ts`, capability contracts) gain scope/TTL/budget fields and a mint-time enforcement point; the GitHub provider becomes the first migration (fine-grained short-lived tokens).
- Sub-agent handoff gets an enforced subset check — closing the known open edge before multi-agent delegation widens.
- Depends on ADR-0007 (first-class principals): per-call minting presupposes per-worker identity.
- Out of scope here: payment-class double-settle semantics (ledgered as a capability-class constraint for #69), multi-tenant isolation (ledgered for Modes 2/3).

## Alternatives Considered

- Keep handle-over-stored-secret and rely on the policy layer for constraints. Rejected: every reviewer with production scar tissue called this the failure mode ("scoped quietly becomes ambient"; "a policy gap = an unbounded spend").
- Full macaroon implementation now. Deferred as mechanism: the *property* (attenuation, never amplification) is the decision; the primitive can start as envelope-subset checks.

## Follow-Up

- [ ] Ratify; sequence after ADR-0007 / issues #92, #101, #102.
- [ ] Extend capability/credential contracts with scope/ttl/budget; broker mint-time enforcement + tests.
- [ ] Subset-enforcement on handoff envelopes + tests.
- [ ] Decide #112 (MCP per-tool binding) as the first application.
