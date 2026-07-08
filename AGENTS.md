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
- New API capabilities should be surfaced as MCP tools so an agent can use them.
