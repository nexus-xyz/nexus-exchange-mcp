#!/usr/bin/env bash
# Fetch the pinned Exchange API spec (if not already cached locally) and run the
# spec-drift checker over it.
#
# One entry point for both CI and a developer's laptop, on purpose: the workflow
# restores `openapi.pinned.json` from its cache and calls this script, which then
# skips the download. So there is exactly one code path deciding which spec the
# checker sees, and `npm run spec:drift` locally verifies the same thing CI does.
#
# Any arguments are passed through to the checker (e.g. `--write` to regenerate
# endpoints.txt).
set -euo pipefail

cd "$(dirname "$0")/.."

SPEC_REPO="${SPEC_REPO:-nexus-xyz/nexus-exchange-api}"
CACHE="openapi.pinned.json"

tag="$(tr -d '[:space:]' < .api-version)"
# Validate before the tag reaches a URL or a filename. `.api-version` is
# repo-controlled but arrives from an automated bump PR, so treat it as data.
if [[ ! "$tag" =~ ^v[0-9]+(\.[0-9]+){0,2}$ ]]; then
  echo "ERROR: .api-version must look like vX.Y.Z (got: '$tag')" >&2
  exit 1
fi

# Re-fetch when the cached copy is for a different tag: the cache key in CI is
# the tag, but locally the file just sits there across pin bumps.
if [ -f "$CACHE" ] && [ "$(cat .spec-cache-tag 2>/dev/null || true)" = "$tag" ]; then
  echo "Using cached $CACHE for $tag"
else
  echo "Fetching $SPEC_REPO@$tag spec..."
  # The raw-at-tag URL, not the release asset: asset download_count is reserved
  # as an external-adoption signal, so CI must not inflate it.
  curl -fsSL \
    "https://raw.githubusercontent.com/${SPEC_REPO}/${tag}/openapi.json" \
    -o "$CACHE"
  printf '%s\n' "$tag" > .spec-cache-tag
fi

exec python3 scripts/check_spec_drift.py "$CACHE" "$@"
