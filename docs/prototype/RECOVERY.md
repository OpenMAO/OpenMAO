# Operator console prototypes — recovery record

Four prototypes were authored in Claude session `dcf17909` (worktree
`intelligent-murdock-2781be`) alongside [OPERATOR_CONSOLE_REDESIGN.md](../OPERATOR_CONSOLE_REDESIGN.md)
and [DECISION_QUALITY_DATA_MODEL.md](../DECISION_QUALITY_DATA_MODEL.md). None were ever
committed. The worktree was later deleted and all four were lost from disk.

The plan doc and DQ spec were recovered in commit `3495a21`. This note records what
happened to the prototypes themselves.

| File | Direction | Status |
|---|---|---|
| `console-prototype-dq.html` | Decision-quality reframe | **Restored** — replayed from transcript, byte-verified |
| `console-prototype-hybrid.html` | **Chosen direction** | Fragments only — but ~71% of its distinctive layer survives inside the restored `-dq` file |
| `console-prototype.html` | Direction A (structured dashboard) | 3 fragments only — no base content |
| `console-prototype-alt.html` | Direction B (Chief-of-Staff chat) | Unrecoverable — no surviving tool calls of any kind |

## What "replayed" means, and why only -dq qualifies

A lost file is *replayable* only if the transcript preserves the original `Write` call —
the full file bytes — plus every later `Edit` against it. `-dq` has that: one `Write`
(1,268 lines) and 13 `Edit`s, all of which returned success in their original run.
Replaying them in timestamp order reproduces the file deterministically. Every
non-`replace_all` edit matched its anchor exactly once, so nothing was resolved by guess.

The verification is independent of the replay: three `Read` calls on 2026-06-07
(08:14:00 / 08:14:06 / 08:14:13) together captured lines 1–1268 — the whole file at that
moment — and every line matches the replayed state byte-for-byte. A fourth `Read` at
08:16:57, after the final edit, matches lines 838–897. The file renders with no console
errors, all five views build, and the decision-record modal populates.

For the other three, the `Write` calls lived in transcript directories that were
themselves deleted. What survives are edits with no base to apply them to.

## The load-bearing finding: -dq is a hybrid descendant

The restored `-dq` file is not a sibling of the hybrid prototype — it is downstream of it.
It contains the hybrid's Chief-of-Staff command layer: `cos-dock`, `budget-pill`,
`cmdk-back`, `cCard`, `cTrace`, the `SLASH` command table, and the
`Chief of Staff command layer` comment.

Measuring the four hybrid fragments line-by-line against the restored file:

| Hybrid fragment | Content | Survives in `-dq` |
|---|---|---|
| `toolu_01WgD6X2` | CoS + command-bar CSS (5,213 B) | 47/49 lines (96%) |
| `toolu_012kmdeo` | Header: budget pill, ⌘K, CoS button | 9/9 lines (100%) |
| `toolu_01KVu468` | CoS dock + command-bar markup | 22/25 lines (88%) |
| `toolu_01As8VQ2` | CoS command-layer JS (11,859 B) | 58/109 lines (53%) |
| **Total** | | **136/192 lines (71%)** |

Direction A, by contrast: **2/8 lines**, and those two are a generic badge-return line and
a bare `}`. Its three fragments are label-polish — a `bdg()` status-label map and a
`plab()` policy-label helper — applied to a structure that is entirely gone.

## Recommendation

**Do not rebuild Direction A.** A 25% overlap that resolves to a closing brace is not
raw material. The only other source is the prose reconstruction in
`internal/audits/2026-07-24-O2-operator-experience.md` §1.2 — and that document states it
reconstructed A and B from the memory note, not from the code. Building an HTML file from
prose-about-lost-code would produce a new artifact wearing a lost file's name: maximum
confusion, zero evidential value. A was not the chosen direction, and the recommendations
it fed already live in the plan doc.

**Do not rebuild `-alt` (Direction B).** Nothing survives. Fabricating it would be invention.

