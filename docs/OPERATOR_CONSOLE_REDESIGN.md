# OpenMAO Operator Console — UX Audit & Redesign Plan

**Status:** draft plan (in progress). Pairs a current-state audit with a competitive
UI/UX study of leading autonomous-agent / digital-worker products, then proposes a
prioritized redesign that respects [NORTH_STAR.md](../NORTH_STAR.md) and the
[ROADMAP.md](ROADMAP.md) sequencing.

> One-line thesis: **OpenMAO's web console today is a read-only database inspector and
> demo harness. To let a human *run* an organization of AI agents, it has to become an
> operator cockpit — a place where you delegate work, watch it happen, and govern
> autonomy by exception.** The visual foundation is already good; the interaction model,
> information architecture, and vocabulary are not.

---

## 1. Current state (what we actually have)

### 1.1 Two front ends, wildly asymmetric

OpenMAO ships two operator surfaces today:

| Surface | File | What it can do |
| --- | --- | --- |
| **CLI** | [`ts/src/cli.ts`](../ts/src/cli.ts) (784 LOC, ~45 commands) | **Everything.** Create/assign/status/review work, create bounded envelopes, register workers, ingest events, scan/apply/revert learning proposals, search/corroborate memory, pause/resume the org, approve/reject, run the Chief of Staff, manage cadences, diagnose failures. |
| **Web console** | [`ts/src/api/server.ts`](../ts/src/api/server.ts) `consoleHtml()` (~860 LOC inline) | **Almost nothing but look.** 15 read-only views (tables + raw-JSON blobs) plus a handful of *demo* buttons (Run demo, Approve demo, Run worker, Tick CoS) and approve/reject/apply on items that already exist. |

The asymmetry is the headline problem. **The only way to do real operator work today is
the terminal.** The web UI — the surface a non-technical operator would actually reach
for — is a window, not a cockpit. The API layer *supports* the writes (`POST /work`,
`POST /workers`, `POST /ingestion`, learning apply, CoS tick, etc.); the console simply
never exposes them as anything but a demo.

### 1.2 The console's information architecture

A 15-item left nav, grouped `Govern / Review / Record`:

- **Govern:** World, Runs, Work, Agents, Chief of Staff, Cadences
- **Review:** Approvals, Promotions, Learning
- **Record:** Memory, Memory Search, Capabilities, Capability Calls, Capability Results, Events, Traces

Almost every view is the same shape: a `dataTable(...)` of raw records followed by a
collapsible **"Raw record"** `<pre>` JSON dump. It is, faithfully, a table viewer over the
SQLite stores. There is no dashboard that answers "what needs me right now?", no object
detail pages (you cannot click a run to drill into its events/traces/approvals — they are
separate top-level nav items), and no cross-linking between related records.

### 1.3 What's good and worth keeping

- **Visual design system is solid.** IBM Plex Sans/Mono, restrained green accent
  (`--accent: #0c6b58`), full light/dark theming via CSS custom properties, consistent
  badges/tags/tables, focus rings, reduced-motion-friendly transitions. This is the
  Claude Design handoff and it reads as calm and credible. *Keep the tokens.*
- **State semantics are already encoded.** `STATE_FAMILY` maps ~30 status strings to
  neutral/info/pending/success/danger; autonomy levels have dedicated colors
  (`advisory / supervised / bounded / board-governed`). The vocabulary of trust is
  already visual — we just under-use it.
- **Zero-build, offline-friendly, no remote scripts.** Inlined SVG icons, fonts with
  system fallback, single-file server. For a self-hostable, sovereign substrate this is a
  feature, not a constraint to throw away lightly.
- **Loopback-only + operator-token gate.** Security posture is appropriate for v0.

### 1.4 The concrete UX problems

1. **No "do work" layer.** You cannot create a work item, write a brief, register/assign
   an agent, set or widen autonomy, or kick off real (non-demo) work from the UI. The
   verbs live only in the CLI.
2. **Developer vocabulary leaks everywhere.** The UI says `latest_run_status`,
   `capability_gaps`, `pending_reviews`, `corroboration_count`, `world model snapshot`,
   `bounded work envelope`, `traces`, `promotions`. An operator running a team thinks in
   *tasks, people, approvals, results, and "can I trust it yet?"* — not kernel types.
3. **No live feedback.** Everything is manual-Refresh. Long-running agent work — the
   entire point — has no streaming status, no live activity feed, no "it's working…"
   affordance. The append-only event log is a static, must-refresh table.
