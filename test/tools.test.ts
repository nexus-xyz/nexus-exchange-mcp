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

test("history tools enforce the spec limit caps in their schemas", () => {
  const caps: Array<[string, number]> = [
    ["get_equity_history", 720],
    ["get_closed_positions", 200],
    ["get_order_history", 500],
    ["list_deposits", 100],
    ["get_funding_payments", 1000],
  ];
  for (const [name, cap] of caps) {
    const tool = findTool(name)!;
    assert.equal(tool.zod.safeParse({ limit: cap }).success, true, name);
    assert.equal(tool.zod.safeParse({ limit: cap + 1 }).success, false, name);
    assert.equal(tool.zod.safeParse({ limit: 0 }).success, false, name);
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

test("dropped liveness tools are no longer registered", () => {
  // v0.7.0 removed /health and /ready from the public contract (ENG-6136).
  assert.equal(findTool("get_health"), undefined);
  assert.equal(findTool("get_readiness"), undefined);
  assert.ok(findTool("get_service_status"), "the surviving /status tool stays");
});

test("tool names are unique and admin tools carry the adminOnly flag", () => {
  const names = tools.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, "no duplicate tool names");
  for (const name of ["list_tiers", "set_tier", "delete_tier"]) {
    assert.equal(findTool(name)!.adminOnly, true, `${name} is adminOnly`);
  }
});
