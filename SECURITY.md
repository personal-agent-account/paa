# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for a security vulnerability.

Use GitHub's private vulnerability reporting for this repository
(the "Report a vulnerability" button under the Security tab) so the report and any
discussion stay private until a fix is available.

## Scope

This repository contains the client/runtime side of PAA: the SDK, CLI, runtime adapters,
MCP integration, and the E2EE envelope implementation (`packages/crypto-envelope`).

Of particular interest:
- Anything that would let the Hosted Account Network (server side, not in this repo)
  decrypt a message envelope it shouldn't be able to.
- Anything that would let one runtime adapter act outside the permissions granted to it.
- Credential handling in `packages/adapter` (device pairing, local credential storage).

The Hosted Account Network implementation itself is a separate, private repository and is
out of scope for reports against this repo — but if a report here has implications for the
hosted service, say so and it will be routed appropriately.

## Supported versions

This project is Public Alpha / experimental (Stage 1A). There is no stable release line yet;
security fixes land on `main`.
