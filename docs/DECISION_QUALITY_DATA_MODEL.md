# Decision-Quality Console → Data-Model Spec

**Status:** spec to *inform* the M-layer architecture decisions, not make them. Reads the
architecture **backward from the prototype** ([`docs/prototype/console-prototype-dq.html`](prototype/console-prototype-dq.html)):
for each decision-quality screen, what must the kernel capture to make it real — mapped to
the existing M0–M4 layer, with what exists, what's missing, and the build sequence.

Working umbrella name for the issue/ADR this feeds: **"decision-grade organizational record."**

> **One-line:** the prototype is mostly buildable on the *existing* contracts plus a thin
> set of additions — **finish the M0 causal envelope, activate the dormant `Evaluation`
> seam for expected-vs-actual, and project interventions over existing events** — *provided*
> we keep decision records at the **org/governance altitude** and never drift into
> inner-loop reasoning capture.

---

## 1. The substrate that already exists (verified in code)

| Layer | What it is | Where | State |
| --- | --- | --- | --- |
| **M0** | Causal envelope on events: `actor_ref`, `produced_refs`, `consumed_refs`, `causal_parent_id` (optional, default-safe); feeds M3's 3 edge types | `EventPayloadSchema` — `contracts/models.ts:88‑91` | **Populated by ONE emitter** (`work/service.ts`, 6 sites). All side-effecting emitters (capability calls, approvals, memory promotion, org-change apply, ingestion) are **causal-blind**. This is a cliff, not a gradient. |
| **M1** | Reversible apply + kill-switch: before/after hashes, `applied→verified→reverted` | `OrgChangeApplicationSchema:714`, `OrgControlStateSchema:735` | Implemented. **This is the reversibility / "undo" / intervention substrate — reuse it.** |
| **M3** | Causal diagnosis (backward-trace + counterfactual screen) | `diagnosis/service.ts`, `diagnosis/causal-graph.ts` | Shipped but **structurally starved** — it can only trace edges among *work* events because M0 is incomplete. |
| **M4** | Earned autonomy: human-ratified, evidence-backed widening; "the dial only moves via a ratified case — never a flag, never automatically" | `AutonomyCaseSchema:750`, wired in `org/autonomy.ts` | Implemented. **The dial mechanics the prototype shows already exist** — they need *quality* fuel, not new plumbing. (`AutonomyLevel` = advisory/supervised/bounded; no `board-governed` yet.) |

**Objects that already carry decision-grade fields** (so we extend, not invent):

| Object | Already has | Missing for DQ |
| --- | --- | --- |
| `WorkItem:206` | `objective`, `success_criteria[]`, `risk_level`, `approval_gates`, **`evaluation[]`** (→ points at the dormant Evaluation) | a captured **expected_outcome** distinct from prose criteria |
| `OrgChangeProposal:628` | **`rationale`, `confidence` (0‑1), `evidence[]`, `impact`, `status`** | expected_outcome + actual reconciliation |
| `AutonomyCase:750` | `current/proposed_level`, **`evidence[]`, `rationale`**, ratify flow | evidence fed from *quality* metrics |
| `AgentOutcome:277` / `WorkerOutcome:296` | `status`, `summary`, `cost` (tokens/usd/model), `trace_ref` | structured comparison to expectation |
| `Evaluation:491` | `rubric, score, passed, notes` | **wired nowhere** — the seam to activate for expected-vs-actual |
| `ApprovalRequest:475`, `Notification:680`, `Event:503`, `Trace:533` | the gate/intervention points, CoS surface, the demoted raw layer | causal tagging (M0) so they link to decisions |

---

## 2. Charter guardrails — and where the prototype over-reached

The prototype made **per-action decision records with "options considered"** first-class
(e.g. D-118: *Enrich-all-200 vs Sample-50 vs Manual-first*). That is the most seductive part
of the demo and the part to **pull back**:

