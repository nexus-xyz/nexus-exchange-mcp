import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ExchangeClient,
  MissingAdminSecretError,
  MissingCredentialsError,
  MissingSessionTokenError,
} from "../src/client.js";
import { findTool, tools, visibleTools } from "../src/tools/index.js";
import type { ExchangeConfig } from "../src/config.js";

const BASE = "http://example.test";

/** A client with full creds (HMAC + session + admin) for happy-path mapping. */
function fullClient(overrides: Partial<ExchangeConfig> = {}): ExchangeClient {
  return new ExchangeClient({
    directBaseUrl: BASE,
    gatewayBaseUrl: BASE,
    apiKey: "nx_test",
    apiSecret: "00",
    sessionToken: "sess_token",
    adminSecret: "admin_secret",
    enableAdminTools: true,
    ...overrides,
  });
}

/** Capture every fetch call (url + method + headers + parsed body) for a run. */
async function capture(
  client: ExchangeClient,
  run: (client: ExchangeClient) => Promise<unknown>,
): Promise<
  Array<{ url: string; method: string; headers: Headers; body?: any }>
> {
  const calls: Array<{
    url: string;
    method: string;
    headers: Headers;
    body?: any;
  }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const raw = init.body
      ? Buffer.from(init.body as Uint8Array).toString("utf8")
      : undefined;
    calls.push({
      url,
      method: (init.method as string) ?? "GET",
      headers: new Headers(init.headers),
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

test("get_market_adl_events encodes market id and forwards limit, signed", async () => {
  const calls = await capture(fullClient(), (c) =>
    findTool("get_market_adl_events")!.handler(c, {
      market_id: "BTC-USDX-PERP",
      limit: 50,
    }),
  );
  assert.equal(
    calls[0].url,
    `${BASE}/markets/BTC-USDX-PERP/adl-events?limit=50`,
  );
  assert.ok(calls[0].headers.get("x-signature"), "is HMAC-signed");

  const noCreds = new ExchangeClient({
    directBaseUrl: BASE,
    gatewayBaseUrl: BASE,
  });
  await assert.rejects(
    () =>
      findTool("get_market_adl_events")!.handler(noCreds, {
        market_id: "BTC-USDX-PERP",
      }) as Promise<unknown>,
    MissingCredentialsError,
  );
});

test("deposit_collateral POSTs {amount} to /account/deposit, signed", async () => {
  const calls = await capture(fullClient(), (c) =>
    findTool("deposit_collateral")!.handler(c, { amount: "1000" }),
  );
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, `${BASE}/account/deposit`);
  assert.deepEqual(calls[0].body, { amount: "1000" });
  assert.ok(calls[0].headers.get("x-signature"));
});

test("deposit_collateral rejects non-positive amount", () => {
  const tool = findTool("deposit_collateral")!;
  for (const amount of ["0", "-1", "abc", ""]) {
    assert.equal(tool.zod.safeParse({ amount }).success, false, amount);
  }
  assert.equal(tool.zod.safeParse({ amount: "10.5" }).success, true);
});

test("claim_credit sends {amount} when given and {} when omitted", async () => {
  const withAmount = await capture(fullClient(), (c) =>
    findTool("claim_credit")!.handler(c, { amount: "250" }),
  );
  assert.equal(withAmount[0].url, `${BASE}/api/v1/account/credit`);
  assert.deepEqual(withAmount[0].body, { amount: "250" });

  const full = await capture(fullClient(), (c) =>
    findTool("claim_credit")!.handler(c, {}),
  );
  // Omitted amount -> empty body (claim full allowance).
  assert.deepEqual(full[0].body, {});
});

test("list_agents GETs /agents signed", async () => {
  const calls = await capture(fullClient(), (c) =>
    findTool("list_agents")!.handler(c, {}),
  );
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].url, `${BASE}/agents`);
  assert.ok(calls[0].headers.get("x-signature"));
});

test("register_agent POSTs the signature body and needs no credentials", async () => {
  // No HMAC creds: registration is authorized by the wallet signature.
  const client = new ExchangeClient({
    directBaseUrl: BASE,
    gatewayBaseUrl: BASE,
  });
  const calls = await capture(client, (c) =>
    findTool("register_agent")!.handler(c, {
      wallet: "0xWALLET",
      agent: "0xAGENT",
      nonce: 1700000000000,
      signature: "0xdeadbeef",
      label: "trading-bot",
    }),
  );
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, `${BASE}/agents/register`);
  assert.equal(calls[0].headers.get("x-signature"), null, "unsigned");
  assert.deepEqual(calls[0].body, {
    wallet: "0xWALLET",
    agent: "0xAGENT",
    nonce: 1700000000000,
    signature: "0xdeadbeef",
    label: "trading-bot",
  });
});

test("register_agent omits optional fields when not provided", async () => {
  const client = new ExchangeClient({
    directBaseUrl: BASE,
    gatewayBaseUrl: BASE,
  });
  const calls = await capture(client, (c) =>
    findTool("register_agent")!.handler(c, {
      wallet: "0xW",
      agent: "0xA",
      nonce: 1,
      signature: "0xsig",
    }),
  );
  assert.deepEqual(calls[0].body, {
    wallet: "0xW",
    agent: "0xA",
    nonce: 1,
    signature: "0xsig",
  });
});

test("register_agent schema requires wallet/agent/nonce/signature", () => {
  const tool = findTool("register_agent")!;
  assert.equal(
    tool.zod.safeParse({ wallet: "0xW", agent: "0xA" }).success,
    false,
  );
});

test("revoke_agent refuses without confirm, then DELETEs with confirm", async () => {
  const tool = findTool("revoke_agent")!;
  await assert.rejects(
    async () => tool.handler(fullClient(), { address: "0xAGENT" }),
    /confirm: true/,
  );

  const calls = await capture(fullClient(), (c) =>
    tool.handler(c, { address: "0xA/B", confirm: true }),
  );
  assert.equal(calls[0].method, "DELETE");
  assert.equal(calls[0].url, `${BASE}/agents/0xA%2FB`);
  assert.ok(calls[0].headers.get("x-signature"));
});

