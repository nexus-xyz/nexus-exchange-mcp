#!/usr/bin/env node
/**
 * Entry point for the hosted Streamable HTTP MCP server. Listens on
 * `MCP_HTTP_PORT` (default 8080) and serves the MCP endpoint at `/mcp`
 * (override with `MCP_HTTP_PATH`), plus a `/healthz` liveness probe.
 *
 * Behind a TLS-terminating ingress this is the public front door at
 * `https://mcp.exchange.nexus.xyz/mcp`. See src/http.ts for the transport and
 * credential model (header-based, no OAuth in this MVP).
 */

import { createHttpMcpServer } from "./http.js";

const port = Number(process.env.MCP_HTTP_PORT ?? "8080");
const path = process.env.MCP_HTTP_PATH ?? "/mcp";

const server = createHttpMcpServer({ path });

server.listen(port, () => {
  console.error(
    `nexus-exchange-mcp-http: listening on :${port}, MCP endpoint ${path}`,
  );
});

function shutdown(signal: string): void {
  console.error(`nexus-exchange-mcp-http: received ${signal}, shutting down`);
  server.close(() => process.exit(0));
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
