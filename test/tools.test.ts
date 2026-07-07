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

test("get_health hits /health unsigned", async () => {
  const calls = await capture(fullClient(), (c) =>
    findTool("get_health")!.handler(c, {}),
  );
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].url, `${BASE}/health`);
  // Public — no auth headers.
  assert.equal(calls[0].headers.get("x-api-key"), null);
  assert.equal(calls[0].headers.get("authorization"), null);
});

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

test("tool names are unique and admin tools carry the adminOnly flag", () => {
  const names = tools.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, "no duplicate tool names");
  for (const name of ["list_tiers", "set_tier", "delete_tier"]) {
    assert.equal(findTool(name)!.adminOnly, true, `${name} is adminOnly`);
  }
});
