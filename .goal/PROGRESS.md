# PROGRESS — Signed Authority

Milestone log. Appended by the loop each tick. A resuming session reads this to know what has
actually been accepted versus attempted.

| Milestone | Status | Accepted at | Notes |
|---|---|---|---|
| M1 Crypto core | not started | — | — |
| M2 Identity storage | not started | — | — |
| M3 Custody + bootstrap | not started | — | — |
| M3a Console extraction | not started | — | — |
| M4 Atomic cutover | not started | — | — |
| M5 Signed decisions | not started | — | — |
| M6 Chain attestations | not started | — | — |
| M7 Docs + evidence | not started | — | — |

## Failure signatures

None yet. (Signature = milestone + approach + failing check. A repeated signature blocks retrying the
same approach — replan instead.)

## Notes for the operator

- Loop machinery lives in `.goal/` and is committed on this branch by design; it is not product code.
- The loop may not merge, may not touch external contributors' PRs/issues, and may not modify CI.
