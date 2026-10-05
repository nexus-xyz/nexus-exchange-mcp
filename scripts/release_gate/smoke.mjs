// Pre-publish smoke test (ENG-18798): one unauthenticated read against the
// public testnet, through the package exactly as `npm pack` packs it.
//
// scripts/release_gate/smoke.sh installs the packed tarball into a throwaway
// consumer and runs this file there, so it sees what an
// `npm install @nexus-xyz/exchange-mcp` user gets: the built dist/, not src/
// through tsx. It drives the server the way scripts/smoke.ts does (tools/call
// over the SDK's in-memory transport) and calls `fetch_markets_summary`, the
// keyless tool that lists markets, the same read every SDK's smoke test makes.
//
// The target is named, never defaulted (ENG-8092): NEXUS_EXCHANGE_NETWORK=
// testnet, so the read goes to the testnet base this package ships in
// src/networks.ts, which is the one a user's install reaches.
// NEXUS_SMOKE_BASE_URL points it elsewhere, for testing the outcomes
// themselves, and keeps the network named alongside the URL, as
// CONTRIBUTING.md's "Smoke check" asks.
//
// Three outcomes, kept apart by exit code, because "could not reach testnet"
// must never read as a pass and is not the package's fault either:
//
//   0  passed       the tool returned a list with at least one market in it
//   1  failed       the package got an answer and could not use it (non-JSON,
//                   4xx, not a market list, empty list)
//   2  unreachable  no usable answer from testnet: network, timeout, 5xx, rate
//                   limit
//
// The server turns an upstream error into a tool result whose text is the
// client's message (src/server.ts), so the outcome is read from that text:
// `fetch failed` is Node's fetch getting no response at all (DNS, refused,
// TLS), and `Exchange API <status>:` carries the HTTP status (src/client.ts).
// The client sets no timeout of its own, so the tools/call carries one.
// Anything not recognized as unreachable counts as failed, never as a pass.
//
// No keys, no writes, no orders. The config is built from an explicit env, so
// credentials in the caller's environment never reach it.
//
//   node smoke.mjs <package name>

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

const TOOL = "fetch_markets_summary";
const TIMEOUT_MS = 30_000;

function finish(code, message) {
  const outcome = { 0: "passed", 2: "unreachable" }[code] ?? "failed";
  // One line: it is quoted into a workflow annotation, which ends at a newline.
  console.log(`smoke: ${outcome}: ${message.replace(/\s+/g, " ")}`);
  process.exit(code);
}

const pkg = process.argv[2];
if (!pkg) {
  console.error("usage: node smoke.mjs <package name>");
  process.exit(64);
}
const { loadConfig } = await import(`${pkg}/dist/config.js`);
const { createServer } = await import(`${pkg}/dist/server.js`);

const env = { NEXUS_EXCHANGE_NETWORK: "testnet" };
const override = (process.env.NEXUS_SMOKE_BASE_URL ?? "").trim();
if (override) env.NEXUS_EXCHANGE_API_URL = override;

let config;
try {
  config = loadConfig(env);
} catch (err) {
  finish(1, `NEXUS_SMOKE_BASE_URL is not usable: ${err.message}`);
}
const target = config.baseUrl;

const server = createServer(config);
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
const client = new Client(
  { name: "prepublish-smoke", version: "0.0.0" },
  { capabilities: {} },
);
await client.connect(clientTransport);

let result;
try {
  result = await client.callTool({ name: TOOL, arguments: {} }, undefined, {
    timeout: TIMEOUT_MS,
  });
} catch (err) {
  if (err instanceof McpError && err.code === ErrorCode.RequestTimeout) {
    finish(2, `${target} gave no answer within ${TIMEOUT_MS / 1000}s`);
  }
  finish(1, `tools/call ${TOOL} failed: ${err.message}`);
}

const text = result.content?.[0]?.text ?? "";
if (result.isError) {
  const message = text.replace(`Error calling ${TOOL}: `, "");
  const status = Number(/^Exchange API (\d{3}):/.exec(message)?.[1]);
  if (message === "fetch failed" || status >= 500 || status === 429) {
    finish(2, `${target} gave no usable answer: ${message}`);
  }
  finish(1, `${TOOL} against ${target} failed: ${message}`);
}

let markets;
try {
  markets = JSON.parse(text);
} catch {
  finish(1, `${TOOL} against ${target} returned text that is not JSON`);
}
if (!Array.isArray(markets)) {
  const kind =
    markets === null
      ? "null"
      : typeof markets === "object"
        ? "an object"
        : `a ${typeof markets}`;
  finish(
    1,
    `${TOOL} against ${target} returned ${kind}, not a list of markets: ${text.slice(0, 120)}`,
  );
}
if (markets.length === 0) {
  finish(1, `${TOOL} decoded an EMPTY list from ${target}`);
}
if (typeof markets[0]?.market_id !== "string") {
  finish(
    1,
    `${TOOL} against ${target} returned a list whose first entry is not a market summary (no string market_id): ${JSON.stringify(markets[0]).slice(0, 120)}`,
  );
}
finish(
  0,
  `${TOOL} decoded ${markets.length} markets from ${target} (first: ${markets[0].market_id})`,
);
