# Contributing guide — nexus-exchange-mcp

The Model Context Protocol server exposing the Nexus Exchange API as agent tools.

## Merging

- Don't merge a PR without an approving review — CI passing isn't a substitute.
- Don't merge a PR you didn't author without an approving review **and** the
  author's sign-off. Check the author first
  (`gh pr view <n> --json author,reviewDecision`).
- Re-approval isn't needed for follow-up commits to an already-approved PR.

## Pull requests

- One concern per PR; link its tracking issue (`ENG-XXXX`) in the title.
- Respond to review comments before merging.

## Checks (before pushing)

- The repo's lint, typecheck, and test scripts all pass — CI enforces these.

## API contract

- The network → host map lives in exactly one file, `src/networks.ts`, copied
  from the spec's `x-nexus-networks`. Never interpolate a host from a network
  name (mainnet is `api.nexus.xyz`, not `api.mainnet.nexus.xyz`), and never let
  an unrecognized network fall back to a default — it is treated as real funds.
- **No hostname for a private stage belongs in this repo** — not in source, docs,
  tests, commit messages or PR bodies, and neither does the stage taxonomy that
  names them. Point `custom` at them instead (ENG-9823). Illustrate with RFC 2606
  reserved names (`example.com` in docs, `example.invalid` in tests) and generic
  labels (`dev`, `example`).
- `custom` is client-side only: it is not a value the API accepts and must never
  appear in `x-nexus-networks`, so it is deliberately not in `NETWORK_IDS` or
  `NETWORKS`. Its funds are a tri-state (`real | play | unknown`) that a caller
  declares; match `play` positively in a guard, never `!== "real"`, or `unknown`
  falls through as if it were safe. A tool that cannot be undone declares
  `fundsGuard` and is refused on an undeclared target.
- Keep the pinned `nexus-exchange-api` version in sync when the spec bumps.
  `spec-autobump` opens that PR for you and labels it breaking or not; merging it
  is a human decision, and `spec-drift` on that PR is the check that says whether
  it needs code changes.
- New API capabilities should be surfaced as MCP tools so an agent can use them.
- Every tool declares the spec operations it calls in its `ops` field — required
  by the type, verified against the handler by `scripts/check_spec_drift.py`, and
  the source `endpoints.txt` is generated from. Run `npm run spec:drift` after
  touching a tool, and `npm run spec:drift:write` if the operation set moved.
- Coverage is reported in two units and they are not interchangeable: registered
  tools (MCP's own axis) and spec operations (comparable with the other SDKs).
  Never report the tool count as a coverage figure. See `docs/coverage-unit.md`.
