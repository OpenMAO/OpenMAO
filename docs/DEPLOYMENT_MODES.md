# Deployment Modes

OpenMAO supports three deployment modes. They differ in which backends serve the organizational
substrate and the external data plane. The substrate is OpenMAO's own state: work, roles, authority,
approvals, memory, events, traces, and world-model projections. The data plane is
organization-owned infrastructure and business data. The canonical contracts, governance rules, and
audit invariants are identical across all three modes; only the backends underneath them change.

This document describes adoption modes. The modes do not introduce additional contract types.

## Mode 1: Native / Local

For hobbyists, contributors, regulated/airgapped environments, and the default local release.

| Concern | Backend |
| --- | --- |
| OpenMAO runtime state | SQLite at `.openmao/openmao.sqlite3` |
| Collective memory | Markdown files at `.openmao/collective_memory/` |
| Artifacts | Local filesystem at `.openmao/artifacts/` |
| Events / traces | SQLite |
| Capabilities | Mock providers by default; opt-in real GitHub issue-comment provider via `OPENMAO_GITHUB_ENABLED` |
| Model router | `MockModelRouter` (deterministic) |
| Secrets | None for the default demo |

Properties (default, with no provider environment configuration):
- No external API keys required.
- No network access required.
- Reproducible: same input produces the same trace.
- Suitable for local development, demos, CI, and air-gapped evaluations.

Enabling an opt-in real provider (for example `OPENMAO_GITHUB_ENABLED=1`) trades these last three
properties for that provider only: it requires its credential and makes outbound calls. The default,
unconfigured runtime stays mock-only, credential-free, and offline.

This is the only mode supported by the current release.

## Mode 2: Managed / Simple Cloud

For small organizations after the local release. Deferred — see [ROADMAP.md](./ROADMAP.md).

Indicative shape:

| Concern | Backend |
| --- | --- |
| OpenMAO runtime state | Postgres (managed, e.g., Supabase) |
| Collective memory | Markdown in a Git repository |
| Artifacts | Object store (S3-compatible, Supabase Storage, R2, GCS) |
| Vector index | pgvector |
| Capabilities | Real HTTP providers behind canonical capability contracts |
| Model router | Real LLM provider via the model router seam |
| Secrets | Environment variables or hosted secret store |

Properties:
- One cloud account; minimal infrastructure footprint.
- Suitable for early-stage organizations and small teams.
- All organizational data still lives in the chosen provider, governed by capability contracts and approval gates.

## Mode 3: Enterprise Cloud

For larger organizations after the local release. Deferred — see [ROADMAP.md](./ROADMAP.md).

Indicative shape:

| Concern | Backend |
| --- | --- |
| OpenMAO runtime state | Postgres/RDS/Aurora |
| Collective memory | Git repository or document store |
| Artifacts | S3 / GCS / Azure Blob |
| Vector index | pgvector or external vector store |
| Capabilities | Mix of HTTP providers, MCP servers, sandbox providers |
| Model router | Multi-provider routing through the router seam |
| Secrets | Vault / AWS Secrets Manager / GCP Secret Manager / equivalent |
| Warehouses | Snowflake / BigQuery / Databricks behind capability contracts |
| Business systems | Internal APIs behind capability contracts |

Properties:
- Mixes managed and self-hosted services as the organization requires.
- All access flows through governed capability providers; no direct agent-to-infrastructure connections.
- Cost, audit, and approval semantics are the same as the other modes.

## Enforced-mode topology: what physically makes the gateway non-bypassable