test("login POSTs default message + signature, unsigned", async () => {
  const client = new ExchangeClient({
    directBaseUrl: BASE,
    gatewayBaseUrl: BASE,
  });
  const calls = await capture(client, (c) =>
    findTool("login")!.handler(c, { signature: "0xsig" }),
  );
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, `${BASE}/auth/login`);
  assert.deepEqual(calls[0].body, {
    message: "Sign in to Nexus Exchange",
    signature: "0xsig",
  });
});

test("list_api_keys / create_api_key use the Bearer session token", async () => {
  const list = await capture(fullClient(), (c) =>
    findTool("list_api_keys")!.handler(c, {}),
  );
  assert.equal(list[0].method, "GET");
  assert.equal(list[0].url, `${BASE}/keys`);
  assert.equal(list[0].headers.get("authorization"), "Bearer sess_token");
  // Bearer mode does not also HMAC-sign.
  assert.equal(list[0].headers.get("x-signature"), null);

  const create = await capture(fullClient(), (c) =>
    findTool("create_api_key")!.handler(c, {}),
  );
  assert.equal(create[0].method, "POST");
  assert.equal(create[0].url, `${BASE}/keys`);
  assert.equal(create[0].headers.get("authorization"), "Bearer sess_token");
});

test("bearer tools without a session token throw MissingSessionTokenError", async () => {
  const noSession = new ExchangeClient({
    directBaseUrl: BASE,
    gatewayBaseUrl: BASE,
    apiKey: "k",
    apiSecret: "00",
  });
  await assert.rejects(
    () => findTool("list_api_keys")!.handler(noSession, {}) as Promise<unknown>,
    MissingSessionTokenError,
  );
});

test("delete_api_key refuses without confirm, then DELETEs with Bearer", async () => {
  const tool = findTool("delete_api_key")!;
  await assert.rejects(
    async () => tool.handler(fullClient(), { key_id: "nx_abc" }),
    /confirm: true/,
  );
  const calls = await capture(fullClient(), (c) =>
    tool.handler(c, { key_id: "nx_a/b", confirm: true }),
  );
  assert.equal(calls[0].method, "DELETE");
  assert.equal(calls[0].url, `${BASE}/keys/nx_a%2Fb`);
  assert.equal(calls[0].headers.get("authorization"), "Bearer sess_token");
});

test("admin tier tools use the admin Bearer secret and are gated off by default", async () => {
  // Hidden unless explicitly enabled.
  const def = visibleTools({ enableAdminTools: false }).map((t) => t.name);
  assert.ok(!def.includes("set_tier"), "admin tools hidden by default");
  const on = visibleTools({ enableAdminTools: true }).map((t) => t.name);
  assert.ok(on.includes("set_tier"), "admin tools visible when enabled");

  const list = await capture(fullClient(), (c) =>
    findTool("list_tiers")!.handler(c, {}),
  );
  assert.equal(list[0].url, `${BASE}/admin/tiers`);
  assert.equal(list[0].headers.get("authorization"), "Bearer admin_secret");

  const set = await capture(fullClient(), (c) =>
    findTool("set_tier")!.handler(c, {
      address: "0xACC",
      tier: "MarketMaker",
    }),
  );
  assert.equal(set[0].method, "PUT");
  assert.equal(set[0].url, `${BASE}/admin/tiers`);
  assert.deepEqual(set[0].body, { address: "0xACC", tier: "MarketMaker" });
});

test("delete_tier refuses without confirm and needs the admin secret", async () => {
  const tool = findTool("delete_tier")!;
  await assert.rejects(
    async () => tool.handler(fullClient(), { address: "0xACC" }),
    /confirm: true/,
  );

  const noAdmin = new ExchangeClient({
    directBaseUrl: BASE,
    gatewayBaseUrl: BASE,
    apiKey: "k",
    apiSecret: "00",
  });
  await assert.rejects(
    () =>
      tool.handler(noAdmin, {
        address: "0xACC",
        confirm: true,
      }) as Promise<unknown>,
    MissingAdminSecretError,
  );

  const calls = await capture(fullClient(), (c) =>
    tool.handler(c, { address: "0xACC", confirm: true }),
  );
  assert.equal(calls[0].method, "DELETE");
  assert.equal(calls[0].url, `${BASE}/admin/tiers/0xACC`);
  assert.equal(calls[0].headers.get("authorization"), "Bearer admin_secret");
});

// ── v0.6.2 parity tools ──────────────────────────────────────────────────────

test("public stats / status tools hit the right unsigned paths", async () => {
  const cases: Array<[string, string]> = [
    ["get_stats", `${BASE}/api/v1/stats`],
    ["get_stats_history", `${BASE}/api/v1/stats/history`],
    ["get_service_status", `${BASE}/status`],
  ];
  for (const [name, url] of cases) {
    const calls = await capture(fullClient(), (c) =>
      findTool(name)!.handler(c, {}),
    );
    assert.equal(calls[0].method, "GET", name);
    assert.equal(calls[0].url, url, name);
    // Public — no auth headers.
    assert.equal(calls[0].headers.get("x-api-key"), null, name);
    assert.equal(calls[0].headers.get("authorization"), null, name);
  }
});

test("get_funding_samples encodes the market id and caps limit at 480", async () => {
  const calls = await capture(fullClient(), (c) =>
    findTool("get_funding_samples")!.handler(c, {
      market_id: "BTC-USDX-PERP",
      limit: 120,
    }),
  );
  assert.equal(
    calls[0].url,
    `${BASE}/api/v1/markets/BTC-USDX-PERP/funding-samples?limit=120`,
  );
  assert.equal(calls[0].headers.get("x-api-key"), null, "public");

  const tool = findTool("get_funding_samples")!;
  assert.equal(
    tool.zod.safeParse({ market_id: "X", limit: 481 }).success,
    false,
  );
  assert.equal(
    tool.zod.safeParse({ market_id: "X", limit: 480 }).success,
    true,
  );
});

test("get_market_risk_params GETs the legacy risk-params route unsigned", async () => {
  const calls = await capture(fullClient(), (c) =>
    findTool("get_market_risk_params")!.handler(c, {
      market_id: "ETH-USDX-PERP",
    }),
  );
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].url, `${BASE}/markets/ETH-USDX-PERP/risk-params`);
  assert.equal(calls[0].headers.get("x-api-key"), null, "public");
});

