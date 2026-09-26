// Market-data agent: a read-only scan of the venue using only PUBLIC tools.
//
// Auth tier: PUBLIC — no credentials needed. Runs as-is against the public
// testnet (production gateway by default; see ../.env.example).
//
// It spawns the built server (dist/index.js) over stdio — exactly how a real
// MCP client launches it — then walks the same tools an agent would use to
// build a market picture:
//
//   fetch_markets_summary            -> what's tradable + live summary
//   fetch_ticker              -> best bid/ask for the most active market
//   fetch_order_book           -> depth snapshot
//   fetch_funding_rate_history     -> settled hourly funding rates
//   fetch_market_risk_params  -> margin requirements / max leverage
//   fetch_stats               -> venue-wide volume and trader counts
//
// Run `npm run build` first, then: node examples/market-scan.mjs

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
    { name: "market-scan-example", version: "0.0.0" },
    { capabilities: {} },
  );
  await client.connect(transport);

  try {
    // 1. What's tradable, and how active is each market?
    const markets = await callJson(client, "fetch_markets_summary");
    console.log(`Markets: ${markets.length}`);
    for (const m of markets) {
      console.log(
        `  ${m.market_id ?? m.id}: mark=${m.mark_price ?? "?"} vol24h=${m.volume_24h ?? "?"}`,
      );
    }

    // Pick the first market for the deep dive (an agent would rank by volume).
    const marketId = markets[0]?.market_id ?? markets[0]?.id ?? "BTC-USDX-PERP";
    console.log(`\nDeep dive: ${marketId}`);

    // 2. Top of book.
    const ticker = await callJson(client, "fetch_ticker", {
      market_id: marketId,
    });
    console.log(`  ticker: ${JSON.stringify(ticker).slice(0, 200)}`);

    // 3. Depth: how much size rests near the touch?
    const book = await callJson(client, "fetch_order_book", {
      market_id: marketId,
    });
    console.log(
      `  book: ${book.bids?.length ?? 0} bid levels / ${book.asks?.length ?? 0} ask levels`,
    );

    // 4. Funding: what does it cost to hold a position?
    const funding = await callJson(client, "fetch_funding_rate_history", {
      market_id: marketId,
      limit: 3,
    });
    console.log(`  last funding: ${JSON.stringify(funding).slice(0, 200)}`);

    // 5. Risk parameters: margin requirements and max leverage.
    const risk = await callJson(client, "fetch_market_risk_params", {
      market_id: marketId,
    });
    console.log(`  risk params: ${JSON.stringify(risk).slice(0, 200)}`);

    // 6. Venue-wide context: volume and rolling unique traders.
    const stats = await callJson(client, "fetch_stats");
    console.log(`\nVenue stats: ${JSON.stringify(stats).slice(0, 300)}`);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error("example failed:", err);
  process.exit(1);
});
