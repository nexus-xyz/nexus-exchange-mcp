/**
 * Integration smoke test: drive the hosted server with a real MCP *client*
 * over the Streamable HTTP transport — initialize → tools/list → callTool —
 * the same path an agent (Claude) would take, but deterministic and free
 * (no LLM, no network). The server's upstream gateway calls are routed to a
 * mock; the client↔server traffic hits the real local server.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildHttpServer } from "../src/http.js";

function listen(server: Server): Promise<number> {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
  );
}

test("MCP client lists tools and calls list_markets end-to-end over Streamable HTTP", async () => {
  const realFetch = globalThis.fetch;
  // Pass MCP client↔server traffic through to the real local server; serve the
  // server's upstream gateway call from a deterministic mock.
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : (input?.url ?? String(input));
    if (url.startsWith("http://127.0.0.1:")) return realFetch(input, init);
    if (url.includes("/markets/summary")) {
      return new Response(
        JSON.stringify([{ market_id: "BTC-USDX-PERP" }, { market_id: "ETH-USDX-PERP" }]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const server = buildHttpServer({});
  const port = await listen(server);
  const client = new Client({ name: "integration-smoke", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));

  try {
    await client.connect(transport);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    assert.ok(names.includes("list_markets"), "advertises list_markets");
    assert.ok(names.includes("place_order"), "advertises place_order");

    const res = (await client.callTool({ name: "list_markets", arguments: {} })) as {
      content: { type: string; text?: string }[];
    };
    const text = res.content.map((c) => c.text ?? "").join("");
    assert.match(text, /BTC-USDX-PERP/);
  } finally {
    await client.close().catch(() => {});
    server.close();
    globalThis.fetch = realFetch;
  }
});
