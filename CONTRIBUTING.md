# Contributing to PAA

This repository is Public Alpha / experimental (Stage 1A) — expect breaking changes
while `RuntimeAdapter` and the E2EE envelope format stabilize. Discussion before a large
change is worth more than the PR itself at this stage.

## Ways to contribute

- **Runtime adapters**: implement `RuntimeAdapter` (see `specs/runtime-adapter-contract.md`
  and the reference implementations in `adapters/official/{claude,codex}`) for a runtime
  that isn't officially supported yet. This is the highest-leverage contribution — PAA's
  value is runtime neutrality, and that only means something if more than two runtimes
  implement the contract.
- **Bug reports / spec gaps**: if `specs/*.md` doesn't match what the reference
  implementation actually does, that's a bug in the spec (or in the implementation) —
  please open an issue either way.
- **Tests**: `bun test` coverage for `packages/*` and the adapters.

## Development setup

```
bun install
bun run typecheck
bun test
```

This repository does not include a PAA Account server — the adapters, CLI, and MCP server
here need a running PAA Account backend to actually pair/sync against. During Stage 1A
that's an invite-only hosted instance; there is no self-host path documented yet.

## Boundary this repo maintains

`apps/server` / `apps/web` (the Hosted Account Network implementation) live in a separate
private repository and are intentionally not here — see the README's "Why this split"
section. PRs that add server-side/hosted-account code to this repo will be redirected, not
merged.

## Commit / PR conventions

- Keep PRs scoped to one change; explain *why*, not just *what*, in the description.
- Sign off that your contribution is your own work and you're licensing it under this
  repository's Apache-2.0 license (see [LICENSE](./LICENSE)).
