// Portfolio health check: the authenticated READ-ONLY account tools. Nothing
// here places, amends, or cancels anything.
//
// Auth tier: HMAC KEY (read-only). Set in the environment:
//
//   NEXUS_EXCHANGE_API_KEY     - HMAC key id
//   NEXUS_EXCHANGE_API_SECRET  - HMAC secret (hex)
//   NEXUS_EXCHANGE_API_URL     - a DIRECT indexer gateway that verifies client
//                                HMAC (e.g. http://localhost:9090). The public
//                                production host proxies authenticated calls
//                                under the site's own key — see the top-level
//                                README, "Authentication".
//
//   get_account_summary    -> equity / margin / PnL rollup
//   get_balance            -> collateral snapshot
//   get_equity_history     -> equity time-series (5s cadence, ~1h)
//   get_positions          -> open positions
//   get_closed_positions   -> realized PnL per closed position
//   get_funding_payments   -> funding paid/received
//   get_rate_limit_status  -> remaining request budget (agents: pace yourself)
//
// Run `npm run build` first, then: node examples/account-health.mjs

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, "..", "dist", "index.js");

if (
  !process.env.NEXUS_EXCHANGE_API_KEY ||
  !process.env.NEXUS_EXCHANGE_API_SECRET
) {
  console.error(
    "This example needs NEXUS_EXCHANGE_API_KEY and NEXUS_EXCHANGE_API_SECRET " +
      "in the environment (see the header comment). For a zero-credential " +
      "version of this flow, run examples/demo-account.mjs.",
  );
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
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: process.env, // credentials flow to the server, never to this script
  });
  const client = new Client(
    { name: "account-health-example", version: "0.0.0" },
    { capabilities: {} },
  );
  await client.connect(transport);

  try {
    const summary = await callJson(client, "get_account_summary");
    console.log("Portfolio summary:");
    console.log(JSON.stringify(summary, null, 2).slice(0, 600));

    const balance = await callJson(client, "get_balance");
    console.log("\nBalance snapshot:");
    console.log(JSON.stringify(balance, null, 2).slice(0, 400));

    // Equity over the last ~5 minutes (60 points at 5s cadence).
    const equity = await callJson(client, "get_equity_history", { limit: 60 });
    const points = Array.isArray(equity) ? equity : (equity.points ?? []);
    console.log(`\nEquity history: ${points.length} points`);
    if (points.length > 1) {
      console.log(
        `  first=${JSON.stringify(points[0])}\n  last =${JSON.stringify(points[points.length - 1])}`,
      );
    }

    const positions = await callJson(client, "get_positions");
    console.log(
      `\nOpen positions (${Array.isArray(positions) ? positions.length : "?"}):`,
    );
    console.log(JSON.stringify(positions, null, 2).slice(0, 400));

    const closed = await callJson(client, "get_closed_positions", {
      limit: 5,
    });
    console.log("\nLast closed positions (realized PnL):");
    console.log(JSON.stringify(closed, null, 2).slice(0, 400));

    const fundingPaid = await callJson(client, "get_funding_payments", {
      limit: 5,
    });
    console.log("\nRecent funding payments:");
    console.log(JSON.stringify(fundingPaid, null, 2).slice(0, 400));

    // Good agent hygiene: check the budget before looping on anything.
    const rate = await callJson(client, "get_rate_limit_status");
    console.log("\nRate-limit status:");
    console.log(JSON.stringify(rate, null, 2).slice(0, 300));
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error("example failed:", err);
  process.exit(1);
});
