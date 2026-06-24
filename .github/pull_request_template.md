<!--
Thanks for contributing to nexus-exchange-mcp!
Keep PRs focused; open separate PRs for unrelated changes.
-->

## Summary

<!-- What does this PR do, and why? Link the motivating issue. -->

Closes #

## Changes

<!-- Bullet the notable changes. Call out any new or changed tool surface. -->

-

## Tool surface impact

<!--
The tool surface (names + input schemas in src/tools/index.ts) is the breaking
surface for agents. Check the box that applies. See CONTRIBUTING.md.
-->

- [ ] No change to the tool surface.
- [ ] Additive only (new tool, or new optional argument) — backward-compatible.
- [ ] Renames/removes a tool or changes an existing argument schema — breaking; describe the deprecation path below.

## API spec impact

<!--
This server tracks a pinned Exchange API spec version (`.api-version`).
Check the box that applies.
-->

- [ ] No change to the targeted API spec version.
- [ ] Bumps `.api-version` (and the README spec reference) to a new release — the `drift` check enforces this stays in sync.

## Checklist

- [ ] `npm run format` is clean (`format` — CI runs `format:check`).
- [ ] `npm run lint` passes (`lint`).
- [ ] `npm run typecheck` passes (`typecheck`).
- [ ] `npm test` passes (`test`).
- [ ] `npm run smoke` passes, if the change touches the tool surface or client.

## Notes for reviewers

<!-- Anything reviewers should focus on, risks, or follow-ups. -->
