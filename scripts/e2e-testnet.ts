/**
 * Full-circle E2E on testnet (ENG-19787): a new wallet to a closed position,
 * through MCP tools only. Drives the server in-process over the SDK's
 * in-memory transport, the same way `scripts/smoke.ts` does:
 *
 *   1. create_wallet            5. create_order, a small market buy
 *   2. login (self-signed)      6. fetch_positions shows it
 *   3. create_api_key           7. create_order reduce_only closes it
 *   4. claim_faucet, then       8. fetch_positions is flat
 *      fetch_balance shows it
 *
 * Run: npm run e2e:testnet   (uses tsx, no build needed)
 *
 * Every run starts from nothing: a clean environment (so no credential from the
 * caller's shell leaks in) and a temp config dir that is deleted at the end. So
 * it needs no secrets, and each run leaves one funded testnet account behind,
 * flat, with its faucet USDX. Any failed step exits non-zero, naming the step.
 *
 * Not part of `npm test`: it needs testnet up. `.github/workflows/testnet-e2e.yml`
 * runs it daily and on manual dispatch.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import { withStoredCredentials } from "../src/store.js";

// Balances and positions are read from mirrored state, so they lag a write.
const POLL_TRIES = 15;
const POLL_MS = 2000;

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "nexus-e2e-"));
  const env = { NEXUS_EXCHANGE_NETWORK: "testnet", XDG_CONFIG_HOME: dir };
  const server = createServer(withStoredCredentials(loadConfig(env), env));
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const mcp = new Client(
    { name: "e2e-testnet", version: "0.0.0" },
    { capabilities: {} },
  );
  await mcp.connect(clientTransport);

  let step = "";
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await mcp.callTool({ name, arguments: args });
    const text = (res.content as Array<{ text?: string }>)[0]?.text ?? "";
    if (res.isError) throw new Error(text);
    return JSON.parse(text);
  };
  const check = (ok: boolean, message: string) => {
    if (!ok) throw new Error(message);
  };
  const poll = async (
    name: string,
    done: (result: any) => boolean,
    what: string,
  ) => {
    let last: unknown;
    for (let i = 0; i < POLL_TRIES; i++) {
      last = await call(name);
      if (done(last)) return last as any;
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    throw new Error(
      `${what} not seen after ${(POLL_TRIES * POLL_MS) / 1000}s. Last ${name}: ` +
        JSON.stringify(last).slice(0, 600),
    );
  };
  const ok = (detail: string) => console.error(`ok   ${step}: ${detail}`);

  try {
    step = "1 create_wallet";
    const wallet = await call("create_wallet");
    check(/^0x[0-9a-fA-F]{40}$/.test(wallet.address), "no address returned");
    ok(wallet.address);

    step = "2 login";
    const login = await call("login");
    check(
      String(login.address).toLowerCase() === wallet.address.toLowerCase(),
      `logged in as ${login.address}, not ${wallet.address}`,
    );
    ok("self-signed");

    step = "3 create_api_key";
    const key = await call("create_api_key");
    check(typeof key.key_id === "string", "no key_id returned");
    ok(key.key_id);

    step = "4 claim_faucet";
    const faucet = await call("claim_faucet");
    const credit = Number(faucet.amount);
    check(credit > 0, `faucet credited ${faucet.amount}`);
    ok(`${faucet.amount} USDX`);

    step = "4 fetch_balance";
    // A fresh account starts at zero, so the credit is the whole balance.
    const balance = await poll(
      "fetch_balance",
      (b) => Number(b.balance) >= credit,
      `a balance of at least ${credit}`,
    );
    ok(`balance ${balance.balance}`);

    step = "5 create_order (buy)";
    const markets: any[] = await call("fetch_markets_summary");
    // The cheapest minimum order among active markets.
    const market = markets
      .filter((m) => m.status === "active" && Number(m.engine_mark_price) > 0)
      .sort(
        (a, b) =>
          Number(a.min_order_size) * Number(a.engine_mark_price) -
          Number(b.min_order_size) * Number(b.engine_mark_price),
      )[0];
    check(market !== undefined, "no active market in fetch_markets_summary");
    const buy = await call("create_order", {
      market_id: market.market_id,
      side: "buy",
      type: "market",
      size: market.min_order_size,
    });
    check(
      Array.isArray(buy.fills) && buy.fills.length > 0,
      `market buy did not fill: ${JSON.stringify(buy).slice(0, 600)}`,
    );
    ok(`${market.min_order_size} ${market.market_id}, ${buy.order?.status}`);

    const open = (positions: any[]) =>
      positions.find(
        (p) => p.symbol === market.market_id && Number(p.size) !== 0,
      );

    step = "6 fetch_positions (open)";
    const positions = await poll("fetch_positions", open, "the open position");
    const position = open(positions);
    ok(`${position.side} ${position.size}`);

    step = "7 create_order (reduce_only sell)";
    const sell = await call("create_order", {
      market_id: market.market_id,
      side: "sell",
      type: "market",
      size: String(Math.abs(Number(position.size))),
      reduce_only: true,
    });
    check(
      Array.isArray(sell.fills) && sell.fills.length > 0,
      `reduce-only sell did not fill: ${JSON.stringify(sell).slice(0, 600)}`,
    );
    ok(String(sell.order?.status));

    step = "8 fetch_positions (flat)";
    await poll("fetch_positions", (p) => !open(p), "a flat position");
    ok(`flat on ${market.market_id}`);

    console.error(
      `\nPASS. Left behind on testnet: account ${wallet.address}, funded, flat.`,
    );
  } catch (err) {
    const message = `step ${step} failed: ${(err as Error).message}`;
    // An annotation on the run's summary page, so the failing step is the
    // first thing a reader sees.
    if (process.env.GITHUB_ACTIONS) console.log(`::error::${message}`);
    console.error(`FAIL ${message}`);
    process.exitCode = 1;
  } finally {
    await mcp.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`e2e failed: ${(err as Error).message}`);
  process.exit(1);
});
