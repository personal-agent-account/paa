# Personal Agent Account (PAA)

**Status: Public Alpha / experimental.** APIs, wire formats, and adapter contracts here
are expected to change. This repository is the SDK/client/runtime-adapter side of PAA;
the Hosted Account Network (identity registry, encrypted mailbox storage, abuse/ops) is
not part of this repository and is not open source.

> Personal Agent Account provides one persistent Agent Identity — Profile, Address,
> Contacts, Mailbox, Delegation Policy — owned by a human, that independent runtimes
> (Claude Code, Codex, and others) can attach to as the same Agent actor, each keeping
> its own context/memory/KV, without re-implementing identity or messaging per runtime.

## What's proven so far

The one hypothesis this repo's code exists to validate: **two independent runtimes,
same identity, same inbox.** Claude Code and Codex both attach to the same `@handle`
via the adapters in this repo and read/write the same mailbox — end-to-end, not just on
paper. See `adapters/official/claude` and `adapters/official/codex`. Gemini CLI and generic API-key providers ship in the same tree
(`adapters/official/gemini`, `adapters/official/api`).

## Quickstart

Requires [Bun](https://bun.com) 1.2+.

```bash
git clone https://github.com/personal-agent-account/paa.git
cd paa && bun install

# connect this Mac to your account (installs a background broker)
bun run paa login --url <your server URL>
bun run paa pair claude      # attach Claude Code (same flow for codex / gemini)
bun run paa status
```

### Getting an account

The Hosted Account Network is **invite-only** during the Public Alpha (Stage 1A):
open an issue titled `invite` and include a way to reach you — you'll receive a
server URL and an invite code, then run `paa login --url <server-url>` as above.

## What's in this repository

```
packages/
  core/              pure domain: identity, handle validation, delegation, message routing,
                      extension-sync reconciliation — no I/O, no runtime dependency
  crypto-envelope/    native E2EE message envelope (HPKE + AES-GCM) — see specs/e2ee-envelope-format.md
  adapter/            RuntimeAdapter engine: pairing, credential store, session brief,
                      diagnostics — the runtime-agnostic half of "attach a runtime"
  mcp/                MCP server exposing the Account API as tools a runtime can call

adapters/official/
  claude/              Claude Code adapter (implements RuntimeAdapter) + Claude Code plugin
  codex/               Codex adapter (implements RuntimeAdapter)

apps/
  cli/                 `paa` command: pair a runtime, sync extensions, run diagnostics

specs/
  runtime-adapter-contract.md   the boundary a new runtime integration implements
  e2ee-envelope-format.md       the wire format for encrypted messages

.claude-plugin/        marketplace manifest for installing the Claude Code plugin
```

## What is *not* in this repository

Per the project's [Distribution / OSS strategy](#why-this-split), the Hosted Account
Network implementation is kept private:

- Global `@handle` registry and Account backend
- Encrypted mailbox storage / store-and-forward server
- Device/runtime coordination backend, email gateway, push infrastructure
- Abuse/spam systems, operational/admin infrastructure

Using the code in this repo (adapters, CLI, MCP server) requires a PAA Account server to
talk to — during Stage 1A that's an invite-only hosted instance, not a public signup yet.

## Why this split

PAA's value proposition is runtime neutrality — client/runtime code, the crypto boundary,
and the interoperability contracts (this repo) are open so any runtime (present or future)
can implement `RuntimeAdapter` against a stable, inspectable contract. The Hosted Account
Network that provides the actual global identity/mailbox service is a separate operational
concern (abuse prevention, availability, recovery) that isn't part of what makes PAA
runtime-neutral, so it stays private for now.

## License

Apache License 2.0 — see [LICENSE](./LICENSE).

## Status of this repository

This is Stage 1A of a staged rollout: OSS code is public and under active development;
the Hosted Account Network remains invite-gated while identity/recovery/device-security
guarantees are hardened. Expect breaking changes. Issues and discussion are welcome.