- A standalone **runtime DecisionRecord with "options considered"** is the **inner-loop
  swamp**. Capturing each agent's deliberation = "log the reasoning" = **agent-trace
  observability, a named non-goal** (NORTH_STAR / ROADMAP). Don't build it.
- **Resolution — decision records live at the org/work/governance altitude.** Fold
  `expected_outcome` onto the objects that *already* carry rationale + confidence
  (`WorkItem`, `OrgChangeProposal`, `AutonomyCase`) and onto **consequential capability-call
  approvals**. The console's "Decisions" feed is populated by *these* — not by instrumenting
  every tool call. "Options considered" stays optional and only where it's already
  natural (org-change alternatives), never per inner-loop step.
- **Keep** (all on-charter): expected-vs-actual, interventions, reversibility, calibration.
- **World model stays a projection** — every tile/aggregate in §3 is a read over events +
  source state, never a new source of truth.
- **Never capture the deliberation transcript.** Capture the *consequential decision* + its
  *stated expectation* + the *actual outcome*. That is the whole move.

So the prototype's **Decision detail** is right in *shape* (intent · expected-vs-actual ·
confidence · cost · learned · demoted trace) — but its *population* must come from
org/work-altitude commitments, and "options considered" should be de-emphasized to optional.

---

## 3. Screen → data requirement (the core mapping)

| Console element | Data it needs | Exists? | Gap → object to extend | M-layer | Step |
| --- | --- | --- | --- | --- | --- |
| **Pulse · Expected-vs-Actual %** | per-decision expected vs reconciled actual, aggregated | partial | capture `expected_outcome`; **activate `Evaluation`** as the reconciliation; projection | M0 + Eval | 3 |
| **Pulse · Open regressions** | decisions where actual ≠ expected | no | same as above (a regression = failed reconciliation) | M0 + Eval | 3 |
| **Pulse · Interventions this week** | count of human/system overrides | partial | **project** over `ApprovalRequest` (reject/approve), `OrgChangeApplication` (revert), `OrgControlState` (pause), run steer/pause | M0 + projection | 2 |
| **Pulse · Calibration** | confidence (captured) vs actual outcome, over time, per actor | no | confidence exists on proposals; needs reconciled actual + aggregation **+ history** | M0 + Eval + rollup | 5 |
| **Pulse · Regret** | actual vs best-available-option outcome (heuristic) | no | leans on **M3 counterfactual** + cost/outcome | M3 | 5 |
| **Pulse · Autonomy readiness** | eligibility = calibration + hit-rate + intervention-rate + 0 harmful | partial | `AutonomyCase` exists; feed it the quality aggregates | M4 ← 2/3/5 | 4–5 |
| **Decisions feed + detail** | decision (intent/rationale/confidence) → expected → actual → delta → cost → learned → trace | partial | org-altitude decision + `expected_outcome` + `Evaluation` reconciliation; `cost` from outcome; `trace` already exists (drawer) | M0 + Eval | 3 |
| **Interventions view** | override + decision context + why + learned + fed-into | partial | intervention projection (step 2) + links to `MemoryEntry`/`OrgChangeProposal`/`AutonomyCase` | M0 + projection | 2 |
| **Agents · calibration** | per-agent confidence-vs-actual, hit-rate, intervention-rate, regret, drift | no | per-actor aggregation over the above (needs `actor_ref` everywhere) | M0 + rollup | 5 |
| **Governance · autonomy dial (graded on quality)** | a *quality* evidence ledger gating a ratified widening | partial | `AutonomyCase.evidence[]` re-pointed from "verified applies" to the **quality metrics** | M4 ← 3/5 | 4–5 |
| **Raw-trace evidence drawer** | per-node trace, events | yes | none — just demote in UI | — | now |
| **CoS DQ intents** | reads over the projections above | n/a | none new | — | follows data |

---

## 4. The minimal additions (~2.5 objects, not 5)

