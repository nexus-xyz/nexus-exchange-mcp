#!/usr/bin/env node
/**
 * Entry point for the Nexus Exchange MCP server. Connects the server to the
 * stdio transport and runs until the client disconnects.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { withStoredCredentials } from "./store.js";

async function main(): Promise<void> {
  // `--read-only` / `--paper` are the env switches spelled as flags, for MCP
  // client configs that pass args more readily than env (ENG-20366).
  const env = { ...process.env };
  const args = process.argv.slice(2);
  if (args.includes("--read-only")) env.NEXUS_EXCHANGE_READ_ONLY = "1";
  if (args.includes("--paper")) env.NEXUS_EXCHANGE_PAPER = "1";
  // Env first, then the Nexus CLI's config file for whatever env left unset.
  const server = createServer(withStoredCredentials(loadConfig(env)));
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr so we never corrupt the stdio JSON-RPC stream on stdout.
  console.error("nexus-exchange-mcp: ready on stdio");
}

main().catch((err) => {
  console.error("nexus-exchange-mcp: fatal", err);
  process.exit(1);
});
