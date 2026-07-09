// The account flow with ZERO secrets: the indexer exposes a read-only demo
// namespace bound to a live bot account, so you can see real balances,
// positions, and orders before wiring up API keys.
//
// Auth tier: PUBLIC — no credentials needed. Runs as-is against the public
// testnet.
//
//   get_demo_account    -> balance / equity snapshot
//   get_demo_positions  -> open positions
//   get_demo_orders     -> resting orders
//
// Run `npm run build` first, then: node examples/demo-account.mjs

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, "..", "dist", "index.js");

/** Call a tool and parse its JSON text content; throw on tool errors. */
async function callJson(client, name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  if (res.isError) throw new Error(`${name} failed: ${text}`);
  return JSON.parse(text);
}

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: process.env,
  });
  const client = new Client(
    { name: "demo-account-example", version: "0.0.0" },
    { capabilities: {} },
  );
  await client.connect(transport);

  try {
    const account = await callJson(client, "get_demo_account");
    console.log("Demo account snapshot:");
    console.log(JSON.stringify(account, null, 2).slice(0, 600));

    const positions = await callJson(client, "get_demo_positions");
    console.log(
      `\nOpen positions (${Array.isArray(positions) ? positions.length : "?"}):`,
    );
    console.log(JSON.stringify(positions, null, 2).slice(0, 600));

    const orders = await callJson(client, "get_demo_orders");
    console.log(
      `\nResting orders (${Array.isArray(orders) ? orders.length : "?"}):`,
    );
    console.log(JSON.stringify(orders, null, 2).slice(0, 600));

    console.log(
      "\nSame flow with YOUR account: set NEXUS_EXCHANGE_API_KEY / " +
        "NEXUS_EXCHANGE_API_SECRET and use get_balance / get_positions / " +
        "get_open_orders — see examples/account-health.mjs.",
    );
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error("example failed:", err);
  process.exit(1);
});