test("account summary / equity / closed positions / order history sign v1 GETs", async () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["get_account_summary", {}, `${BASE}/api/v1/account/summary`],
    [
      "get_equity_history",
      { limit: 60 },
      `${BASE}/api/v1/account/equity-history?limit=60`,
    ],
    [
      "get_closed_positions",
      { limit: 10 },
      `${BASE}/api/v1/positions/closed?limit=10`,
    ],
    [
      "get_order_history",
      { limit: 200 },
      `${BASE}/api/v1/orders/history?limit=200`,
    ],
  ];
  for (const [name, args, url] of cases) {
    const calls = await capture(fullClient(), (c) =>
      findTool(name)!.handler(c, args),
    );
    assert.equal(calls[0].method, "GET", name);
    assert.equal(calls[0].url, url, name);
    assert.ok(calls[0].headers.get("x-signature"), `${name} is HMAC-signed`);

    const noCreds = new ExchangeClient({
      directBaseUrl: BASE,
      gatewayBaseUrl: BASE,
    });
    await assert.rejects(
      () => findTool(name)!.handler(noCreds, {}) as Promise<unknown>,
      MissingCredentialsError,
      `${name} requires credentials`,
    );
  }
});

/**
 * Every `limit`-bearing tool must carry its OWN endpoint's `maximum` from spec
 * v0.7.2. The caps are not interchangeable, and an unbounded schema is the
 * harmful case: an out-of-schema `limit` validates, gets signed, and is
 * forwarded, and if the upstream clamps rather than rejecting it, the agent
 * reads a truncated list as a complete one with no signal (ENG-8173).
 *
 * Base args carry each tool's required fields so `limit` is the only thing
 * under test. The five cursor-paginated tools' caps are covered separately in
 * test/pagination.test.ts (ENG-7424).
 */
test("history tools enforce the spec limit caps in their schemas", () => {
  const caps: Array<[string, number, Record<string, unknown>]> = [
    ["get_equity_history", 720, {}],
    ["get_closed_positions", 200, {}],
    ["get_order_history", 500, {}],
    ["list_deposits", 100, {}],
    ["get_funding_payments", 1000, {}],
    ["list_bridge_deposits", 100, {}],
    ["get_withdrawals", 100, {}],
    ["get_candles", 1000, { market_id: "BTC-USDX-PERP" }],
    ["get_funding_samples", 480, { market_id: "BTC-USDX-PERP" }],
    ["get_funding_history", 1000, { market_id: "BTC-USDX-PERP" }],
    ["get_market_adl_events", 1000, { market_id: "BTC-USDX-PERP" }],
    ["get_adl_history", 1000, { address: "0xabc" }],
    ["get_portfolio_history", 366, {}],
  ];
  for (const [name, cap, base] of caps) {
    const tool = findTool(name)!;
    assert.equal(
      tool.zod.safeParse({ ...base, limit: cap }).success,
      true,
      `${name} should accept its cap ${cap}`,
    );
    assert.equal(
      tool.zod.safeParse({ ...base, limit: cap + 1 }).success,
      false,
      `${name} should reject ${cap + 1}, one over its cap`,
    );
    // 0 is a sentinel that reads as "no limit" if it slips through.
    assert.equal(
      tool.zod.safeParse({ ...base, limit: 0 }).success,
      false,
      `${name} should reject 0`,
    );
    assert.equal(
      tool.zod.safeParse({ ...base, limit: -1 }).success,
      false,
      `${name} should reject -1`,
    );
  }
});

/**
 * The caps above are per-endpoint, so a tool must not silently inherit a
 * neighbour's ceiling. These three are the ones ENG-8173 added; each is
 * checked against the cap it does NOT have, to catch a copy-paste fix.
 */
test("limit caps are per-endpoint, not shared", () => {
  // get_withdrawals is 100, not the 1000 its sibling legacy reads carry.
  assert.equal(
    findTool("get_withdrawals")!.zod.safeParse({ limit: 1000 }).success,
    false,
  );
  // get_funding_history is 1000, not get_funding_samples' 480.
  assert.equal(
    findTool("get_funding_history")!.zod.safeParse({
      market_id: "BTC-USDX-PERP",
      limit: 1000,
    }).success,
    true,
  );
  assert.equal(
    findTool("get_funding_samples")!.zod.safeParse({
      market_id: "BTC-USDX-PERP",
      limit: 1000,
    }).success,
    false,
  );
  // get_adl_history is 1000, not get_market_adl_events' — both are 1000, so
  // assert the shared value explicitly rather than assuming it transfers.
  assert.equal(
    findTool("get_adl_history")!.zod.safeParse({
      address: "0xabc",
      limit: 1001,
    }).success,
    false,
  );
});

/**
 * The cap has to reach the agent too: the zod schema is server-side
 * validation, but `inputSchema` is the only thing an agent reads before
 * choosing a `limit`. A silent rejection it could have avoided is a worse
 * experience than a documented ceiling.
 */
test("limit descriptions state the cap the schema enforces", () => {
  for (const [name, cap] of [
    ["get_withdrawals", 100],
    ["get_funding_history", 1000],
    ["get_adl_history", 1000],
  ] as Array<[string, number]>) {
    const props = findTool(name)!.inputSchema.properties as Record<
      string,
      { description?: string }
    >;
    const description = props.limit?.description ?? "";
    assert.ok(
      description.includes(`max ${cap}`),
      `${name} limit description should state "max ${cap}", got: ${description}`,
    );
  }
});

test("amend_order PATCHes the v1 order route with market_id and a partial body", async () => {
  const calls = await capture(fullClient(), (c) =>
    findTool("amend_order")!.handler(c, {
      order_id: "abc/123",
      market_id: "BTC-USDX-PERP",
      price: "61000",
    }),
  );
  assert.equal(calls[0].method, "PATCH");
  assert.equal(
    calls[0].url,
    `${BASE}/api/v1/orders/abc%2F123?market_id=BTC-USDX-PERP`,
  );
  assert.deepEqual(calls[0].body, { price: "61000" });
  assert.ok(calls[0].headers.get("x-signature"), "is HMAC-signed");

  const both = await capture(fullClient(), (c) =>
    findTool("amend_order")!.handler(c, {
      order_id: "o1",
      market_id: "BTC-USDX-PERP",
      price: "61000",
      size: "0.25",
    }),
  );
  assert.deepEqual(both[0].body, { price: "61000", size: "0.25" });
});

