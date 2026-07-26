# PROGRESS — Signed Authority

Milestone log. Appended by the loop each tick. A resuming session reads this to know what has
actually been accepted versus attempted.

| Milestone | Status | Accepted at | Notes |
|---|---|---|---|
| M1 Crypto core | BLOCKED (attempt 1) | — | executor dispatch denied by permission classifier; no code produced |
| M2 Identity storage | not started | — | — |
| M3 Custody + bootstrap | not started | — | — |
| M3a Console extraction | not started | — | — |
| M4 Atomic cutover | not started | — | — |
| M5 Signed decisions | not started | — | — |
| M6 Chain attestations | not started | — | — |
| M7 Docs + evidence | not started | — | — |

## Failure signatures

### SIG-001 — M1 / k3-codex dispatch carrying the full crypto brief / permission-classifier denial

- **Milestone:** M1 Crypto core
- **Approach:** dispatch `k3-worker` with the verbatim M1 brief (signing module, signer broker,
  sensitive-material extension, 17 negative vectors).
- **Failing check:** not a test failure — the dispatch itself was refused:
  `Permission for this action was denied by the Claude Code auto mode classifier.`
- **Cause, established by controlled comparison (not guessed):** the executor bisected it. An
  identical command — same wrapper, same cwd, same reasoning effort, same Node PATH — was ALLOWED
  with a trivial prompt and BLOCKED with the M1 brief. The trigger is **prompt content, not command
  shape**. The brief is dense with private-key-custody and signature-forgery vocabulary
  ("must never return a private key", "PKCS8 private-key shapes", "signature malleability",
  "key substitution") which reads as credential tooling out of context, despite being defensive
  work whose entire purpose is that keys cannot escape.
- **Do NOT retry this approach.** Rewording the brief to slip past a content classifier is working
  around a denial, not resolving it. The executor correctly refused to do so; so does the loop.
- **Resolution required (operator):** a Bash permission rule permitting the K3 wrapper
  (`/Users/bilalsyed/.codex/dual-router/k3-codex`, optionally `k3-claude`) to be invoked with
  arbitrary task text. This is infrastructure the loop consumes, not infrastructure it may modify.

## Notes for the operator

- Loop machinery lives in `.goal/` and is committed on this branch by design; it is not product code.
- The loop may not merge, may not touch external contributors' PRs/issues, and may not modify CI.
