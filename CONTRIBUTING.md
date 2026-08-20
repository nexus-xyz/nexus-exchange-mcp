# Contributing

Thanks for contributing to `nexus-exchange-mcp` — the MCP server that exposes
the Nexus Exchange API to AI agents. This guide covers local development and
our compatibility policy.

## Development setup

You need Node.js >= 20 (CI tests on 20 and 22) and npm.

```bash
npm install        # install dependencies
npm run build      # compile TypeScript to dist/ (tsc -p tsconfig.json)
```

Before opening a PR, run the same checks CI runs:

```bash
npm run format     # prettier --write . (or `npm run format:check` to verify)
npm run lint       # eslint .
npm run typecheck  # tsc --noEmit
npm test           # node --test over test/*.test.ts
```

The `format`, `lint`, `typecheck`, and `test` jobs in
[`.github/workflows/ci.yml`](.github/workflows/ci.yml) mirror these scripts
exactly — if they pass locally, they pass in CI. CI uses `format:check` (no
write); run `npm run format` to fix.

### Smoke check

`npm run smoke` spins the server up in-process (over the SDK's in-memory
transport), lists the tools, and calls `list_markets` against the target you
name. There is **no default target** — set `NEXUS_EXCHANGE_API_URL` to a host
that serves the Exchange API. Where `/api/v1` hangs off that host is the
deployment's gateway path, which comes from the network (ENG-6221), so a local
indexer serving at its root wants the network named alongside the URL:

```bash
NEXUS_EXCHANGE_NETWORK=local NEXUS_EXCHANGE_API_URL=http://localhost:9090 npm run smoke
# or, against the public host, where the bare-URL default shape is the right one:
NEXUS_EXCHANGE_API_URL=https://exchange.nexus.xyz npm run smoke
```

Unset, the check stops before calling anything and names the variable. Pointed
at something that is not the API — a web front-end, a proxy error page — it
reports the HTML explicitly and exits non-zero rather than counting an
unreadable body as a pass (ENG-8092). The target-resolution and payload rules
are unit-tested in [`test/smoke.test.ts`](test/smoke.test.ts), so `npm test`
covers them without network access.

It needs network access to the target and does not require a build. For an
out-of-process check that exercises the real stdio transport, see
[`examples/`](examples/) — it spawns the built server as a subprocess, so run
`npm run build` first.

## How a PR lands

Squash-and-merge is the only method enabled, and the source branch is deleted on
merge, so one PR is always exactly one commit on `main`.

**That commit's subject is your PR title**, so it has to be a
[conventional commit](https://www.conventionalcommits.org/) — `feat:`, `fix:`,
`docs:`, `chore:`, `ci:`. It is the string
[release-please](https://github.com/googleapis/release-please) parses to pick the
next version and the changelog section; a title it cannot parse contributes
nothing to the bump and files the change under "Other".

**Declare a breaking change with `!` before the colon** — `feat!:`,
`feat(tools)!: …`. A `BREAKING CHANGE:` footer also works, but only in a
**commit** body: the squash commit's body is assembled from the commit messages
on the branch and never from the PR description, so a footer written only in the
PR description is dropped at merge. `release-please-config.json` sets
`bump-minor-pre-major`, so a declared break is a minor bump and an undeclared one
ships as a patch — which for this repo means the tool-surface break described
below would land looking like a bug fix.

## Compatibility & deprecations

This server follows [semver](https://semver.org/) (version in `package.json`).
Pre-1.0 (`0.x`), a breaking change is a minor bump — but we minimize and
**batch** them.

**Two public surfaces break independently:**

- the **TypeScript API** (exported functions / types), and
- the **MCP tool surface** — tool names and their input schemas. Agents
  discover and call tools by name and argument schema, so renaming a tool,
  removing one, or tightening an input schema breaks every agent already
  calling it — usually silently, at runtime, with no compiler to catch it.
  Treat the surface in [`src/tools/index.ts`](src/tools/index.ts) (tool names,
  descriptions, and `inputSchema`) as a public contract, with the same care as
  a public function.

### Prefer changes that don't break agents

- **Additive tools are safe.** Adding a new tool never breaks an existing
  agent. Prefer a new tool over reshaping an existing one.
- **Additive optional arguments are safe.** New arguments must be optional
  with a sensible default, so calls that omit them keep working. Adding a
  required argument, or removing/renaming an existing one, is a break.
- **Model uncertainty as optional / `undefined`**, not a guessed concrete
  value.
- **Keep argument schemas backward-compatible.** Widening an `enum` or making
  a field optional is safe; narrowing an `enum`, adding `required` entries, or
  setting `additionalProperties: false` where it wasn't are breaks. Don't
  change the meaning of an existing field.
- **Don't change a tool's result shape out from under callers.** Agents and
  downstream code parse tool output; reshaping it is a break even though the
  schema only describes inputs.

### When a rename is needed: deprecate, don't remove

- **Code:** keep the old export with a `@deprecated` JSDoc tag, delegating to
  the new one, for at least one minor release.
- **Tools:** add the new tool and keep the old name as a thin delegating alias
  for at least one minor release before removing it. The old tool should
  forward to the new handler so both names behave identically during the
  deprecation window. Note the deprecation in the old tool's `description` so
  agents and humans see it — don't just rename it out from under agents.

### API spec pinning

This server targets a pinned Exchange API spec version, recorded in
[`.api-version`](.api-version). The non-blocking `drift` CI job checks the pin
against the latest spec release. When you bump the surface to track a new spec,
update `.api-version` in the same PR and call it out (the PR template has a
section for this).

### When a break is unavoidable

Batch breaking changes into a single planned minor bump rather than one-per-PR,
and declare it with a `!` in the PR title — see
[How a PR lands](#how-a-pr-lands). "Calling it out in the PR" is not enough on
its own: prose in the PR description never reaches the commit, so release-please
does not see it and the break ships as a patch.

### Toward 1.0

`0.x` is for iteration: while we keep the tool surface stable wherever we can,
we may break it in a `0.x` release when there's no additive path — batched and
called out, not one break per PR. We commit to a stable surface (API **and**
tool names) at `1.0`; after that, removing or renaming a tool — or a breaking
change of any kind — requires a deprecation window and a major bump.
