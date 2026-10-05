#!/usr/bin/env bash
# Public-surface snapshot (ENG-18798). Lists the public surface of the package
# exactly as `npm pack` packs it (the tarball a publish uploads, installed into
# a throwaway consumer) and compares it with the committed `public-api.txt`.
#
#   scripts/release_gate/public_api.sh           check: fail on any difference
#                                                (CI, `prepublish-surface`)
#   scripts/release_gate/public_api.sh --write   regenerate public-api.txt after
#                                                a deliberate change
#
# Any difference fails, additions included, so the snapshot moves in the same
# PR as the code. A removed or reshaped tool then shows up as a `-` line in the
# diff a reviewer reads, instead of first surfacing as an agent's failed call.
# What counts as the surface (the MCP tools with their input schemas, and the
# `bin` entries) is described in scripts/release_gate/surface.mjs.
#
# Needs the repo's dev dependencies (`npm ci`) for the build, and the registry
# for the consumer's install, which resolves the package's dependencies the way
# a user's install does.
set -euo pipefail

SNAPSHOT="public-api.txt"

mode="check"
case "${1:-}" in
  "") ;;
  --write) mode="write" ;;
  *) echo "usage: $0 [--write]" >&2; exit 2 ;;
esac

root="$(git rev-parse --show-toplevel)"
cd "$root"

name="$(node -p 'require("./package.json").name')"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# What a publish would upload. `npm pack` runs no build of its own (the build is
# in prepublishOnly, which only `npm publish` runs), so build first, as
# release.yml does.
npm run --loglevel=error build
tarball="$(npm pack --loglevel=error --pack-destination "$work")"
mkdir "$work/consumer"
echo '{ "name": "prepublish-surface", "private": true, "type": "module" }' > "$work/consumer/package.json"
(cd "$work/consumer" && npm install --loglevel=error --no-audit --no-fund "$work/$tarball")
cp scripts/release_gate/surface.mjs "$work/consumer/surface.mjs"
(cd "$work/consumer" && node surface.mjs "$name") > "$work/public-api.txt"

if [ "$mode" = "write" ]; then
  cp "$work/public-api.txt" "$SNAPSHOT"
  echo "wrote $SNAPSHOT ($(wc -l < "$SNAPSHOT") items) from ${tarball}"
  exit 0
fi

if diff -u --label "$SNAPSHOT (committed)" --label "$SNAPSHOT (packed ${tarball})" \
  "$SNAPSHOT" "$work/public-api.txt" > "$work/diff.txt"; then
  echo "public surface matches $SNAPSHOT ($(wc -l < "$SNAPSHOT") items)"
  exit 0
fi

removed="$(grep -c '^-[^-]' "$work/diff.txt" || true)"
added="$(grep -c '^+[^+]' "$work/diff.txt" || true)"
cat "$work/diff.txt"
echo "::error title=prepublish-surface::The packed package's public surface differs from $SNAPSHOT: ${removed} item(s) gone or changed, ${added} new. If that is deliberate, run scripts/release_gate/public_api.sh --write and commit $SNAPSHOT in this PR, so the change is in the diff a reviewer reads. A removal or change breaks the agents calling it."
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### Public surface: ❌ differs from \`$SNAPSHOT\`"
    echo
    echo "${removed} item(s) gone or changed (\`-\`), ${added} new (\`+\`). Regenerate with \`scripts/release_gate/public_api.sh --write\` if deliberate."
    echo
    echo '```diff'
    cat "$work/diff.txt"
    echo '```'
  } >> "$GITHUB_STEP_SUMMARY"
fi
exit 1