test("amend_order schema requires at least one of price/size and market_id", () => {
  const tool = findTool("amend_order")!;
  assert.equal(
    tool.zod.safeParse({ order_id: "o1", market_id: "BTC-USDX-PERP" }).success,
    false,
    "price or size required",
  );
  assert.equal(
    tool.zod.safeParse({ order_id: "o1", size: "1" }).success,
    false,
    "market_id required",
  );
  assert.equal(
    tool.zod.safeParse({
      order_id: "o1",
      market_id: "BTC-USDX-PERP",
      size: "0",
    }).success,
    false,
    "non-positive size rejected",
  );
  assert.equal(
    tool.zod.safeParse({
      order_id: "o1",
      market_id: "BTC-USDX-PERP",
      size: "1",
    }).success,
    true,
  );
});

test("preview_order maps friendly args to the wire shape at /orders/preview", async () => {
  const calls = await capture(fullClient(), (c) =>
    findTool("preview_order")!.handler(c, {
      market_id: "BTC-USDX-PERP",
      side: "sell",
      type: "limit",
      size: "0.5",
      price: "60000",
      time_in_force: "PostOnly",
    }),
  );
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, `${BASE}/api/v1/orders/preview`);
  assert.deepEqual(calls[0].body, {
    market_id: "BTC-USDX-PERP",
    side: "Sell",
    order_type: "Limit",
    quantity: "0.5",
    time_in_force: "PostOnly",
    price: "60000",
  });
  assert.ok(calls[0].headers.get("x-signature"), "is HMAC-signed");
});

test("place_order accepts the PostOnly time in force", () => {
  const tool = findTool("place_order")!;
  assert.equal(
    tool.zod.safeParse({
      market_id: "BTC-USDX-PERP",
      side: "buy",
      type: "limit",
      size: "1",
      price: "60000",
      time_in_force: "PostOnly",
    }).success,
    true,
  );
});

test("submit_deposit POSTs {amount, asset?} to /deposits, signed", async () => {
  const calls = await capture(fullClient(), (c) =>
    findTool("submit_deposit")!.handler(c, { amount: "500", asset: "USDX" }),
  );
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, `${BASE}/deposits`);
  assert.deepEqual(calls[0].body, { amount: "500", asset: "USDX" });
  assert.ok(calls[0].headers.get("x-signature"));

  // asset omitted -> not sent (server defaults to USDX).
  const bare = await capture(fullClient(), (c) =>
    findTool("submit_deposit")!.handler(c, { amount: "500" }),
  );
  assert.deepEqual(bare[0].body, { amount: "500" });

  const tool = findTool("submit_deposit")!;
  for (const amount of ["0", "-1", "abc", ""]) {
    assert.equal(tool.zod.safeParse({ amount }).success, false, amount);
  }
});

test("list_deposits GETs /deposits with limit, signed", async () => {
  const calls = await capture(fullClient(), (c) =>
    findTool("list_deposits")!.handler(c, { limit: 20 }),
  );
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].url, `${BASE}/deposits?limit=20`);
  assert.ok(calls[0].headers.get("x-signature"));
});

test("claim_faucet POSTs to /faucet with no body, signed", async () => {
  const calls = await capture(fullClient(), (c) =>
    findTool("claim_faucet")!.handler(c, {}),
  );
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, `${BASE}/faucet`);
  assert.equal(calls[0].body, undefined, "no request body");
  assert.ok(calls[0].headers.get("x-signature"));
});

test("adjust_isolated_margin POSTs the margin adjustment, signed", async () => {
  const calls = await capture(fullClient(), (c) =>
    findTool("adjust_isolated_margin")!.handler(c, {
      market_id: "BTC-USDX-PERP",
      amount: "100",
      direction: "add",
    }),
  );
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, `${BASE}/account/margin`);
  assert.deepEqual(calls[0].body, {
    market_id: "BTC-USDX-PERP",
    amount: "100",
    direction: "add",
  });
  assert.ok(calls[0].headers.get("x-signature"));

  const tool = findTool("adjust_isolated_margin")!;
  assert.equal(
    tool.zod.safeParse({
      market_id: "BTC-USDX-PERP",
      amount: "100",
      direction: "withdraw",
    }).success,
    false,
    "direction is add|remove",
  );
});

test("get_order forwards the optional market_id as a query param", async () => {
  const withMarket = await capture(fullClient(), (c) =>
    findTool("get_order")!.handler(c, {
      order_id: "o1",
      market_id: "BTC-USDX-PERP",
    }),
  );
  assert.equal(withMarket[0].url, `${BASE}/orders/o1?market_id=BTC-USDX-PERP`);

  const bare = await capture(fullClient(), (c) =>
    findTool("get_order")!.handler(c, { order_id: "o1" }),
  );
  assert.equal(bare[0].url, `${BASE}/orders/o1`, "omitted -> no query");
});

// ── v0.7.1 tool surface (ENG-6136) ───────────────────────────────────────────

test("get_cancel_on_disconnect GETs the signed v1 COD route", async () => {
  const calls = await capture(fullClient(), (c) =>
    findTool("get_cancel_on_disconnect")!.handler(c, {}),
  );
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].url, `${BASE}/api/v1/account/cancel-on-disconnect`);
  assert.ok(calls[0].headers.get("x-signature"), "is HMAC-signed");

  const noCreds = new ExchangeClient({
    directBaseUrl: BASE,
    gatewayBaseUrl: BASE,
  });
  await assert.rejects(
    () =>
      findTool("get_cancel_on_disconnect")!.handler(
        noCreds,
        {},
      ) as Promise<unknown>,
    MissingCredentialsError,
  );
});

