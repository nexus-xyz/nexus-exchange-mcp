#!/usr/bin/env node
/**
 * Entry point for the Nexus Exchange MCP server. Connects the server to the
 * stdio transport and runs until the client disconnects.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr so we never corrupt the stdio JSON-RPC stream on stdout.
  console.error("nexus-exchange-mcp: ready on stdio");
}

main().catch((err) => {
  console.error("nexus-exchange-mcp: fatal", err);
  process.exit(1);
});
