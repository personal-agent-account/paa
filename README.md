# Personal Agent Account (PAA)

**Status: Public Alpha / experimental.** APIs, wire formats, and adapter contracts here
are expected to change. This repository is the SDK/client/runtime-adapter side of PAA;
the Hosted Account Network (identity registry, encrypted mailbox storage, abuse/ops) is
not part of this repository and is not open source.

## All your notifications. One chat. An AI that handles them.

![All your notifications in one chat — the AI triages them first, you say "handle this", your agent finishes the job, and the runtime switches mid-task without changing the agent](docs/hero.gif)

Mail, webhooks, and phone notifications land in one timeline. The AI triages them first —
say “handle this” and your own agent finishes the job. Private items stay sealed before
any cloud AI sees them. And because the agent is an account, not a process, the same
@handle, inbox, contacts, and permissions survive a runtime switch — watch it happen
live at the hosted demo: **[https://paa.shibubu.ai](https://paa.shibubu.ai)**

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

No JavaScript runtime, no Rust toolchain, no repo clone required — the CLI and the background
broker it installs are both prebuilt binaries fetched from this repo's
[Releases](https://github.com/personal-agent-account/paa/releases):

```bash
# macOS (Apple Silicon) → darwin-arm64 · macOS (Intel) → darwin-x64 · Linux (x64) → linux-x64
TARGET="$(uname -s | tr A-Z a-z)-$(uname -m | sed 's/x86_64/x64/')"
curl -fsSL "https://github.com/personal-agent-account/paa/releases/latest/download/paa-$TARGET" -o paa
chmod +x paa

# connect this Mac to your account (fetches the broker binary, verifies its checksum, starts it)
./paa login --url https://paa-cloud.onrender.com
./paa pair claude      # attach Claude Code (same flow for codex / gemini)
./paa status
```

Already inside Claude Code or Codex? Install the adapter as a runtime plugin instead —
pairing (`paa login` / `paa pair` above) is still required afterward:

```bash
# Claude Code:
claude plugin marketplace add personal-agent-account/paa
# Codex:
codex plugin marketplace add personal-agent-account/paa
```

### Getting an account

Signup is open — create an account at **[https://paa.shibubu.ai](https://paa.shibubu.ai)**,
then run `paa login --url https://paa-cloud.onrender.com` as above (or point `--url` at your
own hosted instance).

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

broker/                Rust device broker: wakes the paired runtime when a message arrives
                        (background service `paa login` installs — see Quickstart)

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
talk to — during Stage 1A that's the hosted instance at **[https://paa.shibubu.ai](https://paa.shibubu.ai)**,
open to signup.

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
the Hosted Account Network is open for signup while identity/recovery/device-security
guarantees are hardened. Expect breaking changes. Issues and discussion are welcome.
