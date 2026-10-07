#!/usr/bin/env bash
# Pre-publish smoke test (ENG-18798). Builds and packs the package as a publish
# would, installs the tarball into a throwaway consumer, and runs one
# unauthenticated read against the public testnet with it
# (scripts/release_gate/smoke.mjs). No keys, no writes.
#
#   scripts/release_gate/smoke.sh                 pack, install, read
#   scripts/release_gate/smoke.sh --install-only  pack and install, no read
#                                                 (PRs that are not a release)
#
# Exit codes, kept apart on purpose: 0 passed, 1 failed, 2 testnet unreachable.
# The workflow fails on 1 and on 2, under different names. Unreachable is not a
# pass, and it is not the package's fault: re-run the job once testnet answers.
# NEXUS_SMOKE_BASE_URL points the read at another base URL, for testing those
# outcomes.
set -euo pipefail

mode="read"
case "${1:-}" in
  "") ;;
  --install-only) mode="install" ;;
  *) echo "usage: $0 [--install-only]" >&2; exit 64 ;;
esac

root="$(git rev-parse --show-toplevel)"
cd "$root"
name="$(node -p 'require("./package.json").name')"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# `npm pack` runs no build of its own (the build is in prepublishOnly, which
# only `npm publish` runs), so build first, as release.yml does.
npm run --loglevel=error build
tarball="$(npm pack --loglevel=error --pack-destination "$work")"
mkdir "$work/consumer"
echo '{ "name": "prepublish-smoke", "private": true, "type": "module" }' > "$work/consumer/package.json"
# No lockfile ships in the tarball, so the dependencies resolve the way a
# user's install resolves them.
(cd "$work/consumer" && npm install --loglevel=error --no-audit --no-fund "$work/$tarball")
cp scripts/release_gate/smoke.mjs "$work/consumer/smoke.mjs"
echo "installed ${tarball} into a clean consumer"

summary() {
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    printf '### Testnet smoke: %s\n\n%s\n' "$1" "$2" >> "$GITHUB_STEP_SUMMARY"
  fi
}

if [ "$mode" = "install" ]; then
  echo "::notice title=prepublish-smoke (read not attempted)::Not a release PR: the package packed and installed into a clean consumer, and no testnet read was made. The read runs on the release PR."
  summary "install only" "Not a release PR: \`${tarball}\` packed and installed into a clean consumer. No testnet read was attempted, so this is not a smoke pass."
  exit 0
fi

set +e
line="$(cd "$work/consumer" && node smoke.mjs "$name")"
code=$?
set -e
echo "$line"
case "$code" in
  0)
    summary "✅ passed" "$line"
    ;;
  2)
    echo "::error title=prepublish-smoke (testnet unreachable)::NOT a pass: the testnet read got no usable answer, so nothing about this release was verified. Re-run this job once testnet answers. ${line}"
    summary "⚠️ TESTNET UNREACHABLE: not a pass" "$line"
    ;;
  *)
    echo "::error title=prepublish-smoke (failed)::The packed package could not make an unauthenticated testnet read. ${line}"
    summary "❌ FAILED" "$line"
    code=1
    ;;
esac
exit "$code"
