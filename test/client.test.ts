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

/** Capture every fetch call (url + method + parsed JSON body) for a handler. */
async function captureCalls(
  run: (client: ExchangeClient) => Promise<unknown>,
): Promise<Array<{ url: string; method: string; body?: any }>> {
  const client = new ExchangeClient({
    baseUrl: "http://example.test",
    apiKey: "nx_test",
    apiSecret: "00",
  });
  const calls: Array<{ url: string; method: string; body?: any }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const raw = init.body
      ? Buffer.from(init.body as Uint8Array).toString("utf8")
      : undefined;
    calls.push({
      url,
      method: (init.method as string) ?? "GET",
      body: raw ? JSON.parse(raw) : undefined,
    });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    await run(client);
  } finally {
    globalThis.fetch = realFetch;
  }
  return calls;
}

test("public market-data tools hit the right unsigned paths with query params", async () => {
  const candles = await captureCalls((c) =>
    findTool("get_candles")!.handler(c, {
      market_id: "BTC-USDX-PERP",
      timeframe: "5m",
      limit: 100,
    }),
  );
  assert.equal(candles.length, 1);
  assert.equal(candles[0].method, "GET");
  assert.equal(
    candles[0].url,
    "http://example.test/markets/BTC-USDX-PERP/candles?timeframe=5m&limit=100",
  );

  const trades = await captureCalls((c) =>
    findTool("get_trades")!.handler(c, { market_id: "ETH-USDX-PERP" }),
  );
  // No limit -> no query string.
  assert.equal(
    trades[0].url,
    "http://example.test/markets/ETH-USDX-PERP/trades",
  );

  const funding = await captureCalls((c) =>
    findTool("get_funding_history")!.handler(c, {
      market_id: "BTC-USDX-PERP",
      limit: 5,
    }),
  );
  assert.equal(
    funding[0].url,
    "http://example.test/markets/BTC-USDX-PERP/funding?limit=5",
  );

  const mark = await captureCalls((c) =>
    findTool("get_mark_price")!.handler(c, { market_id: "BTC-USDX-PERP" }),
  );
  assert.equal(
    mark[0].url,
    "http://example.test/markets/BTC-USDX-PERP/mark-price",
  );
});

test("get_order and get_adl_history encode path segments and forward limit", async () => {
  const order = await captureCalls((c) =>
    findTool("get_order")!.handler(c, { order_id: "abc/123" }),
  );
  assert.equal(order[0].method, "GET");
  assert.equal(order[0].url, "http://example.test/orders/abc%2F123");

  const adl = await captureCalls((c) =>
    findTool("get_adl_history")!.handler(c, { address: "0xABC", limit: 10 }),
  );
  assert.equal(
    adl[0].url,
    "http://example.test/account/0xABC/adl-history?limit=10",
  );
});

test("get_fills / get_withdrawals / get_rate_limit_status sign their requests", async () => {
  for (const name of [
    "get_fills",
    "get_withdrawals",
    "get_rate_limit_status",
  ]) {
    const client = new ExchangeClient({ baseUrl: "http://example.test" });
    await assert.rejects(
      () => findTool(name)!.handler(client, {}) as Promise<unknown>,
      MissingCredentialsError,
      `${name} should require credentials`,
    );
  }
});

test("get_ws_token POSTs to /ws-tokens and is signed", async () => {
  const calls = await captureCalls((c) =>
    findTool("get_ws_token")!.handler(c, {}),
  );
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, "http://example.test/ws-tokens");

  const client = new ExchangeClient({ baseUrl: "http://example.test" });
  await assert.rejects(
    () => findTool("get_ws_token")!.handler(client, {}) as Promise<unknown>,
    MissingCredentialsError,
  );
});

test("place_orders_batch maps each order to the engine wire shape", async () => {
  const calls = await captureCalls((c) =>
    findTool("place_orders_batch")!.handler(c, {
      orders: [
        {
          market_id: "BTC-USDX-PERP",
          side: "buy",
          type: "limit",
          size: "0.5",
          price: "60000",
        },
        {
          market_id: "ETH-USDX-PERP",
          side: "sell",
          type: "market",
          size: "2",
        },
      ],
    }),
  );
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, "http://example.test/orders/batch");
  assert.deepEqual(calls[0].body, [
    {
      market_id: "BTC-USDX-PERP",
      side: "Buy",
      order_type: "Limit",
      quantity: "0.5",
      time_in_force: "GTC",
      price: "60000",
    },
    {
      market_id: "ETH-USDX-PERP",
      side: "Sell",
      order_type: "Market",
      quantity: "2",
      time_in_force: "IOC",
    },
  ]);
});

test("place_orders_batch rejects an empty list and limit orders missing price", () => {
  const tool = findTool("place_orders_batch")!;
  assert.equal(tool.zod.safeParse({ orders: [] }).success, false);
  assert.equal(
    tool.zod.safeParse({
      orders: [
        { market_id: "BTC-USDX-PERP", side: "buy", type: "limit", size: "1" },
      ],
    }).success,
    false,
  );
});

test("order schema rejects non-positive / non-decimal size", () => {
  const tool = findTool("place_order")!;
  const base = {
    market_id: "BTC-USDX-PERP",
    side: "buy",
    type: "market",
  } as const;
  // "0", negative, and non-numeric sizes are all rejected.
  for (const size of ["0", "0.0", "-1", "-0.5", "abc", "1e3", ""]) {
    assert.equal(
      tool.zod.safeParse({ ...base, size }).success,
      false,
      `size ${JSON.stringify(size)} should be rejected`,
    );
  }
  // Valid positive decimals are accepted.
  for (const size of ["1", "0.5", "100", "0.0001"]) {
    assert.equal(
      tool.zod.safeParse({ ...base, size }).success,
      true,
      `size ${JSON.stringify(size)} should be accepted`,
    );
  }
});

test("order schema rejects non-positive / non-decimal price", () => {
  const tool = findTool("place_order")!;
  const base = {
    market_id: "BTC-USDX-PERP",
    side: "buy",
    type: "limit",
    size: "1",
  } as const;
  for (const price of ["0", "-5", "abc"]) {
    assert.equal(
      tool.zod.safeParse({ ...base, price }).success,
      false,
      `price ${JSON.stringify(price)} should be rejected`,
    );
  }
  assert.equal(tool.zod.safeParse({ ...base, price: "60000" }).success, true);
});

test("place_orders_batch enforces the max-length bound", () => {
  const tool = findTool("place_orders_batch")!;
  const order = {
    market_id: "BTC-USDX-PERP",
    side: "buy",
    type: "market",
    size: "1",
  };
  // 100 orders is the documented cap (MAX_BATCH_ORDERS) — accepted.
  assert.equal(
    tool.zod.safeParse({ orders: Array(100).fill(order) }).success,
    true,
  );
  // 101 orders exceeds the cap — rejected.
  assert.equal(
    tool.zod.safeParse({ orders: Array(101).fill(order) }).success,
    false,
  );
  // The advertised JSON Schema mirrors the bound.
  assert.equal((tool.inputSchema as any).properties.orders.maxItems, 100);
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
