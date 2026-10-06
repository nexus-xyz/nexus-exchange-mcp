// Full circle on testnet: from NO account to a closed position, through MCP
// tools alone. No browser, no credentials in the environment, no restart.
//
// Auth tier: NONE TO START (PLACES REAL TESTNET ORDERS WITH A NEW WALLET).
//
//   1. create_wallet    -> the server makes a wallet key and keeps it
//   2. login            -> no `signature`: the server signs with that wallet
//   3. create_api_key   -> the server keeps the new HMAC key for this session
//   4. claim_faucet     -> synthetic USDX for the new account
//      fetch_balance    -> confirm the credit landed
//   5. create_order     -> tiny market buy (opens the position)
//      fetch_positions  -> observe it
//   6. create_order     -> reduce_only market sell (closes it)
//      fetch_positions  -> observe it closed
//
// The server keeps the wallet, session token and key in the Nexus CLI config
// file. This script points it at a fresh temp directory (XDG_CONFIG_HOME), so
// your own ~/.config/nexus/config.json is never read or written, and it drops
// any NEXUS_EXCHANGE_* credentials from the server's environment so the new
// wallet's key is the one in use. Each run leaves one funded testnet account
// behind. On success the temp directory is deleted; on failure it is kept and
// printed, so the account can still be reached.
//
// Optional: EXAMPLE_MARKET_ID (default BTC-USDX-PERP), EXAMPLE_ORDER_SIZE
// (default 0.001), NEXUS_EXCHANGE_NETWORK (default testnet; any play-funds
// target with a faucet works, e.g. `local`).
//
// Run `npm run build` first, then: node examples/full-circle.mjs

import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, "..", "dist", "index.js");

const MARKET = process.env.EXAMPLE_MARKET_ID ?? "BTC-USDX-PERP";
const SIZE = process.env.EXAMPLE_ORDER_SIZE ?? "0.001";

/** Call a tool and parse its JSON text content; throw on tool errors. */
async function callJson(client, name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  if (res.isError) throw new Error(`${name} failed: ${text}`);
  return JSON.parse(text);
}

const short = (v) => JSON.stringify(v).slice(0, 250);

async function main() {
  const configHome = mkdtempSync(join(tmpdir(), "nexus-full-circle-"));
  const env = { ...process.env, XDG_CONFIG_HOME: configHome };
  for (const name of [
    "NEXUS_EXCHANGE_API_KEY",
    "NEXUS_EXCHANGE_API_SECRET",
    "NEXUS_EXCHANGE_SESSION_TOKEN",
    "NEXUS_EXCHANGE_PRIVATE_KEY",
  ]) {
    delete env[name];
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env,
  });
  const client = new Client(
    { name: "full-circle-example", version: "0.0.0" },
    { capabilities: {} },
  );
  await client.connect(transport);

  let opened = false;
  let ok = false;
  try {
    // 1. A wallet of the server's own. Only the address comes back.
    const wallet = await callJson(client, "create_wallet");
    console.log(`1. wallet ${wallet.address} (saved to ${wallet.saved_to})`);

    // 2. Sign in. With no `signature` the server signs the fixed login
    //    message with the wallet from step 1 and keeps the session token.
    const login = await callJson(client, "login");
    if (!login?.token)
      throw new Error(`login returned no token: ${short(login)}`);
    console.log("2. logged in, session token kept");

    // 3. Mint an HMAC key with that token. The server keeps it, so every
    //    account and trading tool below is signed with it.
    const key = await callJson(client, "create_api_key");
    console.log(`3. api key ${key.key_id} kept`);

    // 4. Fund the new account from the faucet, then confirm it landed.
    const faucet = await callJson(client, "claim_faucet");
    console.log(`4. faucet: ${short(faucet)}`);
    const balance = await callJson(client, "fetch_balance");
    console.log(`   balance: ${short(balance)}`);

    // 5. Open: a tiny market buy (IOC by default, so nothing rests).
    const entry = await callJson(client, "create_order", {
      market_id: MARKET,
      side: "buy",
      type: "market",
      size: SIZE,
    });
    opened = true;
    console.log(`5. entry order: ${short(entry)}`);
    console.log(
      `   positions: ${short(await callJson(client, "fetch_positions"))}`,
    );

    // 6. Close: reduce_only can only shrink the position, never flip it.
    const exit = await callJson(client, "create_order", {
      market_id: MARKET,
      side: "sell",
      type: "market",
      size: SIZE,
      reduce_only: true,
    });
    opened = false;
    console.log(`6. exit order: ${short(exit)}`);
    console.log(
      `   positions: ${short(await callJson(client, "fetch_positions"))}`,
    );

    console.log(
      "\nFull circle: wallet -> login -> key -> faucet -> trade -> close.",
    );
    ok = true;
  } finally {
    await client.close();
    if (ok) {
      rmSync(configHome, { recursive: true, force: true });
    } else {
      console.error(
        `Kept the new account's credentials in ${configHome}. To reach it, ` +
          `run the server with XDG_CONFIG_HOME=${configHome}.` +
          (opened
            ? ` The ${SIZE} ${MARKET} position may still be open: place a ` +
              `reduce_only market sell of ${SIZE} to close it.`
            : ""),
      );
    }
  }
}

main().catch((err) => {
  console.error("example failed:", err);
  process.exit(1);
});
