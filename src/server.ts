/**
 * Nexus Exchange MCP server (transport-agnostic).
 *
 * Exposes the exchange's market-data and trading surface as MCP tools so an
 * AI agent (Claude Desktop / Claude Code) can read markets and place trades.
 *
 * createServer() takes the ExchangeClient to use, so the caller owns credential
 * selection: index.ts (stdio) passes one env-derived client; http.ts (hosted)
 * passes a fresh per-request client built from the caller's Authorization
 * header, so each agent acts as itself.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { ExchangeClient } from "./client.js";
import { findTool, tools } from "./tools/index.js";

export function createServer(client: ExchangeClient): Server {
  const server = new Server(
    { name: "nexus-exchange-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = findTool(req.params.name);
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
        content: [{ type: "text", text: `Error calling ${tool.name}: ${message}` }],
      };
    }
  });

  return server;
}
