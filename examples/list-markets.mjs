// Minimal standalone MCP client for the Nexus Exchange MCP server.
//
// It spawns the built server (dist/index.js) over stdio — exactly how a real
// MCP client like Claude Desktop launches it — then lists the available tools
// and calls `list_markets`, printing the results.
//
// Run `npm run build` first, then: node examples/list-markets.mjs
//
// Like the in-process smoke check (scripts/smoke.ts), this talks to the
// configured exchange gateway (production by default), so it needs network
// access. Gateway config is read from the environment by the server itself
// (see .env.example).

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, "..", "dist", "index.js");

async function main() {
  // Spawn the built server as a subprocess and speak MCP over its stdio.
  const transport = new StdioClientTransport({
    command: process.execPath, // the current `node` binary
    args: [serverEntry],
    env: process.env,
  });

  const client = new Client(
    { name: "list-markets-example", version: "0.0.0" },
    { capabilities: {} },
  );

  await client.connect(transport);

  try {
    const { tools } = await client.listTools();
    console.log(`Connected. ${tools.length} tools available:`);
    for (const tool of tools) {
      console.log(`  - ${tool.name}`);
    }

    console.log("\nCalling list_markets...");
    const res = await client.callTool({
      name: "list_markets",
      arguments: {},
    });

    const text = res.content?.[0]?.text ?? "";
    if (res.isError) {
      console.error("list_markets failed:");
      console.error(text);
      process.exitCode = 1;
      return;
    }

    let markets;
    try {
      markets = JSON.parse(text);
    } catch {
      console.log(text.slice(0, 600));
      return;
    }

    if (Array.isArray(markets)) {
      console.log(`Got ${markets.length} markets. First few:`);
      for (const m of markets.slice(0, 5)) {
        console.log(`  ${JSON.stringify(m)}`);
      }
    } else {
      console.log(JSON.stringify(markets, null, 2).slice(0, 600));
    }
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error("example failed:", err);
  process.exit(1);
});
