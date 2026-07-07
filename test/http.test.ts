import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  API_KEY_HEADER,
  API_SECRET_HEADER,
  HTTP_USER_AGENT,
  configForRequest,
  createHttpMcpServer,
} from "../src/http.js";
import { visibleTools } from "../src/tools/index.js";

/**
 * Boot the hosted HTTP MCP server on an ephemeral port and connect a real MCP
 * client over the Streamable HTTP transport. `headers` are sent on every
 * request (this is how the MVP passes the caller's Exchange HMAC credential).
 * Returns the connected client, its base URL, and a teardown fn.
 */
async function withHttpServer(
  headers: Record<string, string>,
): Promise<{ client: Client; url: URL; close: () => Promise<void> }> {
  const server = createHttpMcpServer({
    config: {
      directBaseUrl: "http://gateway.test",
      gatewayBaseUrl: "http://gateway.test",
    },
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  const url = new URL(`http://127.0.0.1:${port}/mcp`);

  const client = new Client(
    { name: "http-test", version: "0.0.0" },
    { capabilities: {} },
  );
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers },
  });
  await client.connect(transport);

  return {
    client,
    url,
    close: async () => {
      await client.close();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}

test("Streamable HTTP: tools/list returns the full shared tool surface", async () => {
  const { client, close } = await withHttpServer({});
  try {
    const list = await client.listTools();
    const got = new Set(list.tools.map((t) => t.name));
    // Same surface the stdio server exposes for this config — assert parity,
    // not a fixed count. The hosted session leaves admin tools off (the test
    // config doesn't enable them), so compare against the visible set rather
    // than every ToolDef, including the admin-only ones.
    const expected = visibleTools({ enableAdminTools: false });
    assert.equal(list.tools.length, expected.length);
    for (const t of expected) {
      assert.ok(got.has(t.name), `missing tool over HTTP: ${t.name}`);
    }
  } finally {
    await close();
  }
});

test("Streamable HTTP: a public tool call reaches the gateway and returns its result", async () => {
  // Intercept the upstream gateway fetch so the test is hermetic.
  const calls: Array<{ url: string; headers: Headers }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const u = String(input);
    // Only intercept the upstream gateway; let the loopback MCP HTTP traffic
    // (the SDK client → our server) use the real fetch.
    if (u.startsWith("http://gateway.test")) {
      calls.push({ url: u, headers: new Headers(init.headers) });
      return new Response(JSON.stringify([{ market_id: "BTC-USDX-PERP" }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return realFetch(input as never, init);
  }) as typeof fetch;

  const { client, close } = await withHttpServer({});
  try {
    const res = (await client.callTool({
      name: "list_markets",
      arguments: {},
    })) as { isError?: boolean; content: Array<{ text?: string }> };

    assert.notEqual(res.isError, true);
    const parsed = JSON.parse(res.content[0]!.text!);
    assert.deepEqual(parsed, [{ market_id: "BTC-USDX-PERP" }]);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://gateway.test/api/v1/markets/summary");
    // Hosted traffic is tagged so the dashboard can attribute it to MCP.
    assert.equal(calls[0].headers.get("user-agent"), HTTP_USER_AGENT);
  } finally {
    globalThis.fetch = realFetch;
    await close();
  }
});

test("Streamable HTTP: per-session credential headers sign the upstream request", async () => {
  const secretHex =
    "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
  const calls: Array<{ url: string; headers: Headers; body?: string }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const u = String(input);
    if (u.startsWith("http://gateway.test")) {
      calls.push({
        url: u,
        headers: new Headers(init.headers),
        body: init.body ? Buffer.from(init.body as Uint8Array).toString() : "",
      });
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return realFetch(input as never, init);
  }) as typeof fetch;

  const { client, close } = await withHttpServer({
    [API_KEY_HEADER]: "nx_session_key",
    [API_SECRET_HEADER]: secretHex,
  });
  try {
    // A signed (auth-required) tool: the session must forward an HMAC built
    // from the credential the caller passed in headers at initialize.
    await client.callTool({ name: "get_balance", arguments: {} });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://gateway.test/api/v1/account");
    assert.equal(calls[0].headers.get("x-api-key"), "nx_session_key");
    const ts = calls[0].headers.get("x-timestamp")!;
    const sig = calls[0].headers.get("x-signature")!;
    assert.ok(ts, "timestamp header present");

    // Recompute the canonical signature the indexer would verify. get_balance
    // targets the /api/v1 surface, so the signed path carries the prefix.
    const canonical = [
      ts,
      "GET",
      "/api/v1/account",
      "",
      EMPTY_BODY_SHA256,
    ].join("\n");
    const expected = createHmac("sha256", Buffer.from(secretHex, "hex"))
      .update(canonical)
      .digest("hex");
    assert.equal(sig, expected, "session credential signed the request");
  } finally {
    globalThis.fetch = realFetch;
    await close();
  }
});

// sha256("") — the body hash for a no-body GET in the canonical string.
const EMPTY_BODY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

test("configForRequest overlays header credentials and tags the User-Agent", () => {
  const base = {
    directBaseUrl: "http://gateway.test",
    gatewayBaseUrl: "http://gateway.test",
    apiKey: "env",
    apiSecret: "e",
  };
  // Header credentials win over env credentials.
  const withHeaders = configForRequest(base, {
    headers: {
      [API_KEY_HEADER]: "hdr_key",
      [API_SECRET_HEADER]: "hdr_secret",
    },
  } as never);
  assert.equal(withHeaders.apiKey, "hdr_key");
  assert.equal(withHeaders.apiSecret, "hdr_secret");
  assert.equal(withHeaders.userAgent, HTTP_USER_AGENT);

  // With no headers, fall back to base (env) credentials.
  const noHeaders = configForRequest(base, { headers: {} } as never);
  assert.equal(noHeaders.apiKey, "env");
  assert.equal(noHeaders.apiSecret, "e");
  assert.equal(noHeaders.userAgent, HTTP_USER_AGENT);
});
