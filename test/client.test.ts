import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { ExchangeClient, MissingCredentialsError } from "../src/client.js";
import { findTool, tools } from "../src/tools/index.js";

/**
 * Reference HMAC implementation that mirrors the indexer's verify_hmac
 * (backend/services/indexer/src/auth.rs): 5-line canonical string
 * `<ts>\n<METHOD>\n<path>\n<query>\n<sha256hex(body)>` signed with the
 * hex-decoded secret. We assert the client signs requests that this
 * reference verifier accepts.
 */
function referenceSign(
  secretHex: string,
  ts: string,
  method: string,
  path: string,
  query: string,
  body: Buffer,
): string {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const canonical = [ts, method.toUpperCase(), path, query, bodyHash].join(
    "\n",
  );
  return createHmac("sha256", Buffer.from(secretHex, "hex"))
    .update(canonical)
    .digest("hex");
}

test("signs requests with the indexer's canonical HMAC scheme", async () => {
  const secretHex =
    "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
  const cfg = {
    baseUrl: "http://example.test",
    apiKey: "nx_test",
    apiSecret: secretHex,
  };
  const client = new ExchangeClient(cfg);

  let captured: { url: string; headers: Headers; body?: Buffer } | undefined;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    captured = {
      url,
      headers: new Headers(init.headers),
      body: init.body ? Buffer.from(init.body as Uint8Array) : undefined,
    };
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    await client.request({
      method: "POST",
      path: "/orders",
      body: {
        market_id: "BTC-USDX-PERP",
        side: "Buy",
        order_type: "Limit",
        quantity: "1",
        price: "50000",
        time_in_force: "GTC",
      },
      signed: true,
    });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.ok(captured, "fetch was called");
  const ts = captured!.headers.get("x-timestamp")!;
  assert.equal(captured!.headers.get("x-api-key"), "nx_test");
  const expected = referenceSign(
    secretHex,
    ts,
    "POST",
    "/orders",
    "",
    captured!.body!,
  );
  assert.equal(captured!.headers.get("x-signature"), expected);
  assert.equal(captured!.url, "http://example.test/orders");
});

test("signed tool without credentials throws MissingCredentialsError", async () => {
  const client = new ExchangeClient({ baseUrl: "http://example.test" });
  await assert.rejects(
    () => client.request({ path: "/account", signed: true }),
    MissingCredentialsError,
  );
});

test("place_order maps friendly args to the engine wire shape", async () => {
  const tool = findTool("place_order")!;
  const client = new ExchangeClient({
    baseUrl: "http://example.test",
    apiKey: "nx_test",
    apiSecret: "00",
  });

  let body: any;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    body = JSON.parse(Buffer.from(init.body as Uint8Array).toString("utf8"));
    return new Response('{"ok":true}', { status: 200 });
  }) as typeof fetch;
  try {
    await tool.handler(client, {
      market_id: "BTC-USDX-PERP",
      side: "buy",
      type: "limit",
      size: "0.5",
      price: "60000",
    });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.deepEqual(body, {
    market_id: "BTC-USDX-PERP",
    side: "Buy",
    order_type: "Limit",
    quantity: "0.5",
    time_in_force: "GTC",
    price: "60000",
  });
});

test("cancel_order builds the single-cancel and cancel-all URLs", async () => {
  const tool = findTool("cancel_order")!;
  const client = new ExchangeClient({
    baseUrl: "http://example.test",
    apiKey: "nx_test",
    apiSecret: "00",
  });

  const calls: Array<{ url: string; method: string }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method as string });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    // (a) single cancel: /orders/<encoded id>?market_id=... — id is encoded.
    await tool.handler(client, {
      order_id: "abc/123",
      market_id: "BTC-USDX-PERP",
    });
    // (b) cancel-all: /orders with no id and no query.
    await tool.handler(client, {});
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, "DELETE");
  assert.equal(
    calls[0].url,
    "http://example.test/orders/abc%2F123?market_id=BTC-USDX-PERP",
  );
  assert.equal(calls[1].method, "DELETE");
  assert.equal(calls[1].url, "http://example.test/orders");
});

test("get_candles maps market_id + interval + limit to the candles URL", async () => {
  const tool = findTool("get_candles")!;
  const client = new ExchangeClient({ baseUrl: "http://example.test" });

  let url: string | undefined;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (u: string) => {
    url = u;
    return new Response("[]", { status: 200 });
  }) as typeof fetch;
  try {
    await tool.handler(client, {
      market_id: "BTC-USDX-PERP",
      interval: "1h",
      limit: 100,
    });
  } finally {
    globalThis.fetch = realFetch;
  }

  // Friendly `interval` arg maps to the gateway `timeframe` query param.
  assert.equal(
    url,
    "http://example.test/markets/BTC-USDX-PERP/candles?timeframe=1h&limit=100",
  );
});

test("get_funding_payments builds filtered and unfiltered URLs", async () => {
  const tool = findTool("get_funding_payments")!;
  const client = new ExchangeClient({
    baseUrl: "http://example.test",
    apiKey: "nx_test",
    apiSecret: "00",
  });

  const urls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (u: string) => {
    urls.push(u);
    return new Response("[]", { status: 200 });
  }) as typeof fetch;
  try {
    await tool.handler(client, { market_id: "BTC-USDX-PERP" });
    await tool.handler(client, {});
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(
    urls[0],
    "http://example.test/funding-payments?market_id=BTC-USDX-PERP",
  );
  assert.equal(urls[1], "http://example.test/funding-payments");
});

test("limit order without price is rejected by schema", () => {
  const tool = findTool("place_order")!;
  const parsed = tool.zod.safeParse({
    market_id: "BTC-USDX-PERP",
    side: "buy",
    type: "limit",
    size: "1",
  });
  assert.equal(parsed.success, false);
});

test("pending tools return an honest not-yet-available message", async () => {
  const client = new ExchangeClient({ baseUrl: "http://example.test" });
  const deposit = (await findTool("get_deposit_target")!.handler(
    client,
    {},
  )) as any;
  assert.equal(deposit.status, "not_yet_available");

  const agent = (await findTool("register_agent")!.handler(client, {})) as any;
  assert.equal(agent.status, "not_yet_available");
});

test("every tool advertises a name, description, and object input schema", () => {
  for (const t of tools) {
    assert.ok(t.name.length > 0, "name");
    assert.ok(t.description.length > 0, `${t.name} description`);
    assert.equal(
      (t.inputSchema as any).type,
      "object",
      `${t.name} schema type`,
    );
  }
});
