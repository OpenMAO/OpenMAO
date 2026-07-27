# Security Policy

OpenMAO is early-stage and local-first. The default demo must not require external credentials.

## Reporting a Vulnerability

Report suspected vulnerabilities through GitHub private vulnerability reporting:

<https://github.com/OpenMAO/OpenMAO/security/advisories/new>

Do not disclose suspected vulnerabilities in public issues, pull requests, discussions, screenshots, or logs.

## What To Report

- Secret leakage.
- Policy or approval bypass.
- Unauthorized capability execution.
- Arbitrary shell, browser, email, payment, or network execution without an approved provider boundary.
- Direct API/console writes that bypass services, policy, or event logging.
- File writes escaping the workspace.
- Idempotency failures that can duplicate external effects.
- Cross-workspace data leakage.

## Secret Hygiene

Do not commit:

- API keys, PATs, OAuth tokens, session tokens, webhook secrets, or private keys;
- `.env` files with real values;
- private URLs or credentials;
- closed-source project content;
- customer or personal data.

Use `.env.example` for placeholders.

## Supported Versions

Security review applies to supported release candidates and maintained branches.