**Do not rebuild `-hybrid` as a separate file either — treat `-dq` as the surviving carrier
of the chosen direction.** The hybrid's whole point was the CoS command layer grafted onto
a structured console, and that layer is already in the repo inside `-dq`. Reconstructing a
standalone `-hybrid` would mean stripping the decision-quality pass back out of `-dq` and
guessing at the pre-DQ base — inventing the differences while claiming to recover them.

The 29% of the hybrid that `-dq` dropped is worth keeping, though, and it is preserved
verbatim in the appendix below: the `/delegate`, `/approve`, `/widen autonomy`, `/spend`
and `/status` slash-command implementations. These demonstrate the CoS interaction model —
earned-not-granted autonomy widening, staged approvals with reversibility, every action
mapping to a governed operation. If that model is rebuilt, build it forward from the
appendix against the current console, and label it new work.

**Any prototype produced from these fragments is a reconstruction, not an original, and
must say so in the file and in its commit message.** Only `console-prototype-dq.html` is a
faithful restoration, and only because its original bytes survived.

---

# Appendix — surviving fragments, verbatim

Preserved here because transcripts are exactly the fragile store that already lost three of
these four files. Each `old_string` is text that provably existed in the lost file; each
`new_string` is what replaced it. These are diffs, not files — they do not compose into a
runnable prototype.

### console-prototype.html — Direction A


#### Fragment 1 — `toolu_01Gecf4hcieYu4Ye5qMBKUA9` · 2026-06-01T22:24:23.455Z

Anchor (`old_string`, 390 bytes) — this text existed in the lost file:

```html
function bdg(s){
  var m={queued:'neutral',draft:'neutral',idle:'neutral',running:'info',in_progress:'info',approval_required:'pending',suspended_approval:'pending',pending:'pending',completed:'success',done:'success',ratified:'success',blocked:'danger',failed:'danger',rejected:'danger'};
  return '<span class="badge badge-'+(m[s]||'neutral')+'"><span class="bdot"></span>'+s+'</span>';
}
```

Replacement (`new_string`, 819 bytes):

```html
function bdg(s){
  var m={queued:'neutral',draft:'neutral',idle:'neutral',running:'info',in_progress:'info',approval_required:'pending',suspended_approval:'pending',pending:'pending',completed:'success',done:'success',ratified:'success',blocked:'danger',failed:'danger',rejected:'danger'};
  var L={queued:'Queued',draft:'Draft',idle:'Idle',running:'Running',in_progress:'In progress',approval_required:'Waiting on you',suspended_approval:'Waiting on you',pending:'Pending',completed:'Done',done:'Done',ratified:'Ratified',blocked:'Blocked',failed:'Failed',rejected:'Rejected'};
  return '<span class="badge badge-'+(m[s]||'neutral')+'"><span class="bdot"></span>'+(L[s]||s)+'</span>';
}
function plab(p){return p==='allow'?'Allowed':p==='require_approval'?'Needs approval':p==='ask'?'Ask first':p==='deny'?'Blocked':p}
```


#### Fragment 2 — `toolu_01ARX5W2RxBeRoT6u4mdjZMf` · 2026-06-01T22:24:33.760Z

Anchor (`old_string`, 140 bytes) — this text existed in the lost file:

```html
var cl=p==='allow'?'p-allow':'p-ask';return '<div class="cap-row"><div class="cap-name">'+tl+'</div><span class="'+cl+'">'+p+'</span></div>'
```

Replacement (`new_string`, 146 bytes):

```html
var cl=p==='allow'?'p-allow':'p-ask';return '<div class="cap-row"><div class="cap-name">'+tl+'</div><span class="'+cl+'">'+plab(p)+'</span></div>'
```


#### Fragment 3 — `toolu_01QrLAp44EoVCurszmSanVyW` · 2026-06-01T22:24:38.890Z

Anchor (`old_string`, 154 bytes) — this text existed in the lost file:

```html
return '<div class="cap-row"><div><div class="cap-name">'+r[0]+'</div><div class="cap-sub">'+r[1]+'</div></div><span class="'+cl+'">'+r[2]+'</span></div>'
```

Replacement (`new_string`, 160 bytes):