4. **No triage / no home.** The default view ("World") is a metrics snapshot, not an
   inbox. There is no single place that says "3 approvals waiting, 1 run blocked, 2
   proposals to ratify." The operator has to go *looking* for what needs them.
5. **Flat, not drillable.** Runs, Events, Traces, Approvals, Capability Calls are all
   siblings in the nav instead of being *facets of a run or a work item* you drill into.
   Context is shattered across 15 tabs.
6. **No object creation/editing, no onboarding, no empty-state guidance.** A fresh
   install with no token shows "Enter your operator token" on every tab; a fresh
   workspace shows "No records." everywhere. Nothing teaches the model or invites a first
   action.
7. **Autonomy is shown but not governable.** The autonomy pill is display-only. The thing
   that *is* the product's reason for being — earning and widening autonomy — has no
   surface to view the evidence behind the dial or to perform a governed widening.
8. **Workspace is effectively singular in the UI.** The header hardcodes one
   `WORKSPACE_ID`; the API supports many, but there's no switcher.

---

## 2. Constraints the redesign must respect (from the charter)

The redesign is an evolution of persona — from *developer* (Phase 1's "a developer can…")
toward *operator/board* (the North Star's "human moves up from operator to board"). That
is on-direction, but it must not drift. Hard rails from [NORTH_STAR.md](../NORTH_STAR.md)
and [ROADMAP.md](ROADMAP.md):

- **Native work management, agent-first (product-owner direction — revises a non-goal).**
  The console *should* include first-class **Tasks, Projects, and recurring tasks** — as
  capable for planning and tracking as Paperclip or Linear — because operator productivity is
  the point. Two rules keep it on-charter: (1) it's **agent-native work management** — every
  task can be delegated to an AI agent, governed by approvals/autonomy, and feeds memory; it
  is *not* a generic human-only PM clone. (2) **Vocabulary is operator-first** — call them
  *Tasks* and *Projects*, never *Issues* (operators aren't all software teams). Connecting
  external tools (Linear, Jira, Notion) is a later **opt-in sync**, not a dependency. _This
  consciously revises the roadmap's "not a general-purpose PM app" non-goal: the differentiator
  is the governance + memory + earned-autonomy layer wrapped around the work, not the absence
  of task management. Flagged to update NORTH_STAR/ROADMAP wording — not silently rewritten._
- **Accountability before autonomy.** Autonomy is *earned on audited evidence*, "never
  granted by default," always reversible. So the autonomy control is **not a free slider** —
  it surfaces the track record and performs a governed, reversible widening with a
  recorded event. (Note: `OrgControlService` today exposes `pause/resume/get`, not a
  set-level write — widening is deliberately not a toggle.)
- **The world model is a projection.** The UI must never imply the world view is source of
  truth; it's a rebuildable read.
- **Substrate, not identity.** Governance/approvals are table stakes — don't let the UI
  make OpenMAO *look* like "an approvals tool." The differentiated surfaces are
  **institutional memory growing** and **the org improving itself** (self-correction).
  Those deserve first-class, visible real estate.
- **Swap test / ownership.** UI stays self-hostable, no remote dependencies, no
  vendor-locked embeds; the org's asset stays portable.
- **Deferred (don't over-build):** multi-user auth & permissions, hosted SaaS, template
  marketplaces are cross-cutting/future — the IA can *anticipate* them but the plan
  shouldn't ship them.

### 2.1 Vocabulary translation (operator-facing labels)

The kernel types are correct; the *labels* should speak operator. Proposed surface
mapping (kept reversible — power users can toggle "developer names"):

| Kernel / current UI term | Operator-facing label |
| --- | --- |
| World model snapshot | **Overview / Org status** |
| WorkItem | **Task** (with owner, reviewer, success criteria) |
| TaskEnvelope / bounded work envelope | **Handoff** (a single delegation of a task to an agent) |
| Run | **Run** (one execution attempt) — kept, but drilled-into not top-level |
| Agent | **Agent / teammate** |
| Capability | **Tool action** (governed) |
| CapabilityCall / Result | **Action requested / Action result** |
| Approval | **Approval** (kept) |
| PromotionCandidate / promotion | **Knowledge up for ratification** |
| MemoryEntry (collective) | **What the org has learned** |
| OrgChangeProposal / Learning | **Suggested improvements** |
| Corroboration | **Independent confirmation** |
| Autonomy level | **Trust level / autonomy** (kept, made central) |
| Event / Trace | **Activity / Audit trail** (drill-down, not top-level tabs) |
| Cadence | **Schedule** |
| Chief of Staff | **Chief of Staff** (kept — it's the human's proxy) |

---

## 3. Competitive UI/UX study

Organized by **pattern**, not product. For each: who does it well, the underlying
principle, and the **OpenMAO read** (what it implies for us). Sources are listed at the
end of the section; claims survived the research run's adversarial verification unless
flagged.

> **Honest scoping note.** The richest, most transferable UI evidence comes from the
> *developer-agent* tools (Devin, Cursor, GitHub Copilot agents, Claude Code) and from the
> agentic-UX design literature (Smashing, Prigent, UXmatters, StackAI, mantlr). The
> "digital-worker" products aimed at non-technical buyers (Lindy, Artisan/Ava, Paperclip,
> Twin, Ona) market outcomes more than screens, so their public UI detail is thinner — the
> patterns below are drawn where the evidence is strongest and noted where a product is
> illustrative rather than documented.

### Pattern 1 — Delegating work & specifying intent
**Leaders:** Devin 2.0's **Interactive Planning**: on session start it produces relevant
files, findings, and a *preliminary plan within seconds* that the user edits **before**
delegating autonomous work [9]. The agentic-UX literature generalizes this as an **Intent
Preview** — before acting, the agent states planned actions/outcomes in plain language and
offers exactly three choices: *proceed / edit the plan / take over manually* [1]. UXmatters
names the structural winner: a **"Taskboard + Outcomes"** display (goals, tasks, owners,
status, SLAs) that *replaces the chat transcript* — called the single highest-impact
pattern for moving an agent product past the demo stage [3].
**Principle:** delegation is a *reviewable contract*, not a chat message. Show the plan and
the success criteria up front; make editing the plan a first-class step.
**OpenMAO read:** this is the single biggest missing layer. OpenMAO already *has* the right
object — a `WorkItem` with objective, owner, reviewer, success criteria, risk — but the UI
can't create one. A "New Task" composer that captures objective + success criteria + risk +
reviewer, then shows a plan/handoff preview before dispatch, maps almost 1:1 onto
`WorkItem` → `TaskEnvelope`.

### Pattern 2 — Trust, autonomy & human-in-the-loop  ★ most relevant to OpenMAO
**Leaders:** **Claude Code** ships a discrete, *named* permission-mode ladder (default →
acceptEdits → plan → auto → dontAsk → bypassPermissions); critically, the mode is changed
through a **dedicated UI control (Shift+Tab / a mode selector), explicitly NOT by asking the
agent in chat** — the trust-setting control is separated from the task control [6]. On top
of the coarse mode sit per-tool **allow/ask/deny** rules and a set of **protected paths**
that are *never* auto-approved short of the most dangerous mode — a hard floor no granted
autonomy can override [6]. The design literature converges on the same shape: an **Autonomy
Dial** with a 4-level spectrum (Observe & Suggest → Plan & Propose → Act with Confirmation →
Act Autonomously), set **per task type** [1]; mantlr frames it per-workflow as
**Suggest → Draft → Execute**, *defaulting to low autonomy for first-time workflows and
letting agents earn higher autonomy through proven reliability* [5]. StackAI operationalizes
"earned": start supervised, graduate to exception-only/sampled approvals once metrics prove
reliability, and manage reviewer load with **risk-based sampling** — approve 100% of
high-risk actions but only a small sample of low-risk ones [4]. The reviewer surface itself
should go **beyond binary approve/reject** (request-changes, approve-with-edits, escalate)
and present a fast **"evidence pack" so a decision takes 10–30 seconds** [4]. Claude Code's
"auto mode" adds two refinements worth stealing: a blocked action is **returned to the agent
as a tool result telling it to find a safer path** (graceful degradation, not a hard halt),
and **escalation is threshold-based** (after N consecutive/total denials) rather than
per-event [7]. Anthropic also models honesty about limits — publishing that the classifier
guardrail still lets through a meaningful fraction of overeager actions, i.e. *the dial is
not a substitute for human review on high-stakes work* [7].
**Principle:** autonomy is a **visible, primary, earned, reversible** setting — coarse mode
+ fine per-capability scoping + hard floors — and the *trust* control is deliberately
separate from the *task* control.
**OpenMAO read:** this is OpenMAO's home turf and its biggest latent advantage. The charter's
`advisory → supervised → bounded → board-governed` dial **is** the Autonomy Dial the whole
industry is converging toward — but today it's a read-only pill. The redesign should make it
the centerpiece: show the *current* level, the *evidence* behind it (track record from
events/outcomes), and a **governed, reversible widening** action (not a free slider — matches
"earned on audited evidence"). Per-capability `default_permission` (allow/block/
require_approval/log_only) is OpenMAO's version of per-tool allow/ask/deny, and risk levels
already exist — surface them as the fine-grained layer beneath the dial. The Approvals view
should adopt the **evidence-pack + non-binary actions** model.

### Pattern 3 — Monitoring long-running / async work
**Leaders:** Devin consolidates shell commands, code edits, and browser activity into one
**Progress tab**, plus an **activity timeline** of command history with output previews and
the ability to jump to points in the session [8]. GitHub Copilot exposes a **globally
reachable agents panel** (from any page) and, per session, a combined **log + the agent's
reasoning + the tools it used + live metrics** (token usage, session length); you can
**steer a running agent mid-task by entering a new prompt** (applied after the current tool
call), and **stopping is non-destructive** — pushed commits survive [11]. Cursor lets you
**take over or redirect mid-run**, runs **multiple background agents in parallel**, and
surfaces a live **to-do/progress artifact** rather than only a raw log [12]. UXmatters is
blunt about the baseline: **start/stop/pause controls are mandatory**, and their absence is
the **"Sorcerer's Apprentice"** runaway anti-pattern [3]. Devin's HITL guidance: **pause
before takeover** to avoid conflicting edits, and **intervene early** [8].
**Principle:** long-running work needs a *live, consolidated activity surface* with
interruptibility (pause/stop/steer) and **non-destructive** stops — observation plus control,
not just logs.
**OpenMAO read:** today the Events log is a static, must-refresh table and Runs/Traces are
separate tabs. Make a **live run timeline** (stream events as they happen), reachable from
the run *and* from a global activity surface, with the run's pending approval, traces, and
capability calls **drilled into the run** rather than scattered across nav. OpenMAO's
approval-suspend/resume already gives it a *clean, principled* pause/resume — surface it as
the steering control.

### Pattern 4 — Representing an organization / team of agents
**Leaders:** the strongest concrete pattern is **Role Cards** — each agent shown with its
role, scope, tools, permissions, and **handoff rules** [5]. Devin and Cursor both ship a
**roster/control panel of concurrent agents** with per-agent status, and Devin's
"manage Devins" extends this to a supervisor running many workers [10][12]. Copilot's panel
distinguishes **sessions you started vs. sessions others prompted** [11]. At the category
level there's an active debate (Ema, Lindy, Workday's "agent system of record") about whether
**AI workers belong on the org chart** and how to represent a hybrid human+agent workforce
[16][17] — directionally validating OpenMAO's "organization of agents" framing, though these
are positioning sources, not UI references.
**Principle:** represent each agent as an accountable team member (role, scope, permissions,
track record), and give the operator one roster to see the whole workforce at a glance.
**OpenMAO read:** the Agents table should become **Role/Agent cards**: identity, role,
model binding, **autonomy/permission scope**, the capabilities it's granted, current
work, and its **track record** (this is where OpenMAO's audited history becomes a
differentiator no dev-tool has). OpenMAO's `Role` → `Agent` model already encodes
reports-to/permissions — render it as a lightweight org view.

### Pattern 5 — Memory, learning & audit trails  ★ differentiator
**Leaders:** Devin surfaces persistent knowledge in the UI via **Devin Wiki** (auto-indexes
repos into architecture docs + source-linked answers) and **Devin Search** for cited answers
about the codebase [9] — memory made *visible and navigable*, not a hidden vector store. The
design literature treats a persistent **Action Audit & Undo log** (chronological, clear
status, **time-limited undo windows**) as a *required* post-action safety pattern, because
**easy reversibility is what creates the psychological safety to delegate** [1]. mantlr calls
for explicit **memory controls** — what's remembered, why, with edit/delete and scope [5].
uxmag notes agents go **intern → expert** as they accumulate memory, which makes audit-trail
concerns (versioning, RBAC, provenance) *first-class UI requirements* [13]. Copilot ties
every commit to its session log and lists the human as co-author — **work is traceable back
to the run that produced it** [11].
**Principle:** memory and audit are not back-office logs — they're the trust surface. Show
what the org knows, where it came from, and let the human correct it; make every action
reversible and traceable.
**OpenMAO read:** this is the charter's "compounding institutional asset," and OpenMAO is
*architecturally ahead* here (collective vs. individual memory, promotion with corroboration,
append-only events, rebuildable world model) — but it's buried in raw-JSON tables. Promote it:
a "**What the org has learned**" view (collective memory with provenance + corroboration),
a ratification queue framed as trust-building, and the event log reframed as a human-readable
**audit trail with reversibility** (OpenMAO's reject/revert is the "undo").

### Pattern 6 — Information architecture for many concurrent projects/agents
**Leaders:** Prigent's three-layer hierarchy is the cleanest model: **Agents › Missions ›
Tasks**, with an **Overview Panel** (triage home), an **Activity Log** (reverse-chron,
filterable, exportable timeline of all missions), and **Work Reports** [2]. The governing
principle across the literature is **"Minimum-Workload Oversight"**: oversight should be
lightweight — options and summaries, not chores and oversharing — with **selective**
notifications so the human isn't bombarded [2].
**Principle:** a triage-first home that answers "what needs me now?", a clear object
hierarchy you drill *into* (not 15 flat sibling tabs), and notifications tuned for minimum
workload.
**OpenMAO read:** replace the flat 15-item nav with a hierarchy — **Home/triage → Work →
Agents → (drill into a run) → Knowledge → Governance**. Fold Runs/Events/Traces/
Capability-Calls/Results into **drill-downs of a Work item or Run**, not top-level tabs. The
Chief of Staff is already OpenMAO's "Minimum-Workload Oversight" engine — make its inbox the
default Home.

### Pattern 7 — Onboarding & first-run for non-technical operators
**Leaders:** Devin's Interactive Planning doubles as onboarding — you *see the plan before
you commit* [9]. The "default to low autonomy for a first-time workflow, earn more later"
norm [5] is itself an onboarding-safety pattern. (This was the **thinnest** evidence area —
most agent tools still assume a technical first-run.)
**Principle:** the first run should teach the model by doing one real, safe, reversible
thing — at the lowest autonomy — and show the plan before acting.
**OpenMAO read:** today a tokenless install shows "Enter your operator token" on every tab
and an empty workspace shows "No records." everywhere. Add a **first-run path**: set the
token once, then a guided "create your first task → watch it run → approve at the gate →
see what was learned" flow that walks the flywheel. Empty states should *invite the next
action*, not report emptiness.

### Pattern 8 — Visual & interaction conventions + anti-patterns
**Leaders:** best-in-class operator UIs (Stripe, Linear, Vercel) share a **monochrome base
with a single restrained accent**, **high contrast** (avoid muddy mid-tones), **generous
whitespace** treated as functional (heuristic: double the spacing that already feels
sufficient), and **sharp geometric typography** that signals precision (Vercel's Geist) [14].
The dominant **anti-pattern**, stated repeatedly: **chat-first UX fails for autonomous
agents** — chat was built for conversation, not action-taking/oversight, and exhibits
invisible actions, unclear state, no start/stop/pause, and no recovery [3]. Progressive
disclosure (a feed that starts empty and fills, observations → hypothesis) is the
recommended alternative to a wall of logs [13].
**Principle:** quiet, high-contrast, spacious, structured surfaces — and **structured work
displays over chat** for anything an agent *does*.
**OpenMAO read:** OpenMAO's existing design system already matches the winning convention
(IBM Plex ≈ geometric/precise, single green accent on neutral, full theming) — **keep it**.
The work is interaction and density, not a reskin. And the anti-pattern is a *guardrail for
us*: resist the temptation to make the operator surface a chatbot; OpenMAO's structured
`WorkItem`/`Run`/`Approval` model is exactly the "Taskboard + Outcomes" alternative the
literature prescribes.

### Sources
[1] Smashing Magazine, *Designing Agentic AI: Practical UX Patterns* — smashingmagazine.com/2026/02/designing-agentic-ai-practical-ux-patterns/
[2] B. Prigent, *7 UX Patterns for Human Oversight in Ambient AI Agents* — bprigent.com/article/7-ux-patterns-for-human-oversight-in-ambient-ai-agents
[3] UXmatters, *Designing for Autonomy: UX Principles for Agentic AI* — uxmatters.com/mt/archives/2025/12/designing-for-autonomy-ux-principles-for-agentic-ai.php
[4] StackAI, *Human-in-the-Loop AI Agents: approval workflows* — stackai.com/insights/human-in-the-loop-ai-agents-how-to-design-approval-workflows-for-safe-and-scalable-automation
[5] mantlr, *Designing for AI Agents: UX Patterns 2026* — mantlr.com/blog/designing-for-ai-agents-ux-patterns-2026
[6] Claude Code docs, *Permission modes* — code.claude.com/docs/en/permission-modes
[7] Anthropic Engineering, *Claude Code auto mode* — anthropic.com/engineering/claude-code-auto-mode
[8] Devin docs, *Session tools* — docs.devin.ai/work-with-devin/devin-session-tools
[9] Cognition, *Devin 2.0* — cognition.ai/blog/devin-2
[10] Cognition, *Devin can now manage Devins* — cognition.ai/blog/devin-can-now-manage-devins
[11] GitHub docs, *Manage and track Copilot agents* — docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/manage-and-track-agents
[12] S. Kinney, *Cursor background agents* — stevekinney.com/courses/ai-development/cursor-background-agents
[13] UXmag, *Secrets of Agentic UX* — uxmag.com/articles/secrets-of-agentic-ux-emerging-design-patterns-for-human-interaction-with-ai-agents
[14] Pixeldarts, *Four Design Principles behind Stripe, Linear, and Vercel* — pixeldarts.com/en/post/four-design-principles-behind-stripe-linear-and-vercel
[15] agentsroom, *Multi-agent dashboard* — agentsroom.dev/multi-agent-dashboard
[16] Ema, *Should AI employees appear on your org chart?* — ema.ai/blog/managing-effectively/...
[17] Lindy, *AI workforce* — lindy.ai/blog/ai-workforce · Workday, *Agent system of record* — workday.com/en-us/artificial-intelligence/agent-system-of-record.html
[18] Relay.app docs, *Agents* — docs.relay.app/agents/agents · Paperclip — github.com/paperclipai/paperclip · Ona — ona.com/stories/gitpod-is-now-ona · Artisan — artisan.co/ai-sales-agent

> _A fuller, independently-cited research report is being regenerated by the deep-research
> workflow (resumed from cache); this section already reflects its verified findings._

---

## 4. Recommendations

Prioritized by leverage. Each names the problem (§1.4) it closes, the pattern (§3) it
borrows, the OpenMAO surface it touches, rough effort, and roadmap phase. **The throughline:
turn the console from an inspector into a cockpit — a place to *delegate, watch, and govern*.**

### Tier 1 — Highest leverage (mostly client-side; no new kernel semantics)

**R1 · A triage Home that answers "what needs me now?"** — *(fixes #4; Pattern 6 [2])*
Default view becomes an **inbox**, not a metrics snapshot: pending approvals, blocked runs,
knowledge awaiting ratification, suggested improvements, and Chief-of-Staff notifications —
each a one-click resolution. OpenMAO already has the data (`/approvals`, `/world`,
`/cos/notifications`, `/memory/promotions`, `/learning/proposals`) and the CoS *is* a
"Minimum-Workload Oversight" engine — surface it. **Effort: M. Phase 1.**

**R2 · Restructure IA into a drill-down hierarchy** — *(fixes #5; Pattern 6 [2])*
Collapse the flat 15-item nav into **Home · Work · Agents · Knowledge · Governance** (+ a
power-user "Audit" area). Make Runs, Events, Traces, Capability Calls/Results **drill-downs
of a Work item or Run**, not siblings. One object, one place, expandable detail.
**Effort: M. Phase 1.**

**R3 · An operator vocabulary layer** — *(fixes #2; Pattern 8)*
Apply the §2.1 label map (Task, Handoff, Tool action, "What the org has learned", Trust
level, Activity/Audit trail …) as a presentation layer, with a **"show developer names"**
toggle for power users. Pure relabeling + tooltips; the contracts don't change.
**Effort: S. Phase 1.**

**R4 · Agent/Role cards with track record** — *(improves Agents view; Pattern 4 [5])*
Replace the agents table with cards: identity, role, model, **autonomy/permission scope**,
granted capabilities, current work, and **track record** (outcomes/approvals history). The
track record is the differentiator no dev-tool can show. Data from `/agents` + `/org` +
worker outcomes. **Effort: M. Phase 1.**

**R5 · Approvals as an "evidence pack" with non-binary actions** — *(fixes part of #1/#7;
Pattern 2 [4])* Each approval becomes a card a human can resolve in **10–30s**: what's being
requested, by whom, which policy fired, the risk, the reversible on-reject path — plus
actions beyond approve/reject (**reject-with-reason / escalate**; "approve-with-edits" later).
Builds on the existing Approvals cards. **Effort: S–M. Phase 1.**

**R6 · A real first-run + inviting empty states** — *(fixes #6; Pattern 7 [9][5])*
Token entry once, then a guided "**create a task → watch it run → approve at the gate → see
what was learned**" walk through the flywheel (the existing demo can power it). Every empty
state proposes the next action instead of reporting "No records." **Effort: M. Phase 1.**

**R7 · Workspace switcher** — *(fixes #8)* The API is multi-workspace; the header isn't. Add a
switcher over `/workspaces`. (Full multi-user auth stays deferred per roadmap.)
**Effort: S. Phase 1.**

### Tier 2 — The "do work" + "watch work" layer (needs small backend additions)

**R8 · A "New Task" composer with a plan/handoff preview** — *(fixes #1 — the biggest gap;
Pattern 1 [1][3][9])* A form that captures objective, success criteria, owner/reviewer, risk
→ creates a `WorkItem` (`POST /work`), then shows a **preview of the handoff** before
dispatch (`assign` + bounded `envelope`). This is OpenMAO's **Interactive Planning / Intent
Preview**. Endpoints already exist; this is mostly client + validation. **Effort: M. Phase 1.**

**R9 · A live run timeline** — *(fixes #3; Pattern 3 [8][11][3])* Stream events into a
consolidated, human-readable activity feed on the run page, with the run's pending
approval/traces/capability-calls inline. Surface OpenMAO's **suspend/resume as the
pause/steer control** (it's a principled, non-destructive pause the dev-tools approximate
hackily). Needs one new endpoint: **SSE `/events/stream`** (loopback + token-gated), client
`EventSource`, poll fallback. **Effort: M. Phase 1→2.**

**R10 · Make the Autonomy Dial the centerpiece** — *(fixes #7; ★ Pattern 2 [1][5][6])*
A prominent panel showing the current level (`advisory→supervised→bounded→board-governed`),
**the evidence behind it** (track record from events/outcomes), and the **per-capability
scope** beneath it (`default_permission`: allow/block/require_approval/log_only — OpenMAO's
allow/ask/deny). *Phase-1 scope = visualize the dial + evidence (read-only, honest).* The
**governed widening write** (R14) comes later, deliberately, because the charter says
autonomy is earned, not toggled. **Effort: M (viz). Phase 1→2.**

### Tier 3 — Elevate the differentiators (Phase 2–3)

**R11 · "What the org has learned" — memory as the trust surface** — *(elevates the
differentiator; Pattern 5 [1][9])* Promote collective memory out of raw tables into a
browsable knowledge view with **provenance + corroboration**, a ratification queue framed as
*trust-building*, and memory search as a first-class feature. **Effort: M. Phase 2.**

**R12 · Audit trail with reversibility ("undo")** — *(Pattern 5 [1])* Reframe the event log
as a human-readable, filterable audit timeline where reversible actions (reject/revert)
read as **undo** — the pattern the literature ties directly to delegation confidence.
**Effort: S–M. Phase 2.**

**R13 · "Suggested improvements" — the self-correction surface** — *(forward differentiator;
Pattern 5)* The existing Learning view, reframed: the org proposing changes to its own roles/
policies/workflows, with evidence and human ratification. Keep it visible — the charter warns
that letting self-correction slide is drift. **Effort: S (reframe). Phase 3.**

**R14 · Governed autonomy widening** — *(★ Pattern 2 [5][7])* A reversible, audited widening
action gated on evidence (not a free slider): the human ratifies a level change, an event is
recorded, and it can be rolled back. New governed endpoint; design carefully against the
charter. **Effort: M–L. Phase 2→3.**

### Effort × impact, at a glance
| | Low effort | Medium effort | Higher effort |
| --- | --- | --- | --- |
| **High impact** | R3, R5, R7 | R1, R2, R4, R8, R9, R10 | R14 |
| **Medium impact** | R12, R13 | R6, R11 | — |

---

## 5. Architecture & code-change proposals

The current single-file, zero-build, loopback-only console is **not a mistake to undo** — it
matches the charter's self-hostable/sovereign posture (no remote runtime deps, runs offline,
single binary). The goal is to make it *maintainable and interactive* without betraying that.

**A1 · Keep the posture, fix the maintainability.** ~860 lines of HTML/CSS/JS inside a
template literal in `server.ts` won't survive this much new surface. Extract the client into
real files served locally by the same server (no CDN at runtime). Two viable paths:
- **A1a (recommended, light):** keep vanilla JS + the existing `el()` helpers, but split into
  per-view modules and a shared component file, served as static local assets. No framework,
  no build, preserves the offline/zero-dep property.
- **A1b (if component ergonomics start to hurt):** adopt a **dependency-light, build-free**
  component lib (e.g. Preact + `htm` via a vendored local module) — still single-binary, still
  offline, but with real components/state. Defer unless A1a friction is real.
  *(Avoid a heavy React/Next SPA + bundler — it complicates self-hosting for little gain at
  this scale.)*

**A2 · Vendor the fonts.** The console `@import`s IBM Plex from the Google Fonts CDN — a
runtime remote dependency that breaks the offline/sovereign promise. Vendor the woff2 files
locally (system fallback already exists).

**A3 · Expose the writes the API already supports.** `POST /work`, `/work/:id/assign`,
`/work/:id/envelopes`, `/workers`, `/ingestion`, `/cos/tick`, learning apply, memory
corroborate are all implemented server-side but absent from the console. R8/R5/R4 are
**mostly client forms** over endpoints that exist — the gap is UI, not kernel. All writes
already require actor + workspace + idempotency key; keep that (console actor = `local_operator`).

**A4 · Add a live channel (one new endpoint).** `GET /events/stream` as **Server-Sent
Events**, loopback + token-gated, tailing `EventStore` for the workspace/run; client uses
`EventSource` with a polling fallback. SSE (not WebSockets) keeps infra minimal and one-way,
which is all the activity feed needs. Powers R9 and a live Home.

**A5 · Two small read-model additions** for the new surfaces: an **agent track-record**
projection (aggregate outcomes/approvals/events per agent) for R4's cards, and an
**autonomy-evidence** projection (what in the audit trail supports the current level) for R10.
Both are *projections over existing events/stores* — consistent with "the world model is a
projection," nothing becomes a new source of truth.

**A6 · One genuinely new governed write (later, R14):** `POST /org/autonomy` that performs a
**reversible, audited** level change (records an event; rejectable; revertible). This is the
only change that touches authority semantics — it must pass the Drift Test and ship after the
evidence-visualization (R10) earns its place. Until then, widening stays CLI/`OrgControlService`.

**A7 · Componentize the design tokens.** The `:root` token block, badges, tags, autonomy
pills, tables, and timeline are already a de-facto design system — extract them into a shared
stylesheet/components so every new view inherits them. This is the asset to preserve.

> **Net:** Tier 1 is *almost entirely client-side* over today's API. Only R9 (SSE), R4/R10
> (two projections), and R14 (one governed write) need backend work — all additive, none
> altering existing contracts or the charter's invariants.

---

## 6. Phased rollout

Aligned to [ROADMAP.md](ROADMAP.md). Note Phase 1 *already* lists "**Operator review loop —
improve the console**" (item #6) as required work, so Wave 1 is on-roadmap, not a detour.

**Wave 1 — "Cockpit-lite" (Phase 1, client-only).** R1 Home/triage · R2 IA hierarchy · R3
vocabulary layer · R4 agent cards · R5 approvals evidence-pack · R6 first-run · R7 workspace
switcher. *Outcome: the operator can triage and govern existing work without the terminal,
in human language.* No kernel changes; ships fast.

**Wave 2 — "Delegate & watch" (Phase 1→2).** R8 New-Task composer + handoff preview · R9 live
run timeline (SSE) · R10 autonomy-dial evidence visualization. *Outcome: a human can create
real work, watch it run live, steer/pause it, and see why the trust level is where it is —
the full operator loop, GUI-only.* Adds SSE + two projections (A4/A5).

**Wave 3 — "Compounding asset & earned autonomy" (Phase 2→3).** R11 memory-as-trust-surface ·
R12 audit/undo · R13 suggested-improvements reframe · R14 governed autonomy widening.
*Outcome: the differentiators (institutional memory growing, the org improving itself, the
dial widening on evidence) become the visible heart of the product.*

### Success metrics
- **Time-to-first-real-task from the UI:** currently ∞ (impossible) → target: under a few
  minutes on first run.
- **% of operator actions doable without the CLI:** today the web UI can create/control almost
  nothing → target: the full Phase-1 journey (create → assign → approve → review → inspect)
  is GUI-complete.
- **Approval decision time:** target < 30s via the evidence pack [4].
- **Flywheel legibility:** a non-technical operator can narrate "what the org did, what it
  learned, and whether I can trust it more" from the UI alone.

### Explicitly out of scope (respect roadmap deferrals & non-goals)
Multi-user auth/permissions, hosted SaaS control plane, template/pack marketplace, and a
chat-first interface (the §3 anti-pattern). The IA may *anticipate* multi-user/templates; it
should not *ship* them here.

---

## 7. Bottom line

OpenMAO's problem isn't taste — the visual system is already in the same family as the
best operator UIs. The problem is that **the web surface is a read-only window onto a kernel,
while everything an operator needs to *do* lives in the CLI**, dressed in kernel vocabulary,
with no live feedback and no triage. The fix is to expose the verbs the API already supports,
restructure around "what needs me / what's running / what did we learn," speak the operator's
language, and make the one thing OpenMAO has that nobody else does — **an earned, audited,
reversible autonomy dial backed by institutional memory** — the centerpiece instead of a
read-only pill. Most of Wave 1 is achievable over the existing API.

