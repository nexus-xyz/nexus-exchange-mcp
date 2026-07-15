// WebSocket streaming: mint a short-lived token over MCP, then hold the
// stream open OUTSIDE MCP.
//
// Auth tier: HMAC KEY (for the token mint). Set NEXUS_EXCHANGE_API_KEY /
// NEXUS_EXCHANGE_API_SECRET, and NEXUS_EXCHANGE_API_URL at a direct
// HMAC-verifying gateway (see the top-level README, "Authentication").
//
// Why the split: an MCP tool is request/response — it cannot hold a socket
// open. So the server's `get_ws_token` tool mints the single-use 60s token,
// and the CALLER connects to `wss://host/ws?token=...` directly. This script
// plays both roles: MCP client for the mint, WebSocket client for the stream.
//
//   get_ws_token  -> POST /ws/token (MCP tool, HMAC-signed)
//   /ws           -> subscribe to public trades + private fills channels
//
// Requires Node >= 22 for the global WebSocket client.
// Run `npm run build` first, then: node examples/ws-streaming.mjs

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, "..", "dist", "index.js");

const MARKET = process.env.EXAMPLE_MARKET_ID ?? "BTC-USDX-PERP";
const STREAM_SECONDS = 30;

if (
  !process.env.NEXUS_EXCHANGE_API_KEY ||
  !process.env.NEXUS_EXCHANGE_API_SECRET
) {
  console.error(
    "This example needs NEXUS_EXCHANGE_API_KEY / NEXUS_EXCHANGE_API_SECRET " +
      "to mint the WebSocket token (see the header comment).",
  );
  process.exit(1);
}
if (typeof globalThis.WebSocket !== "function") {
  console.error("This example needs Node >= 22 (global WebSocket client).");
  process.exit(1);
}

/** Call a tool and parse its JSON text content; throw on tool errors. */
async function callJson(client, name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  if (res.isError) throw new Error(`${name} failed: ${text}`);
  return JSON.parse(text);
}

async function main() {
  // ── Phase 1: MCP — mint the token ────────────────────────────────────────
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: process.env,
  });
  const client = new Client(
    { name: "ws-streaming-example", version: "0.0.0" },
    { capabilities: {} },
  );
  await client.connect(transport);

  let token;
  try {
    const minted = await callJson(client, "get_ws_token");
    token = minted.token ?? minted.ws_token;
    if (!token)
      throw new Error(`no token in response: ${JSON.stringify(minted)}`);
    console.log("Minted WS token (single-use, expires in 60s).");
  } finally {
    await client.close(); // MCP's job is done; the stream lives outside it.
  }

  // ── Phase 2: WebSocket — connect and subscribe ───────────────────────────
  // Derive the WS origin from the same base URL the server used.
  const base = (
    process.env.NEXUS_EXCHANGE_API_URL ?? "https://exchange.nexus.xyz"
  ).replace(/\/+$/, "");
  const wsUrl = `${base.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(token)}`;
  console.log(`Connecting to ${wsUrl.replace(/token=.*/, "token=***")}`);

  const ws = new WebSocket(wsUrl);

  ws.addEventListener("open", () => {
    // /ws envelopes: one {op: "subscribe"} message per channel.
    // Public channel (any token works):
    ws.send(
      JSON.stringify({ op: "subscribe", channel: "trades", market: MARKET }),
    );
    // Private channel (delivered for the account that minted the token):
    ws.send(JSON.stringify({ op: "subscribe", channel: "fills" }));
    console.log(
      `Subscribed to trades:${MARKET} + fills. Streaming for ${STREAM_SECONDS}s...\n`,
    );
  });

  ws.addEventListener("message", (event) => {
    // Every server->client message is a JSON envelope tagged with `op`.
    console.log(String(event.data).slice(0, 200));
  });

  ws.addEventListener("error", (event) => {
    console.error("WebSocket error:", event.message ?? event);
    process.exitCode = 1;
  });

  ws.addEventListener("close", (event) => {
    console.log(`\nSocket closed (${event.code}).`);
  });

  // Tokens are single-use; if you reconnect, mint a fresh one first.
  setTimeout(() => ws.close(), STREAM_SECONDS * 1000);
}

main().catch((err) => {
  console.error("example failed:", err);
  process.exit(1);
});