test("set_cancel_on_disconnect PUTs {enabled} and requires an explicit boolean", async () => {
  for (const enabled of [true, false]) {
    const calls = await capture(fullClient(), (c) =>
      findTool("set_cancel_on_disconnect")!.handler(c, { enabled }),
    );
    assert.equal(calls[0].method, "PUT");
    assert.equal(calls[0].url, `${BASE}/api/v1/account/cancel-on-disconnect`);
    assert.deepEqual(calls[0].body, { enabled });
    assert.ok(calls[0].headers.get("x-signature"), "is HMAC-signed");
  }

  const tool = findTool("set_cancel_on_disconnect")!;
  // `enabled` is required and explicit — an argless call is rejected.
  assert.equal(tool.zod.safeParse({}).success, false, "enabled required");
  assert.equal(
    tool.zod.safeParse({ enabled: "true" }).success,
    false,
    "enabled must be a boolean",
  );
});

test("get_bridge_assets GETs the public v1 bridge catalog unsigned", async () => {
  const calls = await capture(fullClient(), (c) =>
    findTool("get_bridge_assets")!.handler(c, {}),
  );
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].url, `${BASE}/api/v1/bridge/assets`);
  // Public — no auth headers.
  assert.equal(calls[0].headers.get("x-api-key"), null);
  assert.equal(calls[0].headers.get("authorization"), null);
});

test("create_bridge_deposit_address POSTs {chain}, signed", async () => {
  const calls = await capture(fullClient(), (c) =>
    findTool("create_bridge_deposit_address")!.handler(c, {
      chain: "ethereum",
    }),
  );
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, `${BASE}/api/v1/bridge/deposit-addresses`);
  assert.deepEqual(calls[0].body, { chain: "ethereum" });
  assert.ok(calls[0].headers.get("x-signature"), "is HMAC-signed");

  const tool = findTool("create_bridge_deposit_address")!;
  assert.equal(tool.zod.safeParse({}).success, false, "chain required");
  assert.equal(tool.zod.safeParse({ chain: "" }).success, false);
});

test("list_bridge_deposit_addresses GETs the signed v1 route", async () => {
  const calls = await capture(fullClient(), (c) =>
    findTool("list_bridge_deposit_addresses")!.handler(c, {}),
  );
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].url, `${BASE}/api/v1/bridge/deposit-addresses`);
  assert.ok(calls[0].headers.get("x-signature"), "is HMAC-signed");
});

test("list_bridge_deposits forwards filters + limit, signed, caps at 100", async () => {
  const calls = await capture(fullClient(), (c) =>
    findTool("list_bridge_deposits")!.handler(c, {
      limit: 25,
      chain: "ethereum",
      asset: "USDC",
      status: "credited",
    }),
  );
  assert.equal(calls[0].method, "GET");
  assert.equal(
    calls[0].url,
    `${BASE}/api/v1/bridge/deposits?limit=25&chain=ethereum&asset=USDC&status=credited`,
  );
  assert.ok(calls[0].headers.get("x-signature"), "is HMAC-signed");

  // No args -> no query string.
  const bare = await capture(fullClient(), (c) =>
    findTool("list_bridge_deposits")!.handler(c, {}),
  );
  assert.equal(bare[0].url, `${BASE}/api/v1/bridge/deposits`);

  const tool = findTool("list_bridge_deposits")!;
  assert.equal(tool.zod.safeParse({ limit: 100 }).success, true);
  assert.equal(tool.zod.safeParse({ limit: 101 }).success, false);
  assert.equal(
    tool.zod.safeParse({ asset: "ETH" }).success,
    false,
    "asset enum",
  );
  assert.equal(
    tool.zod.safeParse({ status: "pending" }).success,
    false,
    "status enum",
  );
});

test("get_bridge_deposit encodes the id in the path, signed", async () => {
  const calls = await capture(fullClient(), (c) =>
    findTool("get_bridge_deposit")!.handler(c, { id: "dep/1" }),
  );
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].url, `${BASE}/api/v1/bridge/deposits/dep%2F1`);
  assert.ok(calls[0].headers.get("x-signature"), "is HMAC-signed");

  const tool = findTool("get_bridge_deposit")!;
  assert.equal(tool.zod.safeParse({}).success, false, "id required");
});

test("place_order maps a trailing_limit order to the wire shape", async () => {
  const calls = await capture(fullClient(), (c) =>
    findTool("place_order")!.handler(c, {
      market_id: "BTC-USDX-PERP",
      side: "sell",
      type: "trailing_limit",
      size: "0.5",
      trailing_offset_bps: 50,
      limit_offset_bps: 10,
    }),
  );
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, `${BASE}/api/v1/orders`);
  assert.deepEqual(calls[0].body, {
    market_id: "BTC-USDX-PERP",
    side: "Sell",
    order_type: "TrailingLimit",
    quantity: "0.5",
    time_in_force: "GTC",
    trailing_offset_bps: 50,
    limit_offset_bps: 10,
  });
  // No limit price is sent for a trailing_limit order.
  assert.equal("price" in calls[0].body, false);
  assert.ok(calls[0].headers.get("x-signature"), "is HMAC-signed");
});

test("trailing_limit requires both offsets and bounds limit_offset_bps to 9999", () => {
  const tool = findTool("place_order")!;
  const base = {
    market_id: "BTC-USDX-PERP",
    side: "buy" as const,
    type: "trailing_limit" as const,
    size: "1",
  };
  assert.equal(
    tool.zod.safeParse({ ...base, trailing_offset_bps: 50 }).success,
    false,
    "limit_offset_bps required",
  );
  assert.equal(
    tool.zod.safeParse({ ...base, limit_offset_bps: 10 }).success,
    false,
    "trailing_offset_bps required",
  );
  assert.equal(
    tool.zod.safeParse({
      ...base,
      trailing_offset_bps: 50,
      limit_offset_bps: 10000,
    }).success,
    false,
    "limit_offset_bps capped at 9999",
  );
  assert.equal(
    tool.zod.safeParse({
      ...base,
      trailing_offset_bps: 0,
      limit_offset_bps: 0,
    }).success,
    true,
    "zero offsets accepted",
  );
  assert.equal(
    tool.zod.safeParse({
      ...base,
      trailing_offset_bps: 1.5,
      limit_offset_bps: 10,
    }).success,
    false,
    "offsets must be integers",
  );
});

