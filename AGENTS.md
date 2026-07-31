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

- Keep the pinned `nexus-exchange-api` version in sync when the spec bumps.
  `spec-drift` on the bump PR is the check that says whether it needs code
  changes.
- New API capabilities should be surfaced as MCP tools so an agent can use them.
- Every tool declares the spec operations it calls in its `ops` field — required
  by the type, verified against the handler by `scripts/check_spec_drift.py`, and
  the source `endpoints.txt` is generated from. Run `npm run spec:drift` after
  touching a tool, and `npm run spec:drift:write` if the operation set moved.
- Coverage is reported in two units and they are not interchangeable: registered
  tools (MCP's own axis) and spec operations (comparable with the other SDKs).
  Never report the tool count as a coverage figure. See `docs/coverage-unit.md`.