```html
return '<div class="cap-row"><div><div class="cap-name">'+r[0]+'</div><div class="cap-sub">'+r[1]+'</div></div><span class="'+cl+'">'+plab(r[2])+'</span></div>'
```


### console-prototype-hybrid.html — Hybrid (chosen direction)


#### Fragment 1 — `toolu_01WgD6X23HvKnqvRR2yPsS52` · 2026-06-02T10:17:49.946Z

Anchor (`old_string`, 8 bytes) — this text existed in the lost file:

```html
</style>
```

Replacement (`new_string`, 5213 bytes):

```html
/* ── Chief of Staff command layer (hybrid) ─────────────────────── */
.budget-pill{display:inline-flex;align-items:center;gap:8px;height:24px;padding:0 10px;border-radius:var(--r-pill);border:1px solid var(--line);background:var(--surface-1);font-family:var(--font-mono);font-size:11px;color:var(--fg-2);white-space:nowrap}
.budget-pill .bp-bar{width:44px;height:5px;border-radius:9px;background:var(--surface-3);overflow:hidden}
.budget-pill .bp-fill{display:block;height:100%;width:0;background:var(--accent);border-radius:9px;transition:width .5s var(--ease,ease)}
#cos-btn{gap:7px}#cos-btn.on{border-color:var(--accent);color:var(--accent)}
.cmdk-btn{font-family:var(--font-mono)}
.cos-dock{position:fixed;top:0;right:0;height:100vh;width:424px;max-width:94vw;background:var(--bg);border-left:1px solid var(--line);box-shadow:var(--shadow-lg);display:flex;flex-direction:column;transform:translateX(101%);transition:transform .26s cubic-bezier(.4,0,.1,1);z-index:60}
.cos-dock.open{transform:translateX(0)}
.cos-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:13px 14px;border-bottom:1px solid var(--line)}
.cos-id{display:flex;align-items:center;gap:10px}
.cos-mark{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:8px;background:var(--accent);color:#fff;font-family:var(--font-mono);font-size:10.5px;font-weight:600;flex:none}
.cos-name{font-size:13px;font-weight:600}.cos-sub{font-family:var(--font-mono);font-size:10px;color:var(--fg-3)}
.cos-body{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px}
#cos-dock .cmsg{font-size:13px;line-height:1.5;max-width:92%}
#cos-dock .cmsg.user{align-self:flex-end;background:var(--accent);color:#fff;padding:8px 12px;border-radius:12px 12px 3px 12px}
#cos-dock .cmsg.cos{align-self:flex-start}
#cos-dock .cmsg.cos .ctext{background:var(--surface-1);border:1px solid var(--line);padding:9px 12px;border-radius:12px 12px 12px 3px}
#cos-dock .cmsg.card{align-self:stretch;max-width:100%}
#cos-dock .acard{border:1px solid var(--line);border-radius:var(--r-md);overflow:hidden;background:var(--bg)}
#cos-dock .acard-hd{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 12px;background:var(--surface-1);border-bottom:1px solid var(--line)}
#cos-dock .acard-kick{font-family:var(--font-mono);font-size:9.5px;letter-spacing:.09em;text-transform:uppercase;color:var(--fg-3)}
#cos-dock .acard-title{font-size:13px;font-weight:600;padding:9px 12px 3px}
#cos-dock .acard-rows{padding:2px 12px 10px;display:flex;flex-direction:column;gap:5px}
#cos-dock .acard-row{display:flex;gap:10px;font-size:12px;align-items:baseline}
#cos-dock .acard-row .ak{font-family:var(--font-mono);font-size:11px;color:var(--fg-3);width:74px;flex:none}
#cos-dock .acard-row .av{color:var(--fg-1);min-width:0}
#cos-dock .acard-foot{display:flex;align-items:center;gap:7px;padding:0 12px 11px;flex-wrap:wrap}
#cos-dock .trace{font-family:var(--font-mono);font-size:10px;color:var(--terminal-muted);background:var(--terminal-bg);padding:6px 12px}
#cos-dock .trace .tprompt{color:var(--accent)}#cos-dock .trace .top{color:var(--terminal-fg)}
.cos-foot{border-top:1px solid var(--line);padding:11px 14px}
#cos-dock .slashrow{display:flex;gap:6px;overflow-x:auto;padding-bottom:9px;scrollbar-width:thin}
#cos-dock .chip{flex:none;height:26px;padding:0 10px;border:1px solid var(--line);border-radius:var(--r-pill);background:var(--surface-1);color:var(--fg-2);font-family:var(--font-mono);font-size:11px;cursor:pointer;white-space:nowrap}
#cos-dock .chip:hover{border-color:var(--accent);color:var(--accent)}
.cos-inputrow{display:flex;gap:7px;align-items:center}
.cos-input{flex:1;height:38px;padding:0 12px;border:1px solid var(--line);border-radius:var(--r);background:var(--surface-1);color:var(--fg-1);font-family:var(--font-sans);font-size:13px}
.cos-input:focus{outline:none;border-color:var(--accent);background:var(--bg)}
.cos-hint{font-family:var(--font-mono);font-size:9.5px;color:var(--fg-3);margin-top:7px;text-align:center}
.cmdk-back{position:fixed;inset:0;background:rgba(8,16,14,.42);z-index:120;display:none;align-items:flex-start;justify-content:center;padding:86px 16px}
.cmdk-back.open{display:flex}
.cmdk{width:100%;max-width:560px;background:var(--bg);border:1px solid var(--line);border-radius:var(--r-lg);box-shadow:var(--shadow-lg);overflow:hidden}
.cmdk-input{width:100%;height:52px;padding:0 18px;border:none;border-bottom:1px solid var(--line);background:transparent;color:var(--fg-1);font-family:var(--font-sans);font-size:15px}
.cmdk-input:focus{outline:none}
.cmdk-list{max-height:328px;overflow-y:auto;padding:6px}
.cmdk-item{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:var(--r);font-size:13.5px;color:var(--fg-1);cursor:pointer}
.cmdk-item .ci-op{font-family:var(--font-mono);font-size:10px;color:var(--fg-3);margin-left:auto}
.cmdk-item.sel{background:var(--accent-weak)}.cmdk-item.sel .ci-op{color:var(--accent)}
.cmdk-hint{font-family:var(--font-mono);font-size:10px;color:var(--fg-3);padding:8px 14px;border-top:1px solid var(--line)}
@media(max-width:720px){.cos-dock{width:100vw}}
</style>
```