test("stray fields are rejected for the wrong order type", () => {
  const tool = findTool("place_order")!;
  // A price on a market order is rejected, not silently dropped.
  assert.equal(
    tool.zod.safeParse({
      market_id: "BTC-USDX-PERP",
      side: "buy",
      type: "market",
      size: "1",
      price: "100",
    }).success,
    false,
    "price rejected on market orders",
  );
  // A price on a trailing_limit order (which sets its price at fire time) is
  // rejected too.
  assert.equal(
    tool.zod.safeParse({
      market_id: "BTC-USDX-PERP",
      side: "buy",
      type: "trailing_limit",
      size: "1",
      trailing_offset_bps: 50,
      limit_offset_bps: 10,
      price: "100",
    }).success,
    false,
    "price rejected on trailing_limit orders",
  );
  // Trailing offsets on a limit order are rejected, not silently ignored.
  assert.equal(
    tool.zod.safeParse({
      market_id: "BTC-USDX-PERP",
      side: "buy",
      type: "limit",
      size: "1",
      price: "100",
      trailing_offset_bps: 50,
    }).success,
    false,
    "trailing_offset_bps rejected on limit orders",
  );
  assert.equal(
    tool.zod.safeParse({
      market_id: "BTC-USDX-PERP",
      side: "buy",
      type: "market",
      size: "1",
      limit_offset_bps: 10,
    }).success,
    false,
    "limit_offset_bps rejected on market orders",
  );
});

test("place_order maps a stop_market (stop-loss) order to the wire shape", async () => {
  const calls = await capture(fullClient(), (c) =>
    findTool("place_order")!.handler(c, {
      market_id: "BTC-USDX-PERP",
      side: "sell",
      type: "stop_market",
      size: "0.5",
      trigger_price: "58000",
    }),
  );
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, `${BASE}/api/v1/orders`);
  assert.deepEqual(calls[0].body, {
    market_id: "BTC-USDX-PERP",
    side: "Sell",
    order_type: "StopMarket",
    quantity: "0.5",
    // A market-fired type defaults to IOC.
    time_in_force: "IOC",
    trigger_price: "58000",
  });
  // A market-fired stop carries neither a limit price nor offsets.
  assert.equal("price" in calls[0].body, false);
  assert.equal("trailing_offset_bps" in calls[0].body, false);
  assert.ok(calls[0].headers.get("x-signature"), "is HMAC-signed");
});

test("place_order maps a stop_limit order with price + trigger_price", async () => {
  const calls = await capture(fullClient(), (c) =>
    findTool("place_order")!.handler(c, {
      market_id: "BTC-USDX-PERP",
      side: "buy",
      type: "stop_limit",
      size: "1",
      price: "60500",
      trigger_price: "60000",
    }),
  );
  assert.deepEqual(calls[0].body, {
    market_id: "BTC-USDX-PERP",
    side: "Buy",
    order_type: "StopLimit",
    quantity: "1",
    // A resting limit-family type defaults to GTC.
    time_in_force: "GTC",
    price: "60500",
    trigger_price: "60000",
  });
});

test("place_order maps take-profit orders (limit + market)", async () => {
  const tpLimit = await capture(fullClient(), (c) =>
    findTool("place_order")!.handler(c, {
      market_id: "ETH-USDX-PERP",
      side: "sell",
      type: "take_profit_limit",
      size: "2",
      price: "3100",
      trigger_price: "3150",
    }),
  );
  assert.equal(tpLimit[0].body.order_type, "TakeProfitLimit");
  assert.equal(tpLimit[0].body.price, "3100");
  assert.equal(tpLimit[0].body.trigger_price, "3150");
  assert.equal(tpLimit[0].body.time_in_force, "GTC");

  const tpMarket = await capture(fullClient(), (c) =>
    findTool("place_order")!.handler(c, {
      market_id: "ETH-USDX-PERP",
      side: "sell",
      type: "take_profit_market",
      size: "2",
      trigger_price: "3150",
    }),
  );
  assert.equal(tpMarket[0].body.order_type, "TakeProfitMarket");
  assert.equal("price" in tpMarket[0].body, false);
  assert.equal(tpMarket[0].body.trigger_price, "3150");
  assert.equal(tpMarket[0].body.time_in_force, "IOC");
});

test("place_order maps a trailing_stop order (offset only, no limit offset)", async () => {
  const calls = await capture(fullClient(), (c) =>
    findTool("place_order")!.handler(c, {
      market_id: "BTC-USDX-PERP",
      side: "sell",
      type: "trailing_stop",
      size: "0.5",
      trailing_offset_bps: 75,
    }),
  );
  assert.deepEqual(calls[0].body, {
    market_id: "BTC-USDX-PERP",
    side: "Sell",
    order_type: "TrailingStop",
    quantity: "0.5",
    // Fires as a market order → IOC.
    time_in_force: "IOC",
    trailing_offset_bps: 75,
  });
  assert.equal("price" in calls[0].body, false);
  assert.equal("trigger_price" in calls[0].body, false);
  assert.equal("limit_offset_bps" in calls[0].body, false);
});

test("stop / take-profit orders require trigger_price", () => {
  const tool = findTool("place_order")!;
  for (const type of [
    "stop_limit",
    "stop_market",
    "take_profit_limit",
    "take_profit_market",
  ] as const) {
    const base: Record<string, unknown> = {
      market_id: "BTC-USDX-PERP",
      side: "buy",
      type,
      size: "1",
    };
    // Limit-family variants also need a price; supply it so trigger_price is the
    // only thing missing under test.
    if (type === "stop_limit" || type === "take_profit_limit")
      base.price = "100";
    assert.equal(
      tool.zod.safeParse(base).success,
      false,
      `${type} requires trigger_price`,
    );
    assert.equal(
      tool.zod.safeParse({ ...base, trigger_price: "100" }).success,
      true,
      `${type} accepted with trigger_price`,
    );
  }
});

