#!/usr/bin/env bash
# Run an image and check it answers `/healthz` and an MCP `initialize` on `/mcp`.
# Usage: scripts/container-smoke.sh <image>   (CI and local use the same script)
set -euo pipefail

image="${1:?usage: container-smoke.sh <image>}"
port="${SMOKE_PORT:-8080}"
base="http://127.0.0.1:${port}"
name="mcp-smoke-$$"

docker run -d --rm --name "$name" -p "${port}:8080" "$image" >/dev/null
trap 'docker logs "$name" 2>&1 | tail -n 50 || true; docker rm -f "$name" >/dev/null 2>&1 || true' EXIT

for _ in $(seq 1 30); do
  if curl -fsS "${base}/healthz" >/dev/null 2>&1; then break; fi
  sleep 1
done
health="$(curl -fsS "${base}/healthz")"
echo "healthz: ${health}"
[[ "$health" == *'"ok"'* ]] || { echo "::error::/healthz did not report ok"; exit 1; }

init='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"container-smoke","version":"0"}}}'
resp="$(curl -fsS -D /dev/stderr -X POST "${base}/mcp" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data "$init")"
echo "initialize: ${resp}"
[[ "$resp" == *'"serverInfo"'* ]] || { echo "::error::/mcp initialize returned no serverInfo"; exit 1; }
echo "container smoke passed"
