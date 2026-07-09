// Authenticated trading walkthrough: place -> inspect -> amend -> cancel a
// resting limit order, safely.
//
// Auth tier: HMAC KEY (PLACES REAL TESTNET ORDERS). Set in the environment:
//
//   NEXUS_EXCHANGE_API_KEY     - HMAC key id
//   NEXUS_EXCHANGE_API_SECRET  - HMAC secret (hex)
//   NEXUS_EXCHANGE_API_URL     - a DIRECT indexer gateway that verifies client
//                                HMAC (e.g. http://localhost:9090); the public
//                                host's proxy doesn't honor per-caller HMAC.
//
// Safety by construction: the bid is priced 20% BELOW the current mark, so it
// rests without filling, and the script always cancels it at the end (also on
// error). The only state left behind is an order-history entry.
//
//   get_mark_price  -> price the order safely off-market
//   preview_order   -> margin/fee impact BEFORE committing (nothing submitted)
//   place_order     -> submit the resting bid (PostOnly: never takes)
//   get_order       -> inspect it on the book
//   amend_order     -> atomic cancel-replace: nudge price up 1%
//   cancel_order    -> clean up (single-order cancel; never cancel_all)
//
// Run `npm run build` first, then: node examples/trading-walkthrough.mjs

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
    "This example needs NEXUS_EXCHANGE_API_KEY and NEXUS_EXCHANGE_API_SECRET " +
      "(see the header comment). It places a REAL testnet order.",
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

/** Decimal string math without float drift: price * factorPct / 100. */
function pct(price, factorPct) {
  // Orders carry prices as decimal strings; keep 2dp which every USDX quote
  // market accepts. (A production agent would round to the market tick size
  // from get_market_risk_params / list_market_specs.)
  return (Number(price) * (factorPct / 100)).toFixed(2);
}

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: process.env,
  });
  const client = new Client(
    { name: "trading-walkthrough-example", version: "0.0.0" },
    { capabilities: {} },
  );
  await client.connect(transport);

  let orderId;
  try {
    // 1. Price the order safely off-market: 20% below the current mark.
    const mark = await callJson(client, "get_mark_price", {
      market_id: MARKET,
    });
    const markPrice = mark.mark_price ?? mark.price ?? mark;
    const bidPrice = pct(markPrice, 80);
    console.log(`${MARKET} mark=${markPrice} -> resting bid at ${bidPrice}`);

    // 2. Preview first: margin, equity, and fee impact, without submitting.
    const preview = await callJson(client, "preview_order", {
      market_id: MARKET,
      side: "buy",
      type: "limit",
      size: SIZE,
      price: bidPrice,
      time_in_force: "PostOnly",
    });
    console.log(`\npreview_order: ${JSON.stringify(preview).slice(0, 300)}`);

    // 3. Commit. PostOnly guarantees it can only rest as a maker — if it would
    //    cross the book, the engine rejects it instead of filling.
    const placed = await callJson(client, "place_order", {
      market_id: MARKET,
      side: "buy",
      type: "limit",
      size: SIZE,
      price: bidPrice,
      time_in_force: "PostOnly",
    });
    orderId = placed.order_id ?? placed.id;
    console.log(`\nplaced order ${orderId}`);

    // 4. Inspect it on the book.
    const order = await callJson(client, "get_order", {
      order_id: String(orderId),
      market_id: MARKET,
    });
    console.log(`get_order: ${JSON.stringify(order).slice(0, 300)}`);

    // 5. Amend: nudge the price up 1% (still far below mark) in one atomic
    //    cancel-replace. At least one of price/size is required.
    const newPrice = pct(bidPrice, 101);
    const amended = await callJson(client, "amend_order", {
      order_id: String(orderId),
      market_id: MARKET,
      price: newPrice,
    });
    console.log(
      `\namended to ${newPrice}: ${JSON.stringify(amended).slice(0, 200)}`,
    );
  } finally {
    // 6. Always clean up the resting order — including on error paths.
    //    Note: single-order cancel. `cancel_all: true` exists but is the
    //    blast-radius option; never use it in a script that shares a key.
    if (orderId !== undefined) {
      try {
        await callJson(client, "cancel_order", {
          order_id: String(orderId),
          market_id: MARKET,
        });
        console.log(`\ncancelled order ${orderId} — book is clean`);
      } catch (err) {
        console.error(`cleanup cancel failed (cancel manually!): ${err}`);
      }
    }
    await client.close();
  }
}

main().catch((err) => {
  console.error("example failed:", err);
  process.exit(1);
});
