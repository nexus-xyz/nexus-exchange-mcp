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
#
# In every mode, right after the install and before any testnet read, the
# just-built smoke (smoke.mjs) is run twice that way, so the exit codes are
# exercised and not only described here: against http://127.0.0.1:1, where
# nothing listens, it must exit 2 (unreachable, never a pass); against
# scripts/release_gate/stub_server.py, which answers 200 with no markets, it
# must exit 1. Either code wrong is its own failure, named "(outcomes)". The
# probes run smoke.mjs directly, so the annotations below for an exit 1 or 2,
# which are expected there, are not printed for them.
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
stub_pid=""
trap 'if [ -n "$stub_pid" ]; then kill "$stub_pid" 2>/dev/null || true; fi; rm -rf "$work"' EXIT

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

# Run the just-built smoke against $2 with NEXUS_SMOKE_BASE_URL set, and fail the
# job unless it exits $3. $1 names the case. Its own output is dropped: a
# failure here is reported below, and a smoke that passes for the wrong reason
# has nothing worth quoting.
expect_exit() {
  local label="$1" url="$2" want="$3" got
  set +e
  (cd "$work/consumer" && NEXUS_SMOKE_BASE_URL="$url" node smoke.mjs "$name" > /dev/null)
  got=$?
  set -e
  if [ "$got" -ne "$want" ]; then
    echo "::error title=prepublish-smoke (outcomes)::The smoke does not keep its outcomes apart, so a testnet read through it would prove nothing. ${label}: expected exit ${want}, got ${got}."
    summary "❌ OUTCOMES WRONG: nothing was read" "${label}: expected exit ${want}, got ${got}."
    exit 1
  fi
}

expect_exit "unreachable case (nothing listens at http://127.0.0.1:1)" "http://127.0.0.1:1" 2

# A stand-in that answers but has nothing. Its first line of stdout is its port.
python3 -I scripts/release_gate/stub_server.py > "$work/stub.out" &
stub_pid=$!
port=""
for _ in $(seq 1 50); do
  port="$(head -n 1 "$work/stub.out")"
  [ -n "$port" ] && break
  sleep 0.1
done
if [ -z "$port" ]; then
  echo "::error title=prepublish-smoke (outcomes)::scripts/release_gate/stub_server.py printed no port, so the empty case could not run."
  summary "❌ OUTCOMES WRONG: nothing was read" "stub_server.py printed no port."
  exit 1
fi
expect_exit "empty case (a server that answers with no markets)" "http://127.0.0.1:${port}" 1
kill "$stub_pid" 2>/dev/null || true
stub_pid=""
echo "the smoke's outcomes hold: nothing listening exits 2, an empty answer exits 1"

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