test("trigger_price is rejected on non-triggerable order types", () => {
  const tool = findTool("place_order")!;
  // limit
  assert.equal(
    tool.zod.safeParse({
      market_id: "BTC-USDX-PERP",
      side: "buy",
      type: "limit",
      size: "1",
      price: "100",
      trigger_price: "99",
    }).success,
    false,
    "trigger_price rejected on limit orders",
  );
  // market
  assert.equal(
    tool.zod.safeParse({
      market_id: "BTC-USDX-PERP",
      side: "buy",
      type: "market",
      size: "1",
      trigger_price: "99",
    }).success,
    false,
    "trigger_price rejected on market orders",
  );
  // trailing_limit
  assert.equal(
    tool.zod.safeParse({
      market_id: "BTC-USDX-PERP",
      side: "buy",
      type: "trailing_limit",
      size: "1",
      trailing_offset_bps: 50,
      limit_offset_bps: 10,
      trigger_price: "99",
    }).success,
    false,
    "trigger_price rejected on trailing_limit orders",
  );
});

test("stop_limit requires a price; stop_market rejects one", () => {
  const tool = findTool("place_order")!;
  assert.equal(
    tool.zod.safeParse({
      market_id: "BTC-USDX-PERP",
      side: "buy",
      type: "stop_limit",
      size: "1",
      trigger_price: "100",
    }).success,
    false,
    "stop_limit requires price",
  );
  assert.equal(
    tool.zod.safeParse({
      market_id: "BTC-USDX-PERP",
      side: "buy",
      type: "stop_market",
      size: "1",
      trigger_price: "100",
      price: "101",
    }).success,
    false,
    "stop_market rejects a price",
  );
});

test("trailing offsets are rejected on stop orders; limit_offset only on trailing_limit", () => {
  const tool = findTool("place_order")!;
  // trailing_offset_bps is not valid on a (non-trailing) stop_market.
  assert.equal(
    tool.zod.safeParse({
      market_id: "BTC-USDX-PERP",
      side: "sell",
      type: "stop_market",
      size: "1",
      trigger_price: "100",
      trailing_offset_bps: 50,
    }).success,
    false,
    "trailing_offset_bps rejected on stop_market",
  );
  // trailing_stop must not carry a limit_offset_bps (that's trailing_limit only).
  assert.equal(
    tool.zod.safeParse({
      market_id: "BTC-USDX-PERP",
      side: "sell",
      type: "trailing_stop",
      size: "1",
      trailing_offset_bps: 50,
      limit_offset_bps: 10,
    }).success,
    false,
    "limit_offset_bps rejected on trailing_stop",
  );
  // trailing_stop is valid with just trailing_offset_bps.
  assert.equal(
    tool.zod.safeParse({
      market_id: "BTC-USDX-PERP",
      side: "sell",
      type: "trailing_stop",
      size: "1",
      trailing_offset_bps: 50,
    }).success,
    true,
    "trailing_stop accepted with only trailing_offset_bps",
  );
});

test("dropped liveness tools are no longer registered", () => {
  // v0.7.0 removed /health and /ready from the public contract (ENG-6136).
  assert.equal(findTool("get_health"), undefined);
  assert.equal(findTool("get_readiness"), undefined);
  assert.ok(findTool("get_service_status"), "the surviving /status tool stays");
});

// ── v0.7.2 portfolio-parity tools (ENG-6461) ─────────────────────────────────

test("portfolio-parity reads sign the v1 account routes", async () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["get_account_state", {}, `${BASE}/api/v1/account/state`],
    ["get_account_fees", {}, `${BASE}/api/v1/account/fees`],
    ["get_portfolio_history", {}, `${BASE}/api/v1/account/portfolio-history`],
  ];
  for (const [name, args, url] of cases) {
    const calls = await capture(fullClient(), (c) =>
      findTool(name)!.handler(c, args),
    );
    assert.equal(calls[0].method, "GET", name);
    assert.equal(calls[0].url, url, name);
    assert.ok(calls[0].headers.get("x-signature"), `${name} is HMAC-signed`);
    assert.equal(calls[0].body, undefined, `${name} sends no body`);

    // Every one of these is account-scoped: no credentials must mean a hard
    // failure, never an unsigned request that would resolve to another account.
    const noCreds = new ExchangeClient({
      directBaseUrl: BASE,
      gatewayBaseUrl: BASE,
    });
    await assert.rejects(
      () => findTool(name)!.handler(noCreds, args) as Promise<unknown>,
      MissingCredentialsError,
      `${name} requires credentials`,
    );
  }
});

test("get_portfolio_history forwards window + limit, and omits them when unset", async () => {
  const both = await capture(fullClient(), (c) =>
    findTool("get_portfolio_history")!.handler(c, {
      window: "week",
      limit: 168,
    }),
  );
  assert.equal(
    both[0].url,
    `${BASE}/api/v1/account/portfolio-history?window=week&limit=168`,
  );

  // Omitted args produce a bare path (no stray "?"), so the signed query
  // string matches what the server verifies over.
  const bare = await capture(fullClient(), (c) =>
    findTool("get_portfolio_history")!.handler(c, {}),
  );
  assert.equal(bare[0].url, `${BASE}/api/v1/account/portfolio-history`);

  const onlyWindow = await capture(fullClient(), (c) =>
    findTool("get_portfolio_history")!.handler(c, { window: "all" }),
  );
  assert.equal(
    onlyWindow[0].url,
    `${BASE}/api/v1/account/portfolio-history?window=all`,
  );
});

test("get_portfolio_history validates window as a closed enum and caps limit", () => {
  const tool = findTool("get_portfolio_history")!;
  for (const window of ["day", "week", "month", "all"]) {
    assert.equal(tool.zod.safeParse({ window }).success, true, window);
  }
  // Anything outside the enum is rejected client-side rather than forwarded:
  // the upstream answers 400 invalid_window, and nothing free-form should ever
  // reach the signed query string.
  for (const window of ["hour", "DAY", "", "day; drop", 1, null]) {
    assert.equal(tool.zod.safeParse({ window }).success, false, String(window));
  }
  assert.equal(tool.zod.safeParse({ limit: 366 }).success, true);
  assert.equal(tool.zod.safeParse({ limit: 367 }).success, false);
  assert.equal(tool.zod.safeParse({ limit: 0 }).success, false);
  assert.equal(tool.zod.safeParse({ limit: -1 }).success, false);
  assert.equal(tool.zod.safeParse({ limit: 1.5 }).success, false);
  // Strict schema: unknown keys are rejected, not silently dropped.
  assert.equal(tool.zod.safeParse({ cursor: "abc" }).success, false);
});

