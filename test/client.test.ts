import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  API_VERSION_HEADER,
  ExchangeApiError,
  ExchangeClient,
  MissingCredentialsError,
  sanitizeErrorBody,
} from "../src/client.js";
import { findTool, tools } from "../src/tools/index.js";
import {
  API_SPEC_VERSION,
  DEFAULT_USER_AGENT,
  PACKAGE_VERSION,
  deriveBases,
  loadConfig,
} from "../src/config.js";

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
    directBaseUrl: "http://example.test",
    gatewayBaseUrl: "http://example.test",
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

test("every upstream request carries X-Nexus-Api-Version + a normalized User-Agent", async () => {
  // The "done when" of ENG-5957: both headers are emitted by default on every
  // upstream request — public reads and signed writes alike.
  const client = new ExchangeClient({
    directBaseUrl: "http://example.test",
    gatewayBaseUrl: "http://example.test",
    apiKey: "nx_test",
    apiSecret: "00".repeat(32),
  });

  const seen: Headers[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    seen.push(new Headers(init.headers));
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    // (a) public, unsigned GET
    await client.request({ path: "/api/v1/markets/summary" });
    // (b) signed POST with a body
    await client.request({
      path: "/api/v1/orders",
      method: "POST",
      body: { market_id: "BTC-USDX-PERP" },
      signed: true,
    });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(seen.length, 2);
  for (const headers of seen) {
    assert.equal(
      headers.get(API_VERSION_HEADER),
      API_SPEC_VERSION,
      "compiled-against spec tag is sent",
    );
    assert.equal(
      headers.get("user-agent"),
      DEFAULT_USER_AGENT,
      "User-Agent is the normalized product token",
    );
  }
});

test("API_SPEC_VERSION equals the .api-version pin and is a valid tag", () => {
  // The wire header must never drift from the pin the drift check owns; keeping
  // it a compiled constant means a spec bump is a reviewed code change.
  const pinned = readFileSync(
    new URL("../.api-version", import.meta.url),
    "utf8",
  ).trim();
  assert.equal(API_SPEC_VERSION, pinned);
  assert.match(API_SPEC_VERSION, /^v\d+\.\d+\.\d+$/);
});

test("DEFAULT_USER_AGENT is the normalized nexus-exchange-mcp/<version> token", () => {
  assert.equal(DEFAULT_USER_AGENT, `nexus-exchange-mcp/${PACKAGE_VERSION}`);
  assert.match(DEFAULT_USER_AGENT, /^nexus-exchange-mcp\/\d+\.\d+\.\d+$/);
});

test("PACKAGE_VERSION stays in step with package.json", () => {
  // release-please bumps both package.json and the PACKAGE_VERSION line (via
  // extra-files) in the same release commit; this guards that they match, so a
  // broken annotation can't let the metered version silently fall behind.
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(PACKAGE_VERSION, pkg.version);
});

test("signed tool without credentials throws MissingCredentialsError", async () => {
  const client = new ExchangeClient({
    directBaseUrl: "http://example.test",
    gatewayBaseUrl: "http://example.test",
  });
  await assert.rejects(
    () => client.request({ path: "/account", signed: true }),
    MissingCredentialsError,
  );
});

test("place_order maps friendly args to the engine wire shape", async () => {
  const tool = findTool("place_order")!;
  const client = new ExchangeClient({
    directBaseUrl: "http://example.test",
    gatewayBaseUrl: "http://example.test",
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
    directBaseUrl: "http://example.test",
    gatewayBaseUrl: "http://example.test",
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
    // (b) explicit mass-cancel: /orders with no id and no query.
    await tool.handler(client, { cancel_all: true });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, "DELETE");
  assert.equal(
    calls[0].url,
    "http://example.test/api/v1/orders/abc%2F123?market_id=BTC-USDX-PERP",
  );
  assert.equal(calls[1].method, "DELETE");
  assert.equal(calls[1].url, "http://example.test/api/v1/orders");
});

test("cancel_order refuses to mass-cancel without an explicit cancel_all flag", async () => {
  const tool = findTool("cancel_order")!;
  const client = new ExchangeClient({
    directBaseUrl: "http://example.test",
    gatewayBaseUrl: "http://example.test",
    apiKey: "nx_test",
    apiSecret: "00",
  });

  let fetchCalled = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    // Argless call must throw, not mass-cancel.
    await assert.rejects(
      async () => tool.handler(client, {}),
      /cancel_all: true/,
    );
    // cancel_all: false is equally rejected.
    await assert.rejects(
      async () => tool.handler(client, { cancel_all: false }),
      /cancel_all: true/,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(fetchCalled, false, "no request should be sent");
});

test("cancel_order: order_id wins the tie-break when cancel_all is also true", async () => {
  // Tie-break safety: if both `order_id` and `cancel_all: true` are passed, the
  // narrower, less destructive action wins — we cancel only the named order and
  // ignore cancel_all. The guard must never escalate an ambiguous request into a
  // mass-cancel. This matches the tool description ("ignored when `order_id` is
  // given").
  const tool = findTool("cancel_order")!;
  const client = new ExchangeClient({
    directBaseUrl: "http://example.test",
    gatewayBaseUrl: "http://example.test",
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
    await tool.handler(client, {
      order_id: "abc/123",
      market_id: "BTC-USDX-PERP",
      cancel_all: true,
    });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "DELETE");
  // Single-cancel URL for the named order — NOT the mass-cancel `/orders`.
  assert.equal(
    calls[0].url,
    "http://example.test/api/v1/orders/abc%2F123?market_id=BTC-USDX-PERP",
  );
  assert.notEqual(
    calls[0].url,
    "http://example.test/api/v1/orders",
    "must not fall through to mass-cancel",
  );
});

test("sanitizeErrorBody bounds length and redacts secret-looking tokens", () => {
  // Bounding: long bodies are truncated well under the old 2000-char cap.
  const long = "x".repeat(5000);
  const bounded = sanitizeErrorBody(long);
  assert.ok(bounded.length < 600, "body is bounded");
  assert.ok(bounded.endsWith("[truncated]"), "truncation is marked");

  // Redaction: credential-shaped fields are scrubbed.
  const body =
    '{"error":"bad","api_key":"nx_live_abc123","signature":"deadbeef"}';
  const scrubbed = sanitizeErrorBody(body);
  assert.ok(!scrubbed.includes("nx_live_abc123"), "api_key redacted");
  assert.ok(!scrubbed.includes("deadbeef"), "signature redacted");
  assert.ok(scrubbed.includes("[REDACTED]"));
  assert.ok(scrubbed.includes("bad"), "non-secret content preserved");

  const bearer = sanitizeErrorBody("Authorization: Bearer abc.def.ghi");
  assert.ok(!bearer.includes("abc.def.ghi"), "bearer token redacted");
});

test("ExchangeApiError carries the sanitized, bounded body", async () => {
  const client = new ExchangeClient({
    directBaseUrl: "http://example.test",
    gatewayBaseUrl: "http://example.test",
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response('{"api_key":"nx_live_secret","msg":"nope"}', {
      status: 401,
    })) as typeof fetch;
  try {
    await assert.rejects(
      () => client.request({ path: "/markets/summary" }),
      (err: unknown) => {
        assert.ok(err instanceof ExchangeApiError);
        assert.equal(err.status, 401);
        assert.ok(!err.body.includes("nx_live_secret"), "secret scrubbed");
        assert.ok(err.body.includes("nope"), "message preserved");
        return true;
      },
    );
  } finally {
    globalThis.fetch = realFetch;
  }
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
    directBaseUrl: "http://example.test",
    gatewayBaseUrl: "http://example.test",
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
    "http://example.test/api/v1/markets/BTC-USDX-PERP/candles?timeframe=5m&limit=100",
  );

  const trades = await captureCalls((c) =>
    findTool("get_trades")!.handler(c, { market_id: "ETH-USDX-PERP" }),
  );
  // No limit -> no query string.
  assert.equal(
    trades[0].url,
    "http://example.test/api/v1/markets/ETH-USDX-PERP/trades",
  );

  const funding = await captureCalls((c) =>
    findTool("get_funding_history")!.handler(c, {
      market_id: "BTC-USDX-PERP",
      limit: 5,
    }),
  );
  assert.equal(
    funding[0].url,
    "http://example.test/api/v1/markets/BTC-USDX-PERP/funding?limit=5",
  );

  const mark = await captureCalls((c) =>
    findTool("get_mark_price")!.handler(c, { market_id: "BTC-USDX-PERP" }),
  );
  assert.equal(
    mark[0].url,
    "http://example.test/api/v1/markets/BTC-USDX-PERP/mark-price",
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
    const client = new ExchangeClient({
      directBaseUrl: "http://example.test",
      gatewayBaseUrl: "http://example.test",
    });
    await assert.rejects(
      () => findTool(name)!.handler(client, {}) as Promise<unknown>,
      MissingCredentialsError,
      `${name} should require credentials`,
    );
  }
});

test("get_ws_token POSTs to /ws/token and is signed", async () => {
  const calls = await captureCalls((c) =>
    findTool("get_ws_token")!.handler(c, {}),
  );
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, "http://example.test/ws/token");

  const client = new ExchangeClient({
    directBaseUrl: "http://example.test",
    gatewayBaseUrl: "http://example.test",
  });
  await assert.rejects(
    () => findTool("get_ws_token")!.handler(client, {}) as Promise<unknown>,
    MissingCredentialsError,
  );
});

test("get_ws_token_legacy POSTs to /ws-tokens and is signed", async () => {
  const calls = await captureCalls((c) =>
    findTool("get_ws_token_legacy")!.handler(c, {}),
  );
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, "http://example.test/ws-tokens");

  const client = new ExchangeClient({
    directBaseUrl: "http://example.test",
    gatewayBaseUrl: "http://example.test",
  });
  await assert.rejects(
    () =>
      findTool("get_ws_token_legacy")!.handler(client, {}) as Promise<unknown>,
    MissingCredentialsError,
  );
});

test("get_funding_payments builds filtered and unfiltered signed URLs", async () => {
  // Spec route is GET /funding (fetchAccountFunding) — the old
  // /funding-payments path never existed server-side.
  const calls = await captureCalls(async (c) => {
    await findTool("get_funding_payments")!.handler(c, {
      market_id: "BTC-USDX-PERP",
      limit: 25,
    });
    await findTool("get_funding_payments")!.handler(c, {});
  });

  assert.equal(
    calls[0].url,
    "http://example.test/funding?market_id=BTC-USDX-PERP&limit=25",
  );
  assert.equal(calls[1].url, "http://example.test/funding");

  const client = new ExchangeClient({
    directBaseUrl: "http://example.test",
    gatewayBaseUrl: "http://example.test",
  });
  await assert.rejects(
    () =>
      findTool("get_funding_payments")!.handler(client, {}) as Promise<unknown>,
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
  assert.equal(calls[0].url, "http://example.test/api/v1/orders/batch");
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
  const client = new ExchangeClient({
    directBaseUrl: "http://example.test",
    gatewayBaseUrl: "http://example.test",
  });
  const deposit = (await findTool("get_deposit_target")!.handler(
    client,
    {},
  )) as any;
  assert.equal(deposit.status, "not_yet_available");
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

test("deriveBases splits an origin into direct (/api/v1) and gateway bases", () => {
  // Bare origin (the new default form).
  assert.deepEqual(deriveBases("https://exchange.nexus.xyz"), {
    directBaseUrl: "https://exchange.nexus.xyz",
    gatewayBaseUrl: "https://exchange.nexus.xyz/api/exchange",
  });
  // Legacy value that still carries the /api/exchange suffix is normalized so
  // /api/v1 does not resolve to …/api/exchange/api/v1/… .
  assert.deepEqual(deriveBases("https://exchange.nexus.xyz/api/exchange"), {
    directBaseUrl: "https://exchange.nexus.xyz",
    gatewayBaseUrl: "https://exchange.nexus.xyz/api/exchange",
  });
  // Trailing slashes are trimmed before deriving.
  assert.deepEqual(deriveBases("http://localhost:9090/"), {
    directBaseUrl: "http://localhost:9090",
    gatewayBaseUrl: "http://localhost:9090/api/exchange",
  });
});

test("loadConfig derives both bases from NEXUS_EXCHANGE_API_URL", () => {
  const cfg = loadConfig({
    NEXUS_EXCHANGE_API_URL: "https://exchange.nexus.xyz/api/exchange",
  } as NodeJS.ProcessEnv);
  assert.equal(cfg.directBaseUrl, "https://exchange.nexus.xyz");
  assert.equal(cfg.gatewayBaseUrl, "https://exchange.nexus.xyz/api/exchange");
});

test("client routes surface to the right base and signs the exact path sent", async () => {
  const secretHex = "00".repeat(32);
  const client = new ExchangeClient({
    directBaseUrl: "http://direct.test",
    gatewayBaseUrl: "http://direct.test/api/exchange",
    apiKey: "nx_test",
    apiSecret: secretHex,
  });

  const calls: Array<{ url: string; sig: string | null; ts: string | null }> =
    [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const h = new Headers(init.headers);
    calls.push({
      url,
      sig: h.get("x-signature"),
      ts: h.get("x-timestamp"),
    });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    // Default surface ("v1") hits the direct host root and signs the /api/v1 path.
    await client.request({ path: "/api/v1/account", signed: true });
    // Explicit "gateway" surface hits the /api/exchange proxy and signs the bare path.
    await client.request({
      path: "/withdrawals",
      surface: "gateway",
      signed: true,
    });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(calls[0].url, "http://direct.test/api/v1/account");
  assert.equal(calls[1].url, "http://direct.test/api/exchange/withdrawals");

  // The signature covers the exact path sent — including the /api/v1 prefix.
  const expectedV1 = referenceSign(
    secretHex,
    calls[0].ts!,
    "GET",
    "/api/v1/account",
    "",
    Buffer.alloc(0),
  );
  assert.equal(calls[0].sig, expectedV1, "v1 request signs the prefixed path");
});

test("cancel_order requires market_id when cancelling a single order", async () => {
  const tool = findTool("cancel_order")!;
  const client = new ExchangeClient({
    directBaseUrl: "http://example.test",
    gatewayBaseUrl: "http://example.test",
    apiKey: "nx_test",
    apiSecret: "00",
  });

  let fetchCalled = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    // order_id without market_id must fail fast, before any request.
    await assert.rejects(
      async () => tool.handler(client, { order_id: "abc123" }),
      /market_id/,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(fetchCalled, false, "no request should be sent");
});
