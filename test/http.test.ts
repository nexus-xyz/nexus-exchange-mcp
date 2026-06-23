import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { buildHttpServer, credentialsFromAuth } from "../src/http.js";

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

/** Read a single JSON-RPC response whether the transport replied with plain
 *  JSON or a one-shot Streamable-HTTP SSE frame. */
async function readJsonRpc(res: Response): Promise<any> {
  const text = await res.text();
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
    assert.ok(dataLine, `no SSE data frame in response: ${text}`);
    return JSON.parse(dataLine.slice("data:".length).trim());
  }
  return JSON.parse(text);
}

test("credentialsFromAuth parses Bearer <id>:<secret>", () => {
  assert.deepEqual(credentialsFromAuth("Bearer nx_key:deadbeef"), {
    apiKey: "nx_key",
    apiSecret: "deadbeef",
  });
  assert.deepEqual(credentialsFromAuth(undefined), {});
  assert.deepEqual(credentialsFromAuth("Bearer no-colon"), {});
  assert.deepEqual(credentialsFromAuth("Bearer :secret"), {});
  assert.deepEqual(credentialsFromAuth("Bearer id:"), {});
});

test("GET /healthz returns ok", async () => {
  const server = buildHttpServer({});
  const port = await listen(server);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ok" });
  } finally {
    server.close();
  }
});

test("POST /mcp initialize returns the Nexus server info (no creds needed)", async () => {
  const server = buildHttpServer({});
  const port = await listen(server);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "http-test", version: "0.0.0" },
        },
      }),
    });
    assert.equal(res.status, 200);
    const payload = await readJsonRpc(res);
    assert.equal(payload.result.serverInfo.name, "nexus-exchange-mcp");
    assert.ok(payload.result.capabilities.tools, "advertises the tools capability");
  } finally {
    server.close();
  }
});

test("unknown path returns 404", async () => {
  const server = buildHttpServer({});
  const port = await listen(server);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/nope`);
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test("GET /mcp is rejected (POST-only in stateless mode)", async () => {
  const server = buildHttpServer({});
  const port = await listen(server);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`);
    assert.equal(res.status, 405);
  } finally {
    server.close();
  }
});