#### Fragment 2 — `toolu_012kmdeocaVscmKhHRKmMY6b` · 2026-06-02T10:18:02.404Z

Anchor (`old_string`, 271 bytes) — this text existed in the lost file:

```html
  <div class="con-org">
    <span class="orgname">Northwind</span>
    <span class="apill" data-level="supervised" id="hdr-level">supervised</span>
  </div>
  <div class="con-toolbar">
    <button class="btn btn-primary btn-sm" onclick="openNewTask()">+ New Task</button>
```

Replacement (`new_string`, 724 bytes):

```html
  <div class="con-org">
    <span class="orgname">Northwind</span>
    <span class="apill" data-level="supervised" id="hdr-level">supervised</span>
    <span class="budget-pill" id="budget-pill" title="Monthly budget"><span class="bp-bar"><span class="bp-fill" id="bp-fill"></span></span><span id="bp-text">$1,240 / $2,000</span></span>
  </div>
  <div class="con-toolbar">
    <button class="btn btn-sm btn-ghost cmdk-btn" onclick="openCmdk()" aria-label="Command bar" title="Command bar (Cmd/Ctrl+K)">⌘K</button>
    <button class="btn btn-sm" id="cos-btn" onclick="toggleCos()" aria-label="Open Chief of Staff">Chief of Staff</button>
    <button class="btn btn-primary btn-sm" onclick="openNewTask()">+ New Task</button>
```


#### Fragment 3 — `toolu_01KVu468Tho4VPGgGAuE9Tmv` · 2026-06-02T10:18:16.507Z

