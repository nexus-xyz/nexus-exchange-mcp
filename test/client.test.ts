import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import {
  API_VERSION_HEADER,
  ExchangeApiError,
  ExchangeClient,
  MissingCredentialsError,
  NonJsonResponseError,
  sanitizeErrorBody,
  V1_ONLY_PATH,
} from "../src/client.js";
import { findTool, tools } from "../src/tools/index.js";
import {
  API_SPEC_VERSION,
  DEFAULT_USER_AGENT,
  PACKAGE_VERSION,
  deriveBases,
  loadConfig,
} from "../src/config.js";
import { defineTarget } from "../src/networks.js";

/**
 * A target with DECLARED play funds and a faucet, for the tests that exercise a
 * funds-guarded tool's happy path (ENG-9828). Absent a target the guard reads
 * funds as undeclared and refuses, which is the point of it.
 */
const PLAY_TARGET = defineTarget({
  id: "local",
  label: "Local",
  funds: "play",
  faucet: true,
  restBase: "http://example.test",
  gatewayPath: "",
});

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

test("every upstream request carries X-Nexus-Api-Version + a normalized User-Agent", async () => {
  // The "done when" of ENG-5957: both headers are emitted by default on every
  // upstream request — public reads and signed writes alike.
  const client = new ExchangeClient({
    baseUrl: "http://example.test",
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
    await client.request({ path: "/markets/summary" });
    // (b) signed POST with a body
    await client.request({
      path: "/orders",
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
    baseUrl: "http://example.test",
  });
  await assert.rejects(
    () => client.request({ path: "/account", signed: true }),
    MissingCredentialsError,
  );
  // A second route reports the same operator error: the prefix guard runs
  // first, and a bare path passes it and reaches the credential check.
  await assert.rejects(
    () =>
      client.request({
        path: "/withdrawals",
        signed: true,
      }),
    MissingCredentialsError,
  );
});

test("the /api/v1 prefix guard runs before credentials and before signing", async () => {
  // Ordering, not just presence. Behind the credential block the same mistake
  // would report MissingCredentialsError on an unconfigured machine and the
  // programming error on a configured one, and would sign the wrong path before
  // throwing. Both configurations must report the same thing, and nothing may
  // reach the network.
  const unconfigured = new ExchangeClient({
    baseUrl: "http://example.test/v1",
  });
  const configured = new ExchangeClient({
    baseUrl: "http://example.test/v1",
    apiKey: "nx_test",
    apiSecret: "00".repeat(32),
  });
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched++;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    for (const client of [unconfigured, configured]) {
      await assert.rejects(
        () => client.request({ path: "/api/v1/account", signed: true }),
        /carries the \/api\/v1 prefix/,
      );
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(fetched, 0, "a prefixed path never reaches the network");
});

test("create_order maps friendly args to the engine wire shape", async () => {
  const tool = findTool("create_order")!;
  const client = new ExchangeClient({
    baseUrl: "http://example.test",
    apiKey: "nx_test",
    apiSecret: "00",
    target: PLAY_TARGET,
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

test("cancel_order and cancel_all_orders build their own URLs", async () => {
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
    await findTool("cancel_order")!.handler(client, {
      order_id: "abc/123",
      market_id: "BTC-USDX-PERP",
    });
    // (b) confirmed mass-cancel: /orders with no id and no query.
    await findTool("cancel_all_orders")!.handler(client, { confirm: true });
    // (c) mass-cancel scoped to one market.
    await findTool("cancel_all_orders")!.handler(client, {
      confirm: true,
      market_id: "BTC-USDX-PERP",
    });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.deepEqual(calls, [
    {
      method: "DELETE",
      url: "http://example.test/orders/abc%2F123?market_id=BTC-USDX-PERP",
    },
    { method: "DELETE", url: "http://example.test/orders" },
    {
      method: "DELETE",
      url: "http://example.test/orders?market_id=BTC-USDX-PERP",
    },
  ]);
});

test("cancel_order can never reach the account-wide DELETE /orders", () => {
  // ENG-17742: a tool named for one order must not cancel everything. The old
  // `cancel_all` mode is gone from its schema, and an order_id is required.
  const tool = findTool("cancel_order")!;
  assert.deepEqual(tool.ops, ["DELETE /orders/{order_id}"]);
  assert.equal(tool.zod.safeParse({ cancel_all: true }).success, false);
  assert.equal(
    tool.zod.safeParse({ market_id: "BTC-USDX-PERP", cancel_all: true })
      .success,
    false,
  );
  assert.equal(
    tool.zod.safeParse({ market_id: "BTC-USDX-PERP" }).success,
    false,
  );
});

test("cancel_all_orders refuses to mass-cancel without confirm: true", async () => {
  const tool = findTool("cancel_all_orders")!;
  const client = new ExchangeClient({
    baseUrl: "http://example.test",
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
    await assert.rejects(async () => tool.handler(client, {}), /confirm: true/);
    // confirm: false is equally rejected, scoped or not.
    await assert.rejects(
      async () =>
        tool.handler(client, { confirm: false, market_id: "BTC-USDX-PERP" }),
      /confirm: true/,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(fetchCalled, false, "no request should be sent");
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
    baseUrl: "http://example.test",
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
  const tool = findTool("create_order")!;
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
    target: PLAY_TARGET,
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
    findTool("fetch_ohlcv")!.handler(c, {
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
    findTool("fetch_trades")!.handler(c, { market_id: "ETH-USDX-PERP" }),
  );
  // No limit -> no query string.
  assert.equal(
    trades[0].url,
    "http://example.test/markets/ETH-USDX-PERP/trades",
  );

  const funding = await captureCalls((c) =>
    findTool("fetch_funding_rate_history")!.handler(c, {
      market_id: "BTC-USDX-PERP",
      limit: 5,
    }),
  );
  assert.equal(
    funding[0].url,
    "http://example.test/markets/BTC-USDX-PERP/funding?limit=5",
  );

  const mark = await captureCalls((c) =>
    findTool("fetch_mark_price")!.handler(c, { market_id: "BTC-USDX-PERP" }),
  );
  assert.equal(
    mark[0].url,
    "http://example.test/markets/BTC-USDX-PERP/mark-price",
  );
});

test("fetch_order and fetch_adl_history encode path segments and forward limit", async () => {
  const order = await captureCalls((c) =>
    findTool("fetch_order")!.handler(c, { order_id: "abc/123" }),
  );
  assert.equal(order[0].method, "GET");
  assert.equal(order[0].url, "http://example.test/orders/abc%2F123");

  const adl = await captureCalls((c) =>
    findTool("fetch_adl_history")!.handler(c, { address: "0xABC", limit: 10 }),
  );
  assert.equal(
    adl[0].url,
    "http://example.test/account/0xABC/adl-history?limit=10",
  );
});

test("fetch_my_trades / fetch_withdrawals / fetch_rate_limit_status sign their requests", async () => {
  for (const name of [
    "fetch_my_trades",
    "fetch_withdrawals",
    "fetch_rate_limit_status",
  ]) {
    const client = new ExchangeClient({
      baseUrl: "http://example.test",
    });
    await assert.rejects(
      () => findTool(name)!.handler(client, {}) as Promise<unknown>,
      MissingCredentialsError,
      `${name} should require credentials`,
    );
  }
});

test("create_ws_token POSTs to /ws/token and is signed", async () => {
  const calls = await captureCalls((c) =>
    findTool("create_ws_token")!.handler(c, {}),
  );
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, "http://example.test/ws/token");

  const client = new ExchangeClient({
    baseUrl: "http://example.test",
  });
  await assert.rejects(
    () => findTool("create_ws_token")!.handler(client, {}) as Promise<unknown>,
    MissingCredentialsError,
  );
});

test("create_ws_token_legacy POSTs to /ws-tokens and is signed", async () => {
  const calls = await captureCalls((c) =>
    findTool("create_ws_token_legacy")!.handler(c, {}),
  );
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, "http://example.test/ws-tokens");

  const client = new ExchangeClient({
    baseUrl: "http://example.test",
  });
  await assert.rejects(
    () =>
      findTool("create_ws_token_legacy")!.handler(
        client,
        {},
      ) as Promise<unknown>,
    MissingCredentialsError,
  );
});

test("fetch_funding_history builds filtered and unfiltered signed URLs", async () => {
  // Spec route is GET /funding (fetchAccountFunding) — the old
  // /funding-payments path never existed server-side.
  const calls = await captureCalls(async (c) => {
    await findTool("fetch_funding_history")!.handler(c, {
      market_id: "BTC-USDX-PERP",
      limit: 25,
    });
    await findTool("fetch_funding_history")!.handler(c, {});
  });

  assert.equal(
    calls[0].url,
    "http://example.test/funding?market_id=BTC-USDX-PERP&limit=25",
  );
  assert.equal(calls[1].url, "http://example.test/funding");

  const client = new ExchangeClient({
    baseUrl: "http://example.test",
  });
  await assert.rejects(
    () =>
      findTool("fetch_funding_history")!.handler(
        client,
        {},
      ) as Promise<unknown>,
    MissingCredentialsError,
  );
});

test("create_orders maps each order to the engine wire shape", async () => {
  const calls = await captureCalls((c) =>
    findTool("create_orders")!.handler(c, {
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

test("create_orders rejects an empty list and limit orders missing price", () => {
  const tool = findTool("create_orders")!;
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
  const tool = findTool("create_order")!;
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
  const tool = findTool("create_order")!;
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

test("create_orders enforces the max-length bound", () => {
  const tool = findTool("create_orders")!;
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
    baseUrl: "http://example.test",
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

test("deriveBases composes the one base every request hangs off", () => {
  // The public `/v1` hosts serve the spec's paths directly under their base, so
  // their shape is `gatewayPath: ""` and the base is kept whole.
  assert.equal(
    deriveBases("https://api.testnet.nexus.xyz/v1", ""),
    "https://api.testnet.nexus.xyz/v1",
  );
  // The `exchange.nexus.xyz` values test the FUNCTION, not the default: no
  // built-in network passes that host in. What they still pin is the
  // backward-compatible normalization of a retired-gateway
  // `NEXUS_EXCHANGE_API_URL`, so an env var that still names it does not get a
  // doubled prefix.
  assert.equal(
    deriveBases("https://exchange.nexus.xyz"),
    "https://exchange.nexus.xyz/api/exchange",
  );
  assert.equal(
    deriveBases("https://exchange.nexus.xyz/api/exchange"),
    "https://exchange.nexus.xyz/api/exchange",
  );
  // The bare-indexer shape: gatewayPath "" means the base IS the origin.
  assert.equal(
    deriveBases("http://localhost:9090/", ""),
    "http://localhost:9090",
  );
  // Trailing slashes are trimmed before deriving.
  assert.equal(
    deriveBases("http://localhost:9090/"),
    "http://localhost:9090/api/exchange",
  );
});

test("loadConfig derives both bases from NEXUS_EXCHANGE_API_URL", () => {
  // The bare var is deprecated (ENG-10957) and prints a startup notice on
  // stderr; it is asserted on in custom-target.test.ts and silenced here.
  const stderr = console.error;
  console.error = () => {};
  let cfg!: ReturnType<typeof loadConfig>;
  try {
    cfg = loadConfig({
      NEXUS_EXCHANGE_API_URL: "https://exchange.nexus.xyz/api/exchange",
    } as NodeJS.ProcessEnv);
  } finally {
    console.error = stderr;
  }
  assert.equal(cfg.baseUrl, "https://exchange.nexus.xyz/api/exchange");
});

test("a named network keeps its gateway path when the URL redirects the host", () => {
  // The regression this guards: `gatewayPath` used to be hardcoded to
  // `/api/exchange` for every NEXUS_EXCHANGE_API_URL override. That was
  // invisible while the field moved only the LEGACY base, but ENG-6221 hangs
  // BOTH surfaces off it — so a hardcode sent `/*` to
  // `…/api/exchange/*` on a bare indexer that serves nothing there,
  // silently 404ing every v1 tool. `local` declares `gatewayPath: ""`; naming
  // the network must keep that shape while the URL redirects only the host.
  const cfg = loadConfig({
    NEXUS_EXCHANGE_NETWORK: "local",
    NEXUS_EXCHANGE_API_URL: "http://127.0.0.1:9090",
  } as NodeJS.ProcessEnv);
  assert.equal(cfg.baseUrl, "http://127.0.0.1:9090");

  // A network with a NON-EMPTY shape keeps it on the same path through the
  // code. This used to read testnet, which carried `/api/exchange`; ENG-8869
  // moved testnet to a route-prefixed deployment whose prefix lives in its
  // `baseUrl`, so its `gatewayPath` is now "" and mainnet is the only non-empty
  // entry left. Naming mainnet alongside an explicit URL is the sanctioned way
  // to target real funds, so it is a real path through this code, not a
  // contrivance.
  const mainnet = loadConfig({
    NEXUS_EXCHANGE_NETWORK: "mainnet",
    NEXUS_EXCHANGE_API_URL: "https://stage.example",
  } as NodeJS.ProcessEnv);
  assert.equal(mainnet.baseUrl, "https://stage.example/api/exchange");

  // And testnet keeps ITS shape, which is now the bare one: an override
  // redirects the host and must not re-append a prefix the base no longer has.
  const testnet = loadConfig({
    NEXUS_EXCHANGE_NETWORK: "testnet",
    NEXUS_EXCHANGE_API_URL: "https://stage.example",
  } as NodeJS.ProcessEnv);
  assert.equal(testnet.baseUrl, "https://stage.example");

  // With no network named there is no descriptor to read a shape from, so the
  // deprecated bare-URL form keeps the public-gateway convention. Asserted so
  // that this stays a decision rather than an accident.
  const stderr = console.error;
  console.error = () => {};
  let bare!: ReturnType<typeof loadConfig>;
  try {
    bare = loadConfig({
      NEXUS_EXCHANGE_API_URL: "http://localhost:9090",
    } as NodeJS.ProcessEnv);
  } finally {
    console.error = stderr;
  }
  assert.equal(bare.baseUrl, "http://localhost:9090/api/exchange");
});

test("only the bridge routes may keep the /api/v1 prefix", async () => {
  // Every route is a bare spec path under one base (EDR-006). A leftover
  // `/api/v1` prefix would compose `/v1/api/v1/...` and sign a path that is not
  // the spec's, so it is refused. The bridge reads are the exception while the
  // pinned spec lacks their bare twins.
  const client = new ExchangeClient({ baseUrl: "http://example.test/v1" });
  await assert.rejects(
    () => client.request({ path: "/api/v1/markets/summary" }),
    /carries the \/api\/v1 prefix/,
  );
  assert.ok(V1_ONLY_PATH.test("/api/v1/bridge/assets"));
  assert.ok(!V1_ONLY_PATH.test("/api/v1/bridgework"));
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("[]", { status: 200 })) as typeof fetch;
  try {
    await client.request({ path: "/markets/summary" });
    await client.request({ path: "/api/v1/bridge/assets" });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("no request call site in src/ spells /api/v1 outside the bridge", () => {
  // The runtime guard only fires on a path that actually executes, so it cannot
  // prove the existing call sites are right. This reads the source and checks
  // every literal request path, including the ones handed to `fetchPage` rather
  // than to `client.request`, because it keys on the `path:` literal and not on
  // the function receiving it. What would still evade it is a COMPUTED path with
  // no literal prefix at all; the drift scanner separately requires an inline
  // string or template literal at the call sites it knows.
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(new URL(dir, import.meta.url), {
      withFileTypes: true,
    })) {
      if (entry.isDirectory()) walk(`${dir}${entry.name}/`);
      else if (entry.name.endsWith(".ts") && entry.name !== "client.ts")
        files.push(`${dir}${entry.name}`);
    }
  };
  walk("../src/");
  assert.ok(files.length > 0, "found source files to scan");

  let scanned = 0;
  for (const rel of files) {
    const src = readFileSync(new URL(rel, import.meta.url), "utf8");
    // A quoted value only: `path: ["price"]` is a zod issue path, not a route.
    for (const m of src.matchAll(/path:\s*[`"']([^`"'$]*)/g)) {
      scanned++;
      if (!/^\/api\/v1(?:\/|$)/.test(m[1])) continue;
      assert.match(
        m[1],
        V1_ONLY_PATH,
        `${rel}: request path "${m[1]}" carries /api/v1; use the spec's bare ` +
          `path (only the bridge keeps the prefix, see V1_ONLY_PATH)`,
      );
    }
  }
  // A scan that silently matched nothing would pass vacuously.
  assert.ok(scanned > 60, `scanned ${scanned} literal-path call sites`);
});

test("the call-site scan covers routes delivered through fetchPage", () => {
  // The regression that motivated the rewrite above, pinned directly: the five
  // paginated tools whose options object is handed to `fetchPage` rather than
  // to `client.request`. Mutating one of their paths to a bare route must fail
  // the scan; under the old call-site-keyed regex it stayed green.
  const src = readFileSync(
    new URL("../src/tools/index.ts", import.meta.url),
    "utf8",
  );
  const viaFetchPage = [...src.matchAll(/\bfetchPage\s*\(/g)].map((m) => {
    let depth = 0;
    for (let i = m.index! + m[0].length - 1; i < src.length; i++) {
      const ch = src[i];
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") {
        depth--;
        if (depth === 0) return src.slice(m.index!, i + 1);
      }
    }
    return "";
  });
  const withLiteralPath = viaFetchPage.filter((call) =>
    /path:\s*[`"']/.test(call),
  );
  assert.ok(
    withLiteralPath.length >= 5,
    `expected the fetchPage call sites to carry literal paths, found ` +
      `${withLiteralPath.length} of ${viaFetchPage.length}`,
  );
  // And each of them is a path the scan above would classify, i.e. the object
  // literal it lives in is reachable by walking back from the key.
  for (const call of withLiteralPath) {
    assert.match(
      call,
      /\{[\s\S]*path:\s*[`"']/,
      "the literal path sits inside an object literal the scan can bound",
    );
  }
});

test("every request goes to the one base and signs the bare path, not the base's /v1", async () => {
  const secretHex = "00".repeat(32);
  const client = new ExchangeClient({
    baseUrl: "http://direct.test/v1",
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
    await client.request({ path: "/account", signed: true });
    await client.request({ path: "/api/v1/bridge/wallets", signed: true });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(calls[0].url, "http://direct.test/v1/account");
  assert.equal(calls[1].url, "http://direct.test/v1/api/v1/bridge/wallets");

  // The edge strips `/v1` before the indexer verifies, so the signature covers
  // the path the tool passed and never the base's prefix.
  for (const [i, path] of [
    [0, "/account"],
    [1, "/api/v1/bridge/wallets"],
  ] as const) {
    assert.equal(
      calls[i].sig,
      referenceSign(secretHex, calls[i].ts!, "GET", path, "", Buffer.alloc(0)),
      `${path} is signed without the base's /v1`,
    );
  }
});

test("cancel_order requires order_id and market_id", () => {
  const tool = findTool("cancel_order")!;
  assert.equal(tool.zod.safeParse({ order_id: "abc123" }).success, false);
  assert.equal(
    tool.zod.safeParse({ order_id: "abc123", market_id: "BTC-USDX-PERP" })
      .success,
    true,
  );
});

/**
 * A 2xx body that is not JSON must never be returned as if it were the
 * endpoint's data (ENG-8170). Every documented 2xx in spec v0.8.1 is
 * `application/json`, so a non-JSON success body means the request never
 * reached the Exchange API.
 */
function clientWithResponse(response: Response): ExchangeClient {
  const client = new ExchangeClient({
    baseUrl: "http://example.test",
  });
  globalThis.fetch = (async () => response.clone()) as typeof fetch;
  return client;
}

const MARKETING_PAGE =
  '<!DOCTYPE html><html lang="en"><head><link rel="preload" as="script" ' +
  'href="/_next/static/chunks/15xrurgzs99gv.js"/></head><body>Nexus</body></html>';

test("a 2xx HTML body throws instead of becoming the tool's result", async () => {
  const realFetch = globalThis.fetch;
  try {
    const client = clientWithResponse(
      new Response(MARKETING_PAGE, {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    await assert.rejects(
      () => client.request({ path: "/markets/summary" }),
      (err: Error) =>
        err instanceof NonJsonResponseError &&
        err.status === 200 &&
        err.contentType === "text/html" &&
        // The message has to point at the cause, not just say "parse failed".
        err.message.includes("NEXUS_EXCHANGE_API_URL"),
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a 2xx plain-text body throws too — HTML is not the only wrong answer", async () => {
  const realFetch = globalThis.fetch;
  try {
    const client = clientWithResponse(
      new Response("upstream connect error or disconnect/reset", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    );
    await assert.rejects(
      () => client.request({ path: "/markets/summary" }),
      NonJsonResponseError,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("an empty 2xx body is still undefined, not an error", async () => {
  // Seven operations in the spec document a 2xx with no content. An absent body
  // is a valid answer and must stay distinguishable from an unreadable one.
  const realFetch = globalThis.fetch;
  try {
    const noContent = clientWithResponse(new Response(null, { status: 204 }));
    assert.equal(await noContent.request({ path: "/orders" }), undefined);
    // Also a 200 that simply carries nothing.
    const emptyOk = clientWithResponse(new Response("", { status: 200 }));
    assert.equal(await emptyOk.request({ path: "/orders" }), undefined);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("valid JSON bodies still decode, including the falsy ones", async () => {
  const realFetch = globalThis.fetch;
  try {
    // `0`, `false`, `""`, and `null` are all valid JSON and all falsy. None may
    // be mistaken for an absent body and turned into undefined.
    for (const [body, expected] of [
      ["[]", []],
      ['{"a":1}', { a: 1 }],
      ["0", 0],
      ["false", false],
      ['""', ""],
      ["null", null],
    ] as Array<[string, unknown]>) {
      const client = clientWithResponse(new Response(body, { status: 200 }));
      assert.deepEqual(
        await client.request({ path: "/markets/summary" }),
        expected,
        `body ${body}`,
      );
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a non-JSON error body is unchanged — that path already threw", async () => {
  // A 4xx/5xx HTML body must keep raising ExchangeApiError with its status, not
  // be reclassified as a non-JSON success.
  const realFetch = globalThis.fetch;
  try {
    const client = clientWithResponse(
      new Response(MARKETING_PAGE, {
        status: 404,
        headers: { "content-type": "text/html" },
      }),
    );
    await assert.rejects(
      () => client.request({ path: "/markets/summary" }),
      (err: Error) => err instanceof ExchangeApiError && err.status === 404,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the thrown non-JSON body is scrubbed and bounded", async () => {
  const realFetch = globalThis.fetch;
  try {
    const client = clientWithResponse(
      new Response(
        `<html>api_key: "nx_live_secret" ${"x".repeat(2000)}</html>`,
        {
          status: 200,
          headers: { "content-type": "text/html" },
        },
      ),
    );
    await assert.rejects(
      () => client.request({ path: "/markets/summary" }),
      (err: Error) =>
        err instanceof NonJsonResponseError &&
        !err.body.includes("nx_live_secret") &&
        err.body.includes("[REDACTED]") &&
        err.body.includes("[truncated]"),
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});
