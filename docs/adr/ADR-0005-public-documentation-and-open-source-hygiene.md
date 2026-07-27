# ADR-0005: Public Documentation and Open-Source Hygiene

**Status:** Accepted  
**Date:** 2026-05-28  
**Owner:** Human Product Owner / Lead / Contracts / Integration

---

## Context

OpenMAO is intended to be open-source and shared on GitHub. The project may use documentation style inspiration from an unrelated closed-source repository, but must not copy closed-source content or leak private operational details.

The repo needs public-facing documents before implementation begins so contributors, auditors, and coding agents can orient safely.

## Decision

Adopt open-source-safe documentation patterns:

- public README with navigation and status;
- contributor guide;
- security policy;
- governance/RACI document;
- open questions register;
- agent/session protocol;
- evidence-record rules;
- approval packet and sign-off templates;
- GitHub issue and pull request templates;
- open-source hygiene guide.

Closed-source material may inspire document categories and generic process shapes only. It must not be copied, quoted, or referenced as an authority in public OpenMAO docs.

## Consequences

- OpenMAO becomes easier to share publicly on GitHub.
- Future agents get explicit boundaries for private-source inspiration.
- Contributors have a safer default workflow for issues, PRs, audits, and security reports.
- The repo now has more documentation to maintain, but the structure is clear and template-driven.

## Alternatives Considered

- Keep only `SPEC.md` and `BUILD_PLAN.md`.
  - Rejected because public GitHub contributors need onboarding, security, and contribution norms.
- Copy closed-source templates directly.
  - Rejected because OpenMAO is public and the other project is closed-source.

## Follow-Up

- [ ] Choose a public license.
- [ ] Add `LICENSE`.
- [ ] Add `.env.example` once implementation begins.
- [ ] Configure GitHub private vulnerability reporting before public launch.