"Non-bypassable" is a deployment property, not a code property
([#111](https://github.com/OpenMAO/OpenMAO/issues/111)). The capability gateway is only as
enforced as the topology around it. Three physical properties, in increasing order of what they
cost to provide:

1. **Secret isolation.** The credential broker holds the real secret and resolves it inside
   provider code at execution time; workers hold opaque `cred_*` handles and have nothing to
   authenticate with on their own. Provided by OpenMAO itself in every mode.
2. **Egress control.** The worker process cannot reach provider endpoints except through the
   gateway — an egress allow-list, a network namespace, or an equivalent boundary that makes the
   gateway the only outward door. **Not provided by OpenMAO**; it belongs to the runtime the
   worker executes in.
3. **Process separation.** Worker code runs in a process with no ambient credentials and no
   direct write access to the substrate database, so it cannot forge or suppress gateway records.
   Partially provided (per-principal and per-worker scoped credentials close the API surface);
   full confinement is the runtime-sandbox layer (see [LIMITATIONS.md](./LIMITATIONS.md) §11).

**Mode 1 provides secret isolation only.** A worker process in local mode can reach the internet
directly; nothing but the deployment contract stops it from taking a side effect outside the
gateway. Enforced mode in Mode 1 is therefore a promise the operator keeps, not a guarantee the
runtime makes: "non-bypassable" means bypassable only by violating the deployment contract
(handing a worker raw credentials, or running it with open egress and expecting otherwise).

**A stronger claim requires a provided runtime.** Egress control and process separation arrive
with the sandboxed/provisioned runtimes of Modes 2 and 3, or with an operator-configured
equivalent (container with an egress allow-list, network namespace, secrets kept out of the
worker's environment). The perimeter-classes work at
[#69](https://github.com/OpenMAO/OpenMAO/issues/69) tracks making that boundary a first-class,
checkable part of deployment; the omission-detection work at #111 makes violations of it
*detectable* from the record even where they cannot be *prevented* by topology.

## Remote access: a plan, not an implementation

The server is **loopback-only** in every supported mode today. Multi-human operation works —
two operators, each with their own principal credential, in two browser profiles against one
loopback host — but reaching across a network is deliberately not implemented. This section is
the plan for what real remote access requires. Nothing here ships until each item is built and
tested; until then, any deployment that exposes the HTTP surface beyond loopback is outside the
supported envelope.

The threat model changes completely the moment the client is no longer a process on the same
trusted host. A hostile client — or a hostile network between client and host — can observe,
replay, and rewrite requests; can attempt credential brute force at network speed; can steal
browser-held tokens through XSS; and can ride one origin's ambient authority into another's.
The loopback gate makes all of these moot today; remote access must answer each one.

1. **TLS termination.** All transport security is delegated to a TLS layer the deployment
   operates — a reverse proxy (nginx, Caddy, a cloud load balancer) terminating TLS in front of
   the OpenMAO process, with certificate management owned by that layer. OpenMAO itself should
   keep speaking plain HTTP on loopback to the proxy; in-process TLS would duplicate machinery
   the proxy ecosystem already operates better. HSTS and modern-cipher-only configuration are
   proxy concerns, stated here because "we terminated TLS somewhere" without them is not
   transport security.
2. **Session handling.** Pasted per-principal tokens in the console are a local-mode
   convenience, not a session design. Remote console access needs a one-time login ticket
   exchanged for an `HttpOnly`, `Secure`, `SameSite=Strict` session cookie with bounded
   lifetime and server-side revocation (the credential store already supports revocation;
   sessions must resolve through it on every request, never cache standing in the browser).
   Machine clients keep presenting per-principal credentials directly — the credential path is
   already per-principal and revocable, so no new identity mechanism is needed for them.
3. **CSRF and origin control.** Cookie sessions reintroduce ambient authority, so the server
   must verify `Origin`/`Referer` on every state-changing request, issue and check CSRF tokens
   for cookie-authenticated mutation, and send a restrictive Content-Security-Policy. Bearer
   credentials in an `Authorization` header are not ambient and do not need CSRF protection —
   one more reason machine clients keep bearer tokens while browsers get cookies.
4. **Replay protection.** Within TLS, replay matters at two layers. Request-level replay (the
   same authenticated request sent twice) is already handled where it counts: approval
   resolution is a checked compare-and-set, signature recording is unique-indexed, and event
   append is idempotency-keyed — a replayed decision is a no-op, not a duplicate. What TLS does
   not cover is a request captured and re-presented *outside* the original channel, which is
   where request signing enters.
5. **Request signing, if added, uses RFC 9421 HTTP Message Signatures** — never the governance
   signature envelope repurposed as an ad-hoc request signer. They are different problems: the
   governance envelope attests *a decision* and is bound to stored state; HTTP Message
   Signatures authenticate *a request in transit*, binding method, target, headers, body
   digest, and a creation time with an explicit freshness window. Conflating them would weaken
   both. The nonce and clock-window design, the covered-component list, and the key
   distribution for request signing are all RFC 9421's to specify, and the implementation
   should follow it rather than invent a parallel scheme.
6. **Hostile-client hardening.** Rate limiting and lockout on authentication failures; no
   credential material or error oracles that distinguish "unknown principal" from "wrong
   token"; the loopback refusal inverted deliberately (binding non-loopback must require an
   explicit, audited opt-in, never a flag that defaults open); and security headers (CSP,
   `X-Content-Type-Options`, frame denial) on the console. None of these exist today because
   none are reachable today.

**Decisions already taken that keep this door open** (so the plan is small rather than
architectural):

- **Identities are transport-independent.** Principals, keys, and credentials are stored rows
  with no loopback assumption; nothing in the identity model changes when the transport does.
- **Credentials are already per-principal, scoped, and revocable** — the exact properties
  remote sessions need to resolve standing on every request.
- **Authentication and attestation are separate.** The credential proves who is calling; the
  Ed25519 key attests decisions. Request signing can be added at the transport layer (RFC 9421)
  without touching a single governance signature, and governance signatures keep their meaning
  unchanged whether the request arrived over loopback, TLS, or an RFC 9421-signed channel.

## What stays constant across all modes

These are properties of the OpenMAO organizational substrate, not of any deployment mode:

- Work items, owners, reviewers, lifecycle, approvals, memory consequences, and world-model truth live in OpenMAO.
- Every state-changing action emits an `Event`.
- Every graph node emits a `Trace`.
- Tools are exposed through scoped capability contracts rather than ambient access.
- Every capability call is checked against policy and may suspend on approval before execution.
- High-risk capabilities should execute through OpenMAO-managed providers or credential brokers, not raw credentials handed to agents.
- Collective memory writes happen only through approved promotion.
- Agents never receive raw provider credentials.
- The CLI and console run the same way; only the configured backends change.

## What the current release does not include

- Real provider implementations for databases, object/file/secret stores, or most SaaS tools (one opt-in GitHub issue-comment provider ships in v0.4.0; broader providers remain deferred).
- A credential manager beyond the documented invariant.
- Multi-cloud routing logic.
- Hosted SaaS or multi-tenant authentication.

See [docs/V0_SCOPE.md](./V0_SCOPE.md) for the first-release ship-vs-defer matrix.