Anchor (`old_string`, 8 bytes) — this text existed in the lost file:

```html
<script>
```

Replacement (`new_string`, 1582 bytes):

```html
<!-- ── Chief of Staff dock ───────────────────────────────────────── -->
<aside class="cos-dock" id="cos-dock" aria-label="Chief of Staff" aria-hidden="true">
  <div class="cos-head">
    <div class="cos-id"><span class="cos-mark">CoS</span><div><div class="cos-name">Chief of Staff</div><div class="cos-sub">runs the org for you · supervised</div></div></div>
    <button class="btn btn-icon btn-ghost" onclick="toggleCos()" aria-label="Close Chief of Staff">✕</button>
  </div>
  <div class="cos-body" id="cos-body"></div>
  <div class="cos-foot">
    <div class="slashrow" id="slashrow"></div>
    <div class="cos-inputrow">
      <input class="cos-input" id="cos-input" placeholder="Ask the Chief of Staff to do anything…" aria-label="Message the Chief of Staff" autocomplete="off" />
      <button class="btn btn-primary btn-icon" id="cos-send" onclick="cosSend()" aria-label="Send">→</button>
    </div>
    <div class="cos-hint">Enter to send · every action maps to a governed operation</div>
  </div>
</aside>

<!-- ── Command bar (Cmd/Ctrl+K) ──────────────────────────────────── -->
<div class="cmdk-back" id="cmdk-back" onclick="if(event.target===this)closeCmdk()" aria-hidden="true">
  <div class="cmdk" role="dialog" aria-label="Command bar">
    <input class="cmdk-input" id="cmdk-input" oninput="renderCmdk(this.value)" placeholder="Type a command…  (delegate, approve, widen autonomy, go to tasks…)" autocomplete="off" />
    <div class="cmdk-list" id="cmdk-list"></div>
    <div class="cmdk-hint">↑↓ navigate · Enter run · Esc close</div>
  </div>
</div>

<script>
```


#### Fragment 4 — `toolu_01As8VQ2Q3pQkEg9kt41eSks` · 2026-06-02T10:19:25.627Z

Anchor (`old_string`, 9 bytes) — this text existed in the lost file:

```html
</script>
```

Replacement (`new_string`, 11859 bytes):

