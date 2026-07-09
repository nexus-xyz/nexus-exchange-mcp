// North star, end to end: an agent starts with NOTHING and finishes with a
// settled round-trip trade — fund, size, preview, trade, monitor, close, PnL.
//
// Auth tier: HMAC KEY (PLACES REAL TESTNET ORDERS + MOVES TESTNET FUNDS).
//
//   NEXUS_EXCHANGE_API_KEY     - HMAC key id
//   NEXUS_EXCHANGE_API_SECRET  - HMAC secret (hex)
//   NEXUS_EXCHANGE_API_URL     - a DIRECT indexer gateway that verifies client
//                                HMAC (e.g. http://localhost:9090); the public
//                                host's proxy doesn't honor per-caller HMAC.
//
// The full lifecycle, each step one MCP tool call:
//
//   1. claim_credit          -> fund the account with synthetic testnet USDX
//                               (falls back to claim_faucet on cooldown)
//   2. get_balance           -> confirm collateral landed
//   3. get_market_risk_params-> check leverage/margin rules before sizing
//   4. preview_order         -> project margin/fee impact; abort if unhappy
//   5. place_order           -> tiny IOC market buy (opens the position)
//   6. get_positions         -> observe the live position + unrealized PnL
//   7. place_order           -> reduce_only market sell (closes it flat)
//   8. get_closed_positions  -> read the realized PnL of the round trip
//   9. get_fills             -> the execution trail an agent would log
//
// Everything is sized tiny (default 0.001) and closed before exit; worst case
// on error is a 0.001-sized testnet position you close by rerunning step 7.
//
// Run `npm run build` first, then: node examples/agent-funds-and-trades.mjs

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, "..", "dist", "index.js");

const MARKET = process.env.EXAMPLE_MARKET_ID ?? "BTC-USDX-PERP";
const SIZE = process.env.EXAMPLE_ORDER_SIZE ?? "0.001";

if (
  !process.env.NEXUS_EXCHANGE_API_KEY ||
  !process.env.NEXUS_EXCHANGE_API_SECRET
) {
  console.error(
    "This example needs NEXUS_EXCHANGE_API_KEY / NEXUS_EXCHANGE_API_SECRET " +
      "(see the header comment). It trades REAL testnet funds.",
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
    env: process.env,
  });
  const client = new Client(
    { name: "agent-funds-and-trades-example", version: "0.0.0" },
    { capabilities: {} },
  );
  await client.connect(transport);

  let opened = false;
  try {
    // 1. Fund: claim testnet credit (up to the daily allowance). If the
    //    allowance is exhausted, fall back to the fixed-amount faucet.
    try {
      const credit = await callJson(client, "claim_credit", { amount: "100" });
      console.log(
        `1. funded via claim_credit: ${JSON.stringify(credit).slice(0, 200)}`,
      );
    } catch (err) {
      console.log(`1. claim_credit unavailable (${String(err).slice(0, 120)})`);
      const faucet = await callJson(client, "claim_faucet");
      console.log(
        `   funded via claim_faucet: ${JSON.stringify(faucet).slice(0, 200)}`,
      );
    }

    // 2. Confirm the collateral landed.
    const balance = await callJson(client, "get_balance");
    console.log(`2. balance: ${JSON.stringify(balance).slice(0, 200)}`);

    // 3. Know the rules before sizing: margin requirements and max leverage.
    const risk = await callJson(client, "get_market_risk_params", {
      market_id: MARKET,
    });
    console.log(
      `3. ${MARKET} risk params: ${JSON.stringify(risk).slice(0, 200)}`,
    );

    // 4. Preview the entry — margin/equity/fee impact with nothing submitted.
    //    An agent checks this BEFORE committing; a human calls it "risk check".
    const preview = await callJson(client, "preview_order", {
      market_id: MARKET,
      side: "buy",
      type: "market",
      size: SIZE,
    });
    console.log(`4. preview: ${JSON.stringify(preview).slice(0, 250)}`);

    // 5. Enter: tiny market buy. IOC is the market-order default: fill what
    //    crosses, cancel the rest — nothing rests on the book.
    const entry = await callJson(client, "place_order", {
      market_id: MARKET,
      side: "buy",
      type: "market",
      size: SIZE,
    });
    opened = true;
    console.log(`5. entry order: ${JSON.stringify(entry).slice(0, 250)}`);

    // 6. Observe the position the fill produced.
    const positions = await callJson(client, "get_positions");
    const pos = (Array.isArray(positions) ? positions : []).find(
      (p) => (p.market_id ?? p.market) === MARKET,
    );
    console.log(
      `6. position: ${JSON.stringify(pos ?? positions).slice(0, 250)}`,
    );

    // 7. Exit flat: reduce_only guarantees this can only shrink the position,
    //    never flip it short — the right way for an agent to close.
    const exit = await callJson(client, "place_order", {
      market_id: MARKET,
      side: "sell",
      type: "market",
      size: SIZE,
      reduce_only: true,
    });
    opened = false;
    console.log(`7. exit order: ${JSON.stringify(exit).slice(0, 250)}`);

    // 8. The scoreboard: realized PnL of the round trip.
    const closed = await callJson(client, "get_closed_positions", { limit: 1 });
    console.log(`8. closed position: ${JSON.stringify(closed).slice(0, 250)}`);

    // 9. The audit trail: the fills behind both orders.
    const fills = await callJson(client, "get_fills", { limit: 4 });
    console.log(`9. recent fills: ${JSON.stringify(fills).slice(0, 300)}`);

    console.log(
      "\nRound trip complete: funded -> traded -> closed -> settled.",
    );
  } finally {
    if (opened) {
      console.error(
        `NOTE: the ${SIZE} ${MARKET} position may still be open. Close it by ` +
          `rerunning, or place a reduce_only market sell of ${SIZE}.`,
      );
    }
    await client.close();
  }
}

main().catch((err) => {
  console.error("example failed:", err);
  process.exit(1);
});