1. **Finish the M0 causal envelope** on consequential/side-effecting emitters (capability
   calls, approvals/governance, memory promotion, org-change apply, ingestion). *Not a new
   object* — extend existing instrumentation to the dark append-sites. **Precondition for
   everything** (and the fix for the already-shipped, starved M3).
2. **`expected_outcome` + activate `Evaluation`** as the expected-vs-actual reconciliation.
   Capture a stated expectation at the work/org-altitude decision; reconcile the actual into
   `Evaluation` (extend it to carry `expected` / `actual` / `delta` / `basis`, or keep
   `Evaluation` as the reconciliation and add `expected_outcome` to `WorkItem`/proposal). ~1
   object's worth of work.
3. **Intervention = a projection** over existing events first (≈0 new storage); promote to a
   thin `Intervention` record only if `learned`/`fed_into` links need to persist. ~0.5.

**Later (roadmap-don't-build — needs accumulated history):** episode rollups; calibration
aggregation; regret/counterfactual (built on M3). The **M4 `AutonomyCase` dial needs no new
mechanics** — only its `evidence[]` re-pointed at these quality aggregates as they land.

---

## 5. Sequencing → what each step lights up in the console

Matches the agreed sequencing (harden the causal substrate → expected-vs-actual +
interventions → calibration/regret) and the substrate-first plan (finish the causal envelope
before anything that reads over it).

1. **M0 envelope complete** → causal attribution everywhere. *Visible:* nothing alone — but
   it's the precondition and it un-starves M3.
2. **Intervention projection** → **Interventions view** + the *Interventions* Pulse tile +
   evidence for autonomy. *Earliest visible DQ win, mostly over existing data.*
3. **expected_outcome + Evaluation activation** → **Decisions feed + detail**, the
   *Expected-vs-Actual* and *Open regressions* tiles. *The core decision-quality surface.*
4. **Episode rollups** → run/work review summaries (outcome/deviation/cost/interventions).
5. **Calibration + regret** → calibration on agent cards, the *Calibration*/*Regret* tiles,
   and the **quality-fueled autonomy dial** (`AutonomyCase` evidence) — Ava-qualifies /
   Scout-held becomes computed, not mock.

---

## 6. Open architecture decisions (for "later" — this spec frames, doesn't decide)

- **Where `expected_outcome` lives:** extend `EvaluationSchema` to `{expected, actual,
  delta, basis}` vs. add `expected_outcome` to `WorkItem`/`OrgChangeProposal` and keep
  `Evaluation` as the reconciliation record. (Recommend the latter — smaller blast radius.)
- **Intervention:** pure projection vs. a first-class `Intervention` object (needed only if
  `learned`/`fed_into` must persist and be queried).
- **Calibration:** window length, per-agent vs per-org attribution, and normalizing the
  confidence scale (proposals already use 0–1).
- **Regret:** the heuristic definition — requires the M3 counterfactual screen to be fed by
  a complete M0 envelope first.
- **Is there an `M2`?** Not found in code; confirm the layer numbering before publishing.
- **`board-governed`:** the prototype shows a 4th level; `AutonomyLevelSchema` stops at
  `bounded`. Decide if/when the enum extends.

## 7. What NOT to build (guardrails)

- No deliberation-transcript / inner-loop reasoning capture (agent-trace observability is a
  non-goal).
- No standalone per-tool-call `DecisionRecord` with "options considered."
- Don't reinvent audit/undo — reuse the M1 `OrgChangeApplication` reversibility substrate.
- Keep the world model a projection; tiles are reads, never truth.

---

*Companion to [`docs/OPERATOR_CONSOLE_REDESIGN.md`](OPERATOR_CONSOLE_REDESIGN.md). Verify the
"single-emitter M0" claim against current emitters before citing externally — confirmed in
this pass: `actor_ref` is set only in `ts/src/work/service.ts`.*
