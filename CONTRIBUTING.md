# Contributing

## Compatibility & deprecations

This server follows [semver](https://semver.org/) (version in `package.json`).
Pre-1.0 (`0.x`), a breaking change is a minor bump — but we minimize and
**batch** them.

**Two public surfaces break independently:**

- the **TypeScript API** (exported functions / types), and
- the **MCP tool surface** — tool names and their input schemas. **Renaming or
  removing a tool, or tightening a tool's input schema, breaks the agents
  calling it.** Treat a tool with the same care as a public function.

### Prefer designs that don't need a break

- Model uncertainty as optional / `undefined`, not a guessed concrete value.
- Add **new tools and new optional schema fields** rather than changing existing
  ones.

### When a rename is needed: deprecate, don't remove

- **Code:** keep the old export with a `@deprecated` JSDoc tag, delegating to the
  new one, for at least one minor release.
- **Tools:** keep the old tool name registered (delegating to the new handler)
  with a deprecation note in its `description` until callers have migrated —
  don't just rename it out from under agents.

### When a break is unavoidable

Batch breaking changes into a single planned minor bump rather than one-per-PR,
and call it out in the PR.

### Toward 1.0

`0.x` is for iteration; we commit to a stable surface (API **and** tool names) at
`1.0`, after which breaking changes require a deprecation window and a major bump.
