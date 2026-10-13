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
# just-built smoke (smoke.mjs) is run three times that way, so exit codes 2 and
# 1 are exercised on every run and not only described here:
#   - http://127.0.0.1:1, where nothing listens: must exit 2 (unreachable);
#   - scripts/release_gate/stub_server.py, which answers 200 with no markets:
#     must exit 1 (failed);
#   - stub_server.py 503, which answers every request with a 503: must exit 2,
#     because an outage reads as unreachable, never as failed or passed.
# Exit 0 (passed) is exercised only by the real read, which runs on a release PR
# or a change to this gate. Each probe has a 180 s timeout
# (the package retries transient errors with backoff, so a shorter one races it). A wrong code, or a
# timeout, is its own failure, named "(outcomes)". The probes run smoke.mjs
# directly with stdout and stderr captured, so they emit no annotations; each
# prints one plain log line instead: case, exit code, first line of output.
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

# Run the just-built smoke against $2 with NEXUS_SMOKE_BASE_URL set, 180 s at
# most, and fail the job unless it exits $3. $1 names the case, $4 says what it
# is pointed at. Stdout and stderr are both captured (the real smoke's `::error`
# lines may go to either), and one plain log line is printed: case, exit code,
# first line of output, with a leading `::` defanged so it cannot be read as an
# annotation.
# `timeout` is GNU coreutils: macOS has none by default (Homebrew's coreutils
# installs it as `gtimeout`). Without either, the probes run with no time limit,
# and the job's own timeout is the backstop.
limit=()
if command -v timeout > /dev/null 2>&1; then
  limit=(timeout 180)
elif command -v gtimeout > /dev/null 2>&1; then
  limit=(gtimeout 180)
else
  echo "note: neither timeout nor gtimeout is installed, so the probes run with no time limit"
fi

expect_exit() {
  local label="$1" url="$2" want="$3" what="$4" got out first
  set +e
  out="$(cd "$work/consumer" && NEXUS_SMOKE_BASE_URL="$url" ${limit[@]+"${limit[@]}"} node smoke.mjs "$name" 2>&1)"
  got=$?
  set -e
  first="$(printf '%s\n' "$out" | head -n 1)"
  first="${first/#::/: :}"
  echo "probe ${label}: exit ${got}: ${first}"
  if [ "$got" -ne "$want" ]; then
    local why="expected exit ${want} from ${what}, got ${got}"
    [ "$got" -eq 124 ] && why="expected exit ${want} from ${what}, but the probe hit its 180s timeout"
    echo "::error title=prepublish-smoke (outcomes)::The smoke does not keep its outcomes apart, so a testnet read through it would prove nothing. ${label} case: ${why}."
    summary "❌ OUTCOMES WRONG: nothing was read" "${label} case: ${why}."
    exit 1
  fi
}

# A stand-in from stub_server.py ($1: the status it answers every request with;
# none for 200 and no markets). Its first line of stdout is its port, left in
# $port; the process is left in $stub_pid for the EXIT trap or stop_stub.
start_stub() {
  : > "$work/stub.out"
  python3 -I scripts/release_gate/stub_server.py ${1:+"$1"} > "$work/stub.out" &
  stub_pid=$!
  port=""
  for _ in $(seq 1 50); do
    port="$(head -n 1 "$work/stub.out")"
    [ -n "$port" ] && break
    sleep 0.1
  done
  if [ -z "$port" ]; then
    echo "::error title=prepublish-smoke (outcomes)::scripts/release_gate/stub_server.py ${1:-} printed no port, so a probe could not run."
    summary "❌ OUTCOMES WRONG: nothing was read" "stub_server.py printed no port."
    exit 1
  fi
}

stop_stub() {
  kill "$stub_pid" 2>/dev/null || true
  stub_pid=""
}

expect_exit "unreachable" "http://127.0.0.1:1" 2 "a base URL nothing listens on"
start_stub
expect_exit "empty" "http://127.0.0.1:${port}" 1 "a server that answers with no markets"
stop_stub
start_stub 503
expect_exit "outage" "http://127.0.0.1:${port}" 2 "a server that answers every request with 503"
stop_stub
echo "the smoke's outcomes hold: nothing listening exits 2, an empty answer exits 1, a 503 exits 2"

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
