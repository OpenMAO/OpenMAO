# HANDOFF — Signed Authority

**Status:** `handed-back: executor_dispatch_blocked`
**At:** tick 1 of 24, milestone M1 attempt 1 of 3
**Head:** `89e355c` (goal init) — no product code was written; the tree is exactly as initialised.

## What stopped the loop

The K3 executor could not be dispatched. Every invocation carrying the real M1 brief was refused by
the Claude Code auto-mode permission classifier:

> Permission for this action was denied by the Claude Code auto mode classifier. Reason: Blocked by classifier.

The executor bisected this rather than guessing, and the result is a clean controlled comparison:
the **same** wrapper, cwd, reasoning effort and Node PATH were **allowed** with a trivial prompt and
**blocked** with the M1 brief. So the trigger is prompt *content*, not command shape. The brief is
thick with private-key-custody and signature-forgery language — "must never return a private key",
"PKCS8 private-key shapes", "signature malleability", "key substitution", "scrub perimeter" — which
out of context resembles credential-handling tooling, even though the work is defensive and the
broker's whole purpose is that keys *cannot* escape.

**Neither the executor nor the loop attempted to reword the brief to get past the classifier.**
That would be routing around a denial rather than resolving it. This is recorded as failure
signature **SIG-001** in `PROGRESS.md`, which blocks re-attempting the same approach on resume.

## State — nothing to clean up

- No product files created or modified. `ts/src/security/signing.ts` and `signing-broker.ts` are
  still absent; no `sign*` test files exist.
- Working tree carries only this loop's own `.goal/` bookkeeping. No stash was needed — there was no
  partial work to preserve.
- Baseline independently re-verified by the executor under Node 25: **39 files / 329 tests green**,
  matching `baseline.json`. The `> 329` acceptance threshold remains correct.

## What the operator must decide

1. **A Bash permission rule for the K3 wrapper** — `/Users/bilalsyed/.codex/dual-router/k3-codex`
   (and `k3-claude` if the unsandboxed harness should be available). Without this the loop cannot
   execute anything, and would burn all 24 ticks failing identically.

2. **Harness choice**, worth settling at the same time. `k3-codex` sandboxes writes to
   `[workdir, /tmp, $TMPDIR]`, but this worktree's `node_modules` is a symlink to the main
   checkout — outside that boundary. Reads work and the baseline suite ran clean, so lint/typecheck/
   vitest probably don't write there, but if vitest tries to populate `node_modules/.vite` the run
   fails on a sandbox write. `k3-claude` is unsandboxed and picks up the repo's `AGENTS.md`.

3. **Long-running dispatch.** M1 is three modules, two test suites, 17 negative vectors, plus
   `make check` iteration. It may exceed the 600s foreground Bash ceiling and need backgrounding
   with polling — worth permitting explicitly rather than discovering mid-run.

## Resuming

Re-arm the cron routine (it was deleted on hand-back) after granting the permission rule. A fresh
session reconstitutes from `.goal/` and will resume at M1 attempt 2 — and will read SIG-001 first,
so it will not retry the blocked approach.

Nothing else about the plan changed. The design, scope guards, and done-criteria all stand.