test("argless portfolio-parity tools take no arguments", () => {
  for (const name of ["get_account_state", "get_account_fees"]) {
    const tool = findTool(name)!;
    assert.equal(tool.zod.safeParse({}).success, true, name);
    assert.equal(tool.zod.safeParse({ limit: 10 }).success, false, name);
  }
});

const POSITION_TOOLS = ["get_balance", "get_positions", "get_account_state"];

test("tools returning positions document the enriched risk fields", () => {
  // The enrichment is null-able with a companion <field>_error; an agent that
  // read null as zero would compute nonsense risk, so the descriptions must
  // say so on every tool that returns a Position.
  for (const name of POSITION_TOOLS) {
    const { description } = findTool(name)!;
    assert.match(description, /notional_value/, name);
    assert.match(description, /_error/, name);
    assert.match(description, /never as zero/, name);
    // All five genuinely-nullable fields, `leverage` included — the list is
    // what a model pattern-matches against, so a partial one misleads.
    for (const field of [
      "notional_value",
      "margin_used",
      "roe",
      "max_leverage",
      "leverage",
    ]) {
      assert.match(description, new RegExp(`\`${field}\``), `${name}/${field}`);
    }
  }
});

test("position descriptions do not claim funding_paid is nullable", () => {
  // Spec v0.7.2: `funding_paid` is `allOf: [Decimal]` with no null branch,
  // documented always-present ("0" when nothing accrued), and there is no
  // `funding_paid_error` property in the document at all — Position has
  // exactly five `_error` companions. Telling a model otherwise inverts the
  // null-vs-zero rule the rest of the note exists to enforce: it would report
  // an authoritative zero as unknown and look for a key that never appears.
  for (const name of POSITION_TOOLS) {
    const { description } = findTool(name)!;
    assert.doesNotMatch(description, /funding_paid_error/, name);
    assert.match(description, /`funding_paid` is NOT one of those/, name);
    assert.match(description, /always present/, name);
  }
});

test("account tools warn that the authoritative-margin 502 is not an empty account", () => {
  // v0.7.2 added `502 authoritative_margin_unavailable` to BOTH /account/state
  // and /account/summary. The summary is the tool that advertises
  // `withdrawable`, the field whose authoritative-margin dependency causes the
  // fail-closed, so it needs the retry guidance just as much.
  for (const name of ["get_account_state", "get_account_summary"]) {
    const { description } = findTool(name)!;
    assert.match(description, /authoritative_margin_unavailable/, name);
    assert.match(description, /retry/i, name);
    assert.match(description, /do NOT read the error as a flat or empty/, name);
  }
  assert.match(findTool("get_account_summary")!.description, /withdrawable/);
});

test("tool names are unique and admin tools carry the adminOnly flag", () => {
  const names = tools.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, "no duplicate tool names");
  for (const name of ["list_tiers", "set_tier", "delete_tier"]) {
    assert.equal(findTool(name)!.adminOnly, true, `${name} is adminOnly`);
  }
});

test("every tool declares the spec operations it calls", () => {
  // The tool -> spec-operation mapping (ENG-7788 / docs/coverage-unit.md). The
  // authoritative check is scripts/check_spec_drift.py, which also verifies each
  // declaration against the handler next to it and against the pinned spec. This
  // one is here because `test` is a required status check and `spec-drift` is not
  // yet: it will not catch a *wrong* operation, but it catches a missing or
  // malformed declaration before the mapping can rot.
  const opFormat = /^(GET|POST|PUT|PATCH|DELETE) \/\S*$/;
  // Tools that legitimately call nothing. Kept in step with TOOLS_WITHOUT_OPS in
  // scripts/check_spec_drift.py; get_deposit_target describes a capability that
  // is not built server-side yet and returns a local "pending" payload.
  const NO_OPS = new Set(["get_deposit_target"]);

  for (const tool of tools) {
    assert.ok(Array.isArray(tool.ops), `${tool.name} declares ops`);
    for (const op of tool.ops) {
      assert.match(op, opFormat, `${tool.name} op "${op}" is METHOD /path`);
      // Placeholders must be the spec's `{name}` form, not a TS template hole:
      // endpoints.txt is intersected with spec paths as raw strings downstream.
      assert.doesNotMatch(op, /\$\{/, `${tool.name} op "${op}" has no \${...}`);
    }
    assert.equal(
      tool.ops.length === 0,
      NO_OPS.has(tool.name),
      `${tool.name}: an empty ops list must be one of the known no-op tools`,
    );
    assert.equal(
      new Set(tool.ops).size,
      tool.ops.length,
      `${tool.name} declares no duplicate operations`,
    );
  }
});

test("the tool -> operation mapping is not 1:1", () => {
  // The premise of the unit decision (docs/coverage-unit.md): a tool is not an
  // operation, so the two counts are different quantities and neither may be
  // reported as the other.
  //
  // Worth knowing while reading this: the totals currently COINCIDE — 66 tools
  // declaring 66 distinct operations — which is why the test asserts the mapping's
  // shape rather than an inequality of totals. A coincidence of totals is exactly
  // how the tool count came to be reported as an operation count in the first
  // place (ENG-7964), and 66 is still not the coverage figure: three of those
  // operations are the non-contract `/demo/*` routes, so endpoints.txt publishes
  // 63. Asserting `distinct !== tools.length` would be both brittle and, today,
  // false — the shape below is the property that actually holds.
  const multi = tools.filter((t) => t.ops.length > 1).map((t) => t.name);
  assert.ok(multi.length > 0, "some tool covers multiple operations");
  assert.ok(multi.includes("cancel_order"), "cancel_order covers two");
  assert.ok(
    tools.some((t) => t.ops.length === 0),
    "some tool covers no operation",
  );
});
