# External Diligence Audit — 2026-06-10 (public record)

**Auditor:** Claude (Fable 5), commissioned as an outside operator for a one-pass ruthless diligence
review. Adversarial verification pass: GPT-5.5 (Codex), instructed to refute.
**Scope:** the OpenMAO repository — working tree including gitignored local documents, git history,
and read-only GitHub API. Execution in an isolated worktree at `ad0fbec` (then main HEAD). No file
mutations to the maintainer's checkout, no pushes, no publishing.
**Status:** converged. This record is cited as provenance by ADR-0006 through ADR-0010.

---

## What this document is, and what was removed

This is the public record of an internal audit. It exists because ADR-0006 ("public-or-dead
governance records") holds that an accountability product cannot keep its own accountability layer
private — and because the ADRs it produced would otherwise cite a source no outsider can read.

The public/private line is **privacy- and consent-based, never image-based**. Findings that are
unflattering to this project are published verbatim; that is the point of the exercise. Two
categories are withheld:

1. **Third-party identities.** External contributors, correspondents, and account holders are
   described by their role or by public artifact number, not by name or handle. They did not
   consent to appear in this project's governance record.
2. **Private-channel evidence.** One finding (F27) rests on the maintainer's email account. Its
   conclusions about *this project's own conduct* are summarized below; the underlying messages,
   recipient identities, and the dataset they came from are withheld in full.

Finding identifiers are unchanged from the internal record so that ADR cross-references resolve.
Nothing else has been softened. Where the internal record named a person, this one names the role.

---

## 1. Claims register

Each claim carries a confidence and a fact/inference marker. Items marked `[gh]` were verified
against the public GitHub API and are reproducible by anyone. Items marked `[private]` are
summarized only.

### Execution (performed 2026-06-10 in a clean worktree at `ad0fbec`)

- **F1.** `make check` green: lint (2 warnings), typecheck clean, 26 test files / 207 tests pass,
  public hygiene scan passes. (High, fact — executed)
- **F2.** `make demo` / `make demo-approve` work end-to-end with deterministic fixture IDs. A
  *completed* demo run yields **zero** learning signals — `learning scan` → `signal_count: 0`. The
  canonical demo never feeds the flywheel. (High, fact — executed)
- **F3.** `cos init`/`cos tick` fail with "work item already exists" when run after the demo in the
  same state directory (shared fixture workspace); they work from a clean state directory. Demo and
  Chief-of-Staff paths are not composable. (High, fact — executed)
- **F4.** A full operator-reachable self-correction loop turn was executed via CLI: create 2 work
  items → set both `blocked` → `learning scan` detects `repeated_blocker` → approval created →
  `approvals approve` → `learning apply` succeeds. The applied "change" is a hardcoded English
  recommendation string recorded to the database. No organizational behavior changes. (High, fact —
  executed; detector strings hardcoded at `ts/src/learning/service.ts:107-190`)
- **F5.** `learning revert` on that applied proposal returns "no applied change found for proposal"
  — the marker path records no `OrgChangeApplication`, so the only operator-producible loop turn is
  **not revertible** from the surface. CLI `learning revert` has zero test coverage. (High, fact —
  executed)
- **F6.** Exactly one real applier is registered by default: `memoryCleanupApplier`
  (`ts/src/org/apply.ts`). Every other change type takes the legacy marker path. The suite itself
  asserts `hasApplier("policy")===false` (`ts/tests/org_apply.test.ts:329-332`). (High, fact)
- **F7.** M4 is unreachable in the product: `proposeWidening`/`ratifyWidening` have **zero callers**
  outside `ts/src/org/autonomy.ts` and its tests — no CLI command, no API route, no console action.
  The autonomy dial cannot legally move in any running deployment. The dial *is* consulted for
  capability approval triggers (`ts/src/governance/service.ts:145-177`), and the transition rules are
  well tested at the service/store layer. (High, fact)
- **F8.** The HTTP API trust model is single-principal: one shared bearer token
  (`ts/src/api/server.ts:64`) plus a self-asserted actor header. All separation-of-duty rules
  (proposer≠applier, ratifier≠proposer) are defeatable by changing a header. Open issue #92 confirms
  this is known and live. (High, fact)
- **F9.** No proposer≠approver guard on main's approval resolution
  (`ts/src/governance/approvals.ts`). The fix existed only on an unmerged branch. (High, fact)
- **F10.** Per-worker authentication existed only on an unmerged branch (6 commits, tip
  2026-05-31 — the last code commit of the build burst). (High, fact)
- **F11.** Append-only events are REAL — enforced by SQL triggers (UPDATE/DELETE on events throw;
  `ts/tests/persistence.test.ts:303-310`). Projections remain mutable by design. (High, fact)
- **F12.** The capability gateway is real but in-process: ≥9 distinct attempted-forbidden-side-effect
  paths are tested with provider-not-executed assertions, including a test that reopens the SQLite
  file to prove at-most-once resume across a process restart
  (`ts/tests/governance.test.ts:1146-1281`). Any code holding the database handle bypasses the gate
  entirely; enforcement at the HTTP boundary is defeated by F8. (High, fact + inference on bypass)
- **F13.** No test composes the full flywheel (detect→diagnose→propose→approve→apply→verify→
  track-record→widen). Longest tested chain: scan→approve→apply→verify, memory-cleanup only.
  "Verified" is a same-transaction post-condition re-inspection, not independent verification. M4's
  track-record tests seed verified applications directly into stores, bypassing the M1 engine. No
  test anywhere shows memory being consumed by, or improving, subsequent work — "compounding" is
  unproven. (High, fact)
- **F14.** M2 heartbeat and M3 diagnosis are advisory/report-only by design and tested as such.
  Counterfactual scoring is asserted only as `>0`; it is a structural heuristic, not model-based.
  (High, fact)
- **F15.** M0–M4 appear in NO CHANGELOG entry; they exist only in commit and PR messages. The
  M-milestone vocabulary is defined nowhere in tracked documentation. (High, fact)

### History and process

- **F16.** main is an orphan history (root `a64ddb0`, 2026-05-29, no parents). 95 pre-public commits
  live only on local branches. Commit `09e3204` ("chore: clean public v0 surface", not an ancestor of
  main) deleted `SPEC.md`, `OPEN_QUESTIONS.md`, and all 5 technical ADRs — including the only
  product-shaping decisions (control-layer-not-kernel; TypeScript runtime). STATUS.md and
  DECISIONS.md still referenced all of them as existing. Three distinct accepted decisions shared the
  identifier "ADR-0003". (High, fact) — *Resolved 2026-07-25; see the resolution note at the end of
  this record.*
- **F17.** STATUS.md was frozen at 2026-05-28 ("Gate 6") and never updated through five tagged
  releases. WORK_BREAKDOWN.md shows release gates unchecked at tag time, including "Human approval
  required for v0 release candidate" — while the CHANGELOG called v0.1.0 "First accepted OpenMAO
  release… after acceptance verification." Either the trackers were abandoned or the releases
  bypassed their own gates; nothing recorded which. (High, fact + inference)
- **F18.** All 13 merged PRs were self-merged by the sole maintainer with zero GitHub reviews or
  comments (several within 34–60 seconds). "GPT-5.5 audit" / "dual-model audit" records exist only
  inside self-authored PR bodies and self-comments; no second account or bot has ever interacted with
  the repository. The "Independent security/QA/architecture review" issues (#12-14, #33-35) were
  self-filed and self-closed. Roughly 25% of commits across all refs are audit or remediation
  commits. PR #59's own body admits M0/M3 merged non-functional on real data hours earlier: "the live
  work-lifecycle emitters never populated M0's causal fields… The engine worked only on
  hand-instrumented fixtures". `[gh]` (High, fact)
- **F19.** The entire accountability apparatus is gitignored (status, build plan, decisions, module
  ownership, work breakdown, session notes, audits, evidence, audit trails, runbooks, sign-off and
  approval templates, and the audit harness itself, marked "never publish"). The runbook and
  audit-trail directories are empty; the sign-off template was never instantiated; release evidence
  contains reproducible commands but zero captured outputs — test counts are asserted, never
  evidenced. Mitigating: audit findings were real and trace to fix commits. (High, fact) — *This
  finding is the direct cause of ADR-0006 and of the document you are reading.*
- **F20.** The main checkout's git index was missing: all 141 tracked files showed as staged
  deletions, `git ls-files` returned 0, while disk content was byte-identical to HEAD where checked.
  A reflexive `git commit -a` would have committed deletion of the entire repository. (High, fact)
- **F21.** Speculative-kernel violations (NORTH_STAR Principle 7): `Evaluation` and `AgentOutcome`
  have zero usage outside contracts; `Policy` has a schema and an empty table never written or read
  (governance decisions are hardcoded from grants, risk, and autonomy); `ToolStore` is instantiated
  only in one test. VOCABULARY.md simultaneously omits ≥10 types that DO exist. (High, fact)
- **F22.** The Swap Test is vacuous as built: zero framework adapters, zero references to
  LangGraph/CrewAI/OpenAI-SDK anywhere in `ts/`; the sole "external" reference worker is an in-repo,
  same-process function importing the services directly and asserting externality via string
  literals. ROADMAP Phase 1's acceptance criterion — a genuinely external worker — is unmet while
  Phase 2/3 slices shipped. (High, fact)
- **F23.** Stranded work: PRs #60–#63 (external-worker slice) open and unreviewed since 2026-05-31;
  one branch carried 2 unpushed "Phase 1" commits; a security-fix branch was pushed but unmerged.
  `[gh]` (High, fact)

### External signals

- **F24.** `[gh]` 35 of 42 stars arrived on 2026-06-07 in minute-spaced clusters from a generic
  star/fork farm (throwaway accounts created Apr–Jun 2026, 0 followers, mass-forking the same
  unrelated repositories); 1 star is the maintainer self-starring; 1 is a self-described AI agent
  account. Plausibly-real human stars: ~5. 26 of 28 forks are the same farm. Real human watchers: ~1.
  (High, fact + inference on farm characterization)
- **F25.** `[gh]` Exactly two external PRs exist: one contributing a hash-chained tamper-evident event
  log (+173 LOC, on-thesis, and outreach-converted — its body references a prior capability-gateways
  thread), and one drive-by spelling-automation PR. Both sat at 0 comments and 0 reviews for 5–6
  days. The contributors endpoint lists the maintainer only. Discussions enabled, count 0. Zero
  external mentions of OpenMAO anywhere on GitHub beyond the maintainer's own properties and an
  automated plugin-directory scraper. (High, fact)
- **F26.** `[gh]` Traffic over 14 days: 470 views / 181 uniques, dominated by launch day and the bot
  wave; organic baseline 4–33 views/day, decaying. Referrers: one link-shortener click in 14 days; no
  aggregator, forum, or newsletter referrers. Clones ~90% self-generated during the build burst.
  (High, fact)
- **F27.** `[private — summarized; underlying evidence withheld]` A cold-outreach campaign of roughly
  190 emails was executed 2026-05-29..06-06 in mechanized batches, against a scraped contact dataset,
  **in direct violation of the campaign's own written rules**, which prohibited exactly that harvest
  method and exactly that generic-blast shape. It produced a reply rate at the campaign document's
  own failure threshold. At least 8 substantive replies — including code-level reviews and one offer
  of a call — were still unread four days later. The campaign stopped at roughly 31% of its drafted
  schedule; tracking was never updated; the sanctioned human-verified-contacts lane was never used;
  and every planned public channel went unexecuted, which the absence of any web footprint
  independently corroborates. *Recipient identities, message contents, the dataset, and the
  correspondence itself are withheld: those are third parties who did not consent to appear here.*
  (High confidence on this project's own conduct)
- **F28.** The "10 days of silence" is 6 at the GitHub layer: 31 planning issues, one PR with
  self-audit comments, pushes through 06-05, an organization transfer, then a total stop. The gap is
  a burst-crash attention pattern plus a pivot to meta-work, not pure absence. (High, fact +
  inference on pattern)

### Headline verdicts

- **V1.** By NORTH_STAR's own clauses, the shipped self-correction stage is currently the thing it
  "must never become": the only operator-reachable loop turn records a recommendation string and
  changes no future behavior (F4–F6); memory is storage plus retrieval with gates but no consumption
  path (F13); audit is invisible to outsiders and moves no dial (F7, F19). Wedge-grade governance is
  real; loop-grade self-correction is not yet real. The destination vocabulary was claimed in commit
  messages before the wedge was earned (F15, F22).
- **V2.** The trust apparatus is single-principal at every layer (F8, F9, F18, F19) in a product
  whose value proposition is trust. "Independent review" meant a second AI model driven by the same
  person.
- **V3.** Organic demand evidence is approximately zero; the only real signal was manufactured by
  outreach and was being wasted (F24–F27).
- **V4.** The enforcement core and test discipline are genuinely excellent and are the repository's
  verifiable asset (F1, F11, F12).

## 2. Recommendations

Five ADRs were proposed and subsequently ratified on 2026-06-11:

- **R1 / [ADR-0006](../adr/ADR-0006-public-or-dead-governance-records.md)** — public-or-dead
  governance records (F17–F19).
- **R2 / [ADR-0007](../adr/ADR-0007-first-class-principals.md)** — first-class principals at the
  trust boundary (F8–F10).
- **R3 / [ADR-0008](../adr/ADR-0008-falsifiable-adoption-gate.md)** — falsifiable adoption gate
  (F24–F26, V3).
- **R4 / [ADR-0009](../adr/ADR-0009-truth-in-status-for-org-changes.md)** — truth-in-status for org
  changes (F4–F6).
- **R5 / [ADR-0010](../adr/ADR-0010-independent-review-terminology.md)** — retire "independent
  review" as a label for AI second opinions (F18–F19).

Fourteen actionable items were filed; eleven became public GitHub issues #100–#110. Three were
handled internally: one because it concerned private correspondence, one because it duplicated
existing issues, and one because ADR-0006 absorbed it.

## 3. Full report

The complete knife-first report was delivered in the audit session and is summarized by V1–V4 and
the recommendations above. The session transcript itself is not published — the repository protocol
forbids committing transcripts, a rule ADR-0010 deliberately preserved.

## 4. Convergence record (adversarial verification pass)

**Run:** 2026-06-10, Codex CLI (`gpt-5.5`), adversarial contract — the verifier was instructed to
refute — with re-execution in a throwaway worktree at `ad0fbec`, read-only on the main checkout.

**Overall verdict (verbatim):** `CONVERGE-WITH-CORRECTIONS — disputed/corrected items: F1, F2, F8,
F12, F18, F21 nuance, F23-F28; recommendations R3, R5, L4-L7, L11, L13, D4 need modification.`

**Zero claims refuted.** Adjudication of the corrections:

| Item | Verifier verdict | Adjudication |
| --- | --- | --- |
| F1, F2 | PARTIAL — counts and behavior confirmed; `make check`/`make demo` failed in the verifier's sandbox on `listen EPERM` | Stands as confirmed-as-executed: the unsandboxed run was fully green (207/207) and the demo completed; the verifier's compiled-CLI replication confirmed identical behavior including `signal_count: 0`. Sandbox caveat noted. |
| F8, F18, F23–F26, F28 | PARTIAL/UNVERIFIABLE — the verifier's sandbox had no network | Stand on live GitHub evidence gathered the same day. The verifier confirmed all repo-local halves. Evidence asymmetry documented. |
| F12 | PARTIAL — the database-handle bypass is architectural inference, not an exploit test | Accepted; the claim was already labeled inference. |
| F21 | Nuance — VOCABULARY lists dead types *and* omits real ones; fix both directions | Accepted; wording tightened. |
| F27 | Out of repo scope as agreed; repo-side artifacts confirmed consistent | Stands on private-channel evidence, flagged as out of repo scope, and summarized rather than published here. |
| R3 | MODIFY — base the adoption gate on repo-observable audit-trail evidence, not stars or traffic | Adopted in ADR-0008. |
| R5 | MODIFY — store durable review outputs and summaries, not private session transcripts | Adopted in ADR-0010. |
| Issue wording | MODIFY — design-review the external hash-chain PR against the existing SQL append-only triggers before adopting; keep the outreach item out of public issues; fold the autonomy-surface item into existing issues | All adopted. |

**Additional verifier findings (adopted):**

1. `scripts/check-public-hygiene.ts` scans `git ls-files`, so on a damaged checkout with 0 indexed
   files the hygiene check passes vacuously.
2. Stray macOS " 2" duplicate artifacts beyond the known documentation set.
3. A whitespace-only actor was accepted at the HTTP boundary (`server.ts:160-164` checked only
   `!actor`).
4. Default execution paths are sensitive to no-listen sandboxes.

**Joint conclusion:** both auditors converge. All five proposed ADRs proceed, two in modified form.

## 5. Deliverables executed (2026-06-10, post-convergence)

- Main checkout git index repaired. Root cause: a stale `index.lock` left by a git process that
  crashed mid-index-rewrite. Removed per git's documented remedy; `git reset` rebuilt the index from
  HEAD. Verified: 141 files tracked, zero diff versus HEAD.
- Five ADRs written (then Proposed, ratified 2026-06-11) and indexed.
- STATUS.md rewritten to honest current state — the gate-system outcome recorded, not retconned.
- DECISIONS.md integrity note added.
- CHANGELOG Unreleased entry recording M0–M4 with honest scope language, left as a visible
  uncommitted edit for maintainer review.
- Eleven GitHub issues created (#100–#110).
- Out of authorized scope, and not done: no commits, pushes, PR or issue comments, emails, or merges.

---

## Resolution notes

**F16 (identifier collision and deleted ADRs) — resolved 2026-07-25.** The five technical ADRs
deleted in `09e3204` were restored from git history and renumbered ADR-0014 through ADR-0018; the
positioning decision that had lived only in the gitignored session notes was published as ADR-0019.
Every ADR now lives in a tracked [`docs/adr/`](../adr/README.md) with one identifier per document.

**F19 (private accountability apparatus) — partially resolved 2026-07-25.** The ADR series, the
decision index, the status record, and this audit record are now public, per ADR-0006 Option A.
What remains private is unchanged in kind: session transcripts, outreach material, and third-party
correspondence.
