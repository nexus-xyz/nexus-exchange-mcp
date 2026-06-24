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
transport), lists the tools, and calls `list_markets` against the configured
gateway (production by default):

```bash
npm run smoke
```

It needs network access to the gateway and does not require a build. For an
out-of-process check that exercises the real stdio transport, see
[`examples/`](examples/) — it spawns the built server as a subprocess, so run
`npm run build` first.

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
and call it out in the PR.

### Toward 1.0

`0.x` is for iteration: while we keep the tool surface stable wherever we can,
we may break it in a `0.x` release when there's no additive path — batched and
called out, not one break per PR. We commit to a stable surface (API **and**
tool names) at `1.0`; after that, removing or renaming a tool — or a breaking
change of any kind — requires a deprecation window and a major bump.
