/**
 * Nexus Exchange MCP server wiring, shared across transports.
 *
 * The tool surface (`ToolDef[]` in ./tools) is registered once here and reused
 * by every transport — stdio (src/index.ts) and the hosted Streamable HTTP
 * server (src/http.ts) — so both expose exactly the same tools with identical
 * argument validation and error handling. Only the transport and how the
 * per-caller `ExchangeClient` is built differ between them.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loadConfig, PACKAGE_VERSION, type ExchangeConfig } from "./config.js";
import { ExchangeClient } from "./client.js";
import { findTool, visibleTools } from "./tools/index.js";

/** Package version, surfaced in the MCP server handshake. Single-sourced from
 * {@link PACKAGE_VERSION} so it stays in step with the wire User-Agent. */
export const SERVER_VERSION = PACKAGE_VERSION;

/**
 * Build an MCP `Server` whose tool handlers run against the given client.
 *
 * The transport (stdio or Streamable HTTP) is attached by the caller via
 * `server.connect(transport)`. Both transports share this function, so the
 * tool surface and behavior never drift between them.
 */
export function createServerForClient(client: ExchangeClient): Server {
  // Tools advertised/callable for this client. Admin tools are hidden unless
  // explicitly enabled, so they never reach a general trading agent.
  const enabled = visibleTools({ enableAdminTools: client.enableAdminTools() });
  const enabledNames = new Set(enabled.map((t) => t.name));

  const server = new Server(
    { name: "nexus-exchange-mcp", version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: enabled.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = enabledNames.has(req.params.name)
      ? findTool(req.params.name)
      : undefined;
    if (!tool) {
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }],
      };
    }

    const parsed = tool.zod.safeParse(req.params.arguments ?? {});
    if (!parsed.success) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Invalid arguments for ${tool.name}: ${parsed.error.message}`,
          },
        ],
      };
    }

    try {
      const result = await tool.handler(client, parsed.data);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [
          { type: "text", text: `Error calling ${tool.name}: ${message}` },
        ],
      };
    }
  });

  return server;
}

/**
 * Build a server from environment config (the stdio entry point's path).
 * Credentials, if any, come from the process environment.
 */
export function createServer(config: ExchangeConfig = loadConfig()): Server {
  return createServerForClient(new ExchangeClient(config));
}