```html

/* ══ Chief of Staff command layer (hybrid graft) ════════════════ */
function cEsc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function cTrace(op,arg){return '<div class="trace"><span class="tprompt">&gt;</span> <span class="top">'+cEsc(op)+'</span>'+(arg?' '+cEsc(arg):'')+'</div>'}
function cCard(o){o=o||{};
  var rows=(o.rows||[]).map(function(r){return '<div class="acard-row"><span class="ak">'+cEsc(r[0])+'</span><span class="av">'+r[1]+'</span></div>'}).join('');
  var traces=(o.traces||[]).map(function(t){return cTrace(t[0],t[1])}).join('');
  return '<div class="acard"><div class="acard-hd"><span class="acard-kick">'+cEsc(o.kicker||'Action')+'</span>'+(o.badge||'')+'</div>'
    +(o.title?'<div class="acard-title">'+cEsc(o.title)+'</div>':'')
    +(rows?'<div class="acard-rows">'+rows+'</div>':'')
    +(o.foot?'<div class="acard-foot">'+o.foot+'</div>':'')+traces+'</div>';}
function cScroll(){var b=$id('cos-body');if(b)b.scrollTop=b.scrollHeight}
function cosMsg(t){$id('cos-body').insertAdjacentHTML('beforeend','<div class="cmsg user">'+cEsc(t)+'</div>');cScroll()}
function cosSay(html){$id('cos-body').insertAdjacentHTML('beforeend','<div class="cmsg cos"><div class="ctext">'+html+'</div></div>');cScroll()}
function cosCard(html){$id('cos-body').insertAdjacentHTML('beforeend','<div class="cmsg cos card">'+html+'</div>');cScroll()}
function refreshCur(){if(['home','tasks','projects','governance','agents','activity'].indexOf(cur)>=0)nav(cur)}
function okBadge(t){return '<span class="badge badge-success"><span class="bdot"></span>'+t+'</span>'}

var SLASH=[{cmd:'/delegate',fn:iDelegate},{cmd:'/approve',fn:iApprove},{cmd:'/widen autonomy',fn:iWiden},{cmd:'/spend',fn:iSpend},{cmd:'/status',fn:iStatus}];
function renderSlash(){$id('slashrow').innerHTML=SLASH.map(function(s,i){return '<button class="chip" onclick="SLASH['+i+'].fn()">'+s.cmd+'</button>'}).join('')}

function toggleCos(){var d=$id('cos-dock');var open=d.classList.toggle('open');d.setAttribute('aria-hidden',String(!open));$id('cos-btn').classList.toggle('on',open);if(open)setTimeout(function(){$id('cos-input').focus()},140)}
function openCos(){var d=$id('cos-dock');if(!d.classList.contains('open')){d.classList.add('open');d.setAttribute('aria-hidden','false');$id('cos-btn').classList.add('on')}}
function matchIntent(t){t=(t||'').toLowerCase();
  if(/(approve|sign ?off|send it|go ahead|ship it)/.test(t))return iApprove;
  if(/(widen|autonomy|more autonomy|trust|bounded|take on more|promote)/.test(t))return iWiden;
  if(/(spend|budget|cost|money|burn)/.test(t))return iSpend;
  if(/(status|what needs|triage|waiting|overview|what.s up)/.test(t))return iStatus;
  if(/(delegate|email|draft|create|send|task|outreach|enrich|write|launch|do )/.test(t))return iDelegate;
  return iFallback;}
function cosSend(){var el=$id('cos-input');var t=el.value.trim();if(!t)return;cosMsg(t);el.value='';matchIntent(t)(t)}

function iDelegate(){
  cosSay('On it — I created the task and briefed <b>Ava</b> (Outreach). The list is already enriched and QA-checked. Because it is more than 100 recipients, our outbound policy means it needs your sign-off before anything sends; I have staged it below.');
  if(!D.tasks.some(function(x){return x.id==='t8'})){
    D.tasks.push({id:'t8',title:'Email 200 enriched contacts about the Q3 webinar',proj:'Q3 Lighthouse Launch',agent:'Ava',risk:'medium',status:'approval_required',recurring:null});
    D.approvals.push({id:'a3',title:'Send ~120 emails to the enriched contacts',agent:'Ava',task:'Email 200 enriched contacts about the Q3 webinar',risk:'medium',age:'just now',policy:'Outbound > 100 recipients requires approval',what:'Send ~120 personalized emails via Instantly to the enriched Q3 webinar list.',rev:'Staged — nothing sends until you approve. Cancel stops all sends.',track:'7 approved, 0 rejected',evidence:['Ava has completed 7 outreach tasks with 0 rejections','List QA-checked by Sentinel before handoff','Subject line matches the top-performing case-study-led pattern']});
  }
  cosCard(cCard({kicker:'Task created',badge:bdg('approval_required'),title:'Email 200 enriched contacts about the Q3 webinar',rows:[['Assigned','✉ Ava&nbsp; '+ap('supervised')],['Risk',rtag('medium')],['Success','Personalized to each contact, QA-checked by Sentinel, projected open-rate &gt;25%']],foot:'<button class="btn btn-sm" onclick="nav(\'tasks\')">Open in Tasks</button>',traces:[['work.create','--agent Ava --risk medium']]}));
  cosCard(cCard({kicker:'Approval needed',badge:bdg('approval_required'),title:'Send ~120 emails to the enriched contacts',rows:[['Policy','Outbound &gt; 100 recipients requires approval'],['Reversible','Staged — nothing sends until you approve']],foot:'<button class="btn btn-primary btn-sm" onclick="iApprove()">Approve</button> <button class="btn btn-sm" onclick="nav(\'governance\')">Review</button>',traces:[['approval.request','--policy outbound>100']]}));
  refreshCur();
}
function iApprove(){
  var a=D.approvals[0];
  if(!a){cosSay('Nothing is waiting on your approval right now — you are all caught up.');return}
  D.approvals=D.approvals.filter(function(x){return x.id!==a.id});
  var tk=D.tasks.filter(function(x){return x.title===a.task})[0];if(tk)tk.status='in_progress';
  cosSay('Approved — <b>'+cEsc(a.agent)+'</b> is resuming now. '+cEsc(a.rev));
  cosCard(cCard({kicker:'Approved',badge:okBadge('Approved'),title:a.title,rows:[['Approved by','You'],['Result','Send resumed — agent is executing']],traces:[['approval.approve','--id '+a.id]]}));
  refreshCur();
}
function iWiden(){
  cosSay('Yes — and it would be <b>earned, not granted</b>. Ava has run 12 tasks with zero rejections and a 100% success rate. I can widen her to <b>Bounded</b> so she handles low- and medium-risk work without stopping for approval. High-risk stays gated, and you can reverse it at any time.');
  var ev=D.evidence.map(function(e){return '<div style="display:flex;gap:8px;font-size:12px;padding:2px 0"><span style="color:var(--state-success-fg)">'+I.check+'</span><span>'+cEsc(e.t)+'</span></div>'}).join('');
  cosCard(cCard({kicker:'Autonomy · earned',title:'Ava qualifies for Bounded',rows:[['Current',ap('supervised')+' &rarr; '+ap('bounded')],['Stays gated','High-risk actions still route to you'],['Reversible','Recorded in the audit trail; roll back anytime'],['Evidence','<div style="margin-top:2px">'+ev+'</div>']],foot:'<button class="btn btn-primary btn-sm" onclick="doWiden()">↑ Widen to Bounded</button> <button class="btn btn-sm" onclick="nav(\'governance\')">View full evidence</button>',traces:[['org.autonomy.widen','--agent ava --to bounded --reversible']]}));
}
function doWiden(){
  var a=D.agents.filter(function(x){return x.name==='Ava'})[0];if(a)a.level='bounded';
  cosSay('Done — Ava is now at <b>Bounded</b>. I logged the change to the audit trail; say "narrow Ava" to roll it back.');
  flash('Ava widened to bounded — reversible, logged');refreshCur();
}
function iSpend(){
  cosSay('This month you have spent <b>$1,240 of $2,000</b> (62%). Here is the per-agent breakdown — Scout (data enrichment) is the largest line.');
  cosCard(cCard({kicker:'Budget · this month',title:'$1,240 / $2,000 — 62% used',rows:[['Scout','$382 / mo'],['Iris','$301 / mo'],['Sentinel','$247 / mo'],['Ava','$214 / mo'],['Ledger','$96 / mo']],foot:'<button class="btn btn-sm" onclick="nav(\'governance\')">Open governance</button>',traces:[['budget.report','--window month']]}));
}
function iStatus(){
  var w=D.approvals.length,bl=D.tasks.filter(function(t){return t.status==='blocked'}).length,rt=D.knowledge.filter(function(k){return k.status==='ratify_queue'}).length;
  cosSay('Here is where things stand. <b>'+w+'</b> approval'+(w===1?'':'s')+' waiting on you, <b>'+bl+'</b> blocked task'+(bl===1?'':'s')+', and <b>'+rt+'</b> new learning'+(rt===1?'':'s')+' ready to ratify.');
  cosCard(cCard({kicker:'Triage · what needs you',rows:[['Approvals',w+' waiting'],['Blocked',bl+' task'+(bl===1?'':'s')],['Ratify',rt+' learnings']],foot:'<button class="btn btn-sm" onclick="nav(\'home\')">Open triage</button> <button class="btn btn-sm" onclick="nav(\'governance\')">Approvals</button>',traces:[['approval.list',''],['memory.search','--status ratify_queue']]}));
}
function iFallback(){cosSay('I can run anything in the console for you. Try: <b>delegate</b> a task, <b>approve</b> what is waiting, <b>widen autonomy</b>, or ask for <b>spend</b> or <b>status</b>. You can also press <b>⌘K</b> for the command bar.');}

/* ── Command bar (Cmd/Ctrl+K) ──────────────────────────────────── */
var CMDS=[
  {l:'Open Chief of Staff',op:'cos.open',run:openCos},
  {l:'Delegate a task (ask CoS)',op:'work.create',run:function(){openCos();iDelegate()}},
  {l:'Approve the pending action',op:'approval.approve',run:function(){openCos();iApprove()}},
  {l:'Review autonomy / widen',op:'org.autonomy',run:function(){openCos();iWiden()}},
  {l:'Show spend & budget',op:'budget.report',run:function(){openCos();iSpend()}},
  {l:'What needs me? (triage)',op:'approval.list',run:function(){openCos();iStatus()}},
  {l:'New task…',op:'work.create',run:function(){openNewTask()}},
  {l:'Go to Home',op:'nav home',run:function(){nav('home')}},
  {l:'Go to Tasks',op:'nav tasks',run:function(){nav('tasks')}},
  {l:'Go to Projects',op:'nav projects',run:function(){nav('projects')}},
  {l:'Go to Agents',op:'nav agents',run:function(){nav('agents')}},
  {l:'Go to Governance',op:'nav governance',run:function(){nav('governance')}},
  {l:'Go to Knowledge',op:'nav knowledge',run:function(){nav('knowledge')}},
  {l:'Go to Activity',op:'nav activity',run:function(){nav('activity')}},
  {l:'Toggle theme',op:'ui.theme',run:toggleTheme},
];
var cmdkF=[],cmdkSel=0;
function openCmdk(){$id('cmdk-back').classList.add('open');var i=$id('cmdk-input');i.value='';renderCmdk('');setTimeout(function(){i.focus()},40)}
function closeCmdk(){$id('cmdk-back').classList.remove('open')}
function renderCmdk(q){q=(q||'').toLowerCase();
  cmdkF=CMDS.filter(function(c){return c.l.toLowerCase().indexOf(q)>=0||c.op.indexOf(q)>=0});cmdkSel=0;
  $id('cmdk-list').innerHTML=cmdkF.length?cmdkF.map(function(c,i){return '<div class="cmdk-item'+(i===0?' sel':'')+'" onclick="runCmd('+i+')"><span>'+cEsc(c.l)+'</span><span class="ci-op">&gt; '+cEsc(c.op)+'</span></div>'}).join(''):'<div class="cmdk-item" style="color:var(--fg-3);cursor:default">No matching command</div>';}
function moveCmdk(d){if(!cmdkF.length)return;cmdkSel=(cmdkSel+d+cmdkF.length)%cmdkF.length;var ch=$id('cmdk-list').children;for(var i=0;i<ch.length;i++)ch[i].classList.toggle('sel',i===cmdkSel);if(ch[cmdkSel])ch[cmdkSel].scrollIntoView({block:'nearest'})}
function runCmd(i){var c=cmdkF[i];if(!c)return;closeCmdk();c.run()}

document.addEventListener('keydown',function(e){
  if((e.metaKey||e.ctrlKey)&&(e.key==='k'||e.key==='K')){e.preventDefault();$id('cmdk-back').classList.contains('open')?closeCmdk():openCmdk();return}
  if($id('cmdk-back').classList.contains('open')){
    if(e.key==='Escape')closeCmdk();
    else if(e.key==='ArrowDown'){e.preventDefault();moveCmdk(1)}
    else if(e.key==='ArrowUp'){e.preventDefault();moveCmdk(-1)}
    else if(e.key==='Enter'){e.preventDefault();runCmd(cmdkSel)}
    return;}
  if(e.key==='Escape'&&$id('cos-dock').classList.contains('open'))toggleCos();
});

/* ── CoS init ──────────────────────────────────────────────────── */
renderSlash();
$id('cos-input').addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();cosSend()}});
cosSay('Morning — I am your <b>Chief of Staff</b>. I run Northwind for you. Tell me what to do, or pick a command below. A few things need you; ask <b>what needs me</b> and I will triage.');
setTimeout(function(){var f=$id('bp-fill');if(f)f.style.width='62%'},80);
</script>
```
