# OpenMAO Documentation Map

This directory contains product, architecture, release, and contributor-facing documentation for
OpenMAO as the organizational substrate for AI-native work.

## Document Types

| Type | Location | Purpose |
| --- | --- | --- |
| North star | `NORTH_STAR.md` | Mission, vision, moat, autonomy dial, and drift test. |
| Public entry point | `README.md` | GitHub-facing project overview and navigation. |
| Architecture | `docs/ARCHITECTURE.md` | Current architecture, invariants, and module ownership. |
| Roadmap | `docs/ROADMAP.md` | Post-release direction and non-goals. |
| Positioning | `docs/POSITIONING.md` | Where OpenMAO fits in the wider ecosystem. |
| Changelog | `CHANGELOG.md` | Public release history. |
| Contribution guide | `CONTRIBUTING.md` | Contributor workflow and expectations. |
| Security policy | `SECURITY.md` | Vulnerability reporting and secret hygiene. |
| Governance | `GOVERNANCE.md` | Human, agent, and auditor authority. |
| Vocabulary | `docs/VOCABULARY.md` | Canonical product terms and model names. |
| First release scope | `docs/V0_SCOPE.md` | What the first release ships and what is deferred. |
| Deployment modes | `docs/DEPLOYMENT_MODES.md` | Native/local, managed cloud, and enterprise cloud modes. |
| Chain evidence | `docs/CHAIN_EVIDENCE.md` | Exporting the event log and verifying it independently of the database. |
| Examples | `docs/examples/` | Public walkthroughs for implemented local flows. |
| Release evidence | `docs/release/` | Public acceptance evidence for release candidates. |

## Writing Rules

- Prefer short, concrete records over long narrative.
- Link to exact files when decisions depend on repo content.
- Keep secrets, private data, raw logs, and local-only artifacts out of git.
- Keep internal communications, session notes, private strategy debates, and pre-public build-process
  records out of public docs.
- Use issues and pull requests for public implementation history.
