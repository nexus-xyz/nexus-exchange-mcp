import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ExchangeClient } from "../src/client.js";
import { createServerForClient } from "../src/server.js";
import { simulate } from "../src/paper.js";
import { isReadOnly, tools, visibleTools } from "../src/tools/index.js";
import type { ExchangeConfig } from "../src/config.js";

/**
 * Agent safety modes (ENG-20366): read-only drops every tool that writes,
 * write tools carry MCP annotations, and paper mode simulates orders against
 * the public book without sending one.
 */

const BOOK = {
  bids: [
    [99, 1],
    [98, 2],
  ],
  asks: [
    [101, 1],
    [102, 2],
  ],
} as { bids: [number, number][]; asks: [number, number][] };

async function connect(mode: Pick<ExchangeConfig, "readOnly" | "paper">) {
  const client = new ExchangeClient({
    baseUrl: "http://example.invalid",
    apiKey: "nx_test",
    apiSecret: "00",
    enableAdminTools: true,
  });
  const server = createServerForClient(client, mode);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const mcp = new Client({ name: "test", version: "0" }, { capabilities: {} });
  await mcp.connect(a);
  return mcp;
}

/** Answer every request with the fixture book and record what was asked. */
async function withBook<T>(run: (calls: string[]) => Promise<T>): Promise<T> {
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push(`${init.method ?? "GET"} ${url}`);
    return new Response(JSON.stringify(BOOK), { status: 200 });
  }) as typeof fetch;
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("read-only keeps exactly the tools that do not write", () => {
  const all = visibleTools({ enableAdminTools: true });
  const ro = visibleTools({ enableAdminTools: true, readOnly: true });
  assert.ok(ro.length > 0 && ro.length < all.length);
  for (const t of ro) assert.ok(isReadOnly(t), t.name);
  for (const name of [
    "create_order",
    "cancel_order",
    "cancel_all_orders",
    "edit_order",
    "deposit",
    "login",
    "create_api_key",
    "set_tier",
    "place_order",
  ]) {
    assert.ok(!ro.some((t) => t.name === name), name);
  }
  for (const name of ["fetch_balance", "fetch_order_book", "preview_order"]) {
    assert.ok(
      ro.some((t) => t.name === name),
      name,
    );
  }
});

test("every tool that calls anything but GET declares its annotations", () => {
  for (const t of tools) {
    if (t.ops.length && t.ops.every((op) => op.startsWith("GET "))) continue;
    assert.ok(t.annotations, t.name);
  }
});

test("tools/list advertises annotations, and read-only lists no writes", async () => {
  const full = (await (await connect({})).listTools()).tools;
  const byName = new Map(full.map((t) => [t.name, t.annotations]));
  assert.deepEqual(byName.get("fetch_balance"), { readOnlyHint: true });
  assert.equal(byName.get("create_order")?.destructiveHint, true);
  assert.equal(byName.get("cancel_all_orders")?.idempotentHint, true);

  const mcp = await connect({ readOnly: true });
  const ro = (await mcp.listTools()).tools;
  assert.ok(ro.every((t) => t.annotations?.readOnlyHint === true));
  const res = await mcp.callTool({ name: "create_order", arguments: {} });
  assert.equal(res.isError, true);
});

test("simulate: a market buy walks the asks for a VWAP fill", () => {
  const r = simulate(BOOK, {
    market_id: "M",
    side: "buy",
    type: "market",
    size: "2",
  });
  assert.equal(r.status, "filled");
  assert.equal(r.average_price, "101.5");
  assert.deepEqual(r.fills, [
    { price: "101", size: "1" },
    { price: "102", size: "1" },
  ]);
});

test("simulate: a market order larger than the book cancels the remainder", () => {
  const r = simulate(BOOK, {
    market_id: "M",
    side: "sell",
    type: "market",
    size: "5",
  });
  assert.equal(r.status, "partially_filled_remainder_cancelled");
  assert.equal(r.filled_size, "3");
  assert.equal(r.remaining_size, "2");
});

test("simulate: a crossing GTC limit fills what crosses and rests the rest", () => {
  const r = simulate(BOOK, {
    market_id: "M",
    side: "buy",
    type: "limit",
    size: "2",
    price: "101",
  });
  assert.equal(r.status, "partially_filled");
  assert.equal(r.filled_size, "1");
  assert.equal(r.rests, true);
});

test("simulate: a non-crossing limit rests unfilled; IOC, FOK and PostOnly do not", () => {
  const base = {
    market_id: "M",
    side: "buy" as const,
    type: "limit",
    size: "2",
  };
  assert.equal(simulate(BOOK, { ...base, price: "100" }).status, "open");
  assert.equal(
    simulate(BOOK, { ...base, price: "100", time_in_force: "IOC" }).status,
    "cancelled",
  );
  assert.equal(
    simulate(BOOK, { ...base, price: "101", time_in_force: "FOK" }).status,
    "rejected",
  );
  assert.equal(
    simulate(BOOK, { ...base, price: "101", time_in_force: "PostOnly" }).status,
    "rejected",
  );
});

test("paper mode: orders simulate against the book and never reach the engine", async () => {
  const mcp = await connect({ paper: true });
  const names = (await mcp.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes("create_order"));
  assert.ok(!names.includes("edit_order"));
  assert.ok(!names.includes("deposit"));

  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await mcp.callTool({ name, arguments: args });
    const text = (res.content as Array<{ text: string }>)[0].text;
    assert.ok(!res.isError, `${name}: ${text}`);
    return JSON.parse(text);
  };

  await withBook(async (calls) => {
    const placed = await call("create_order", {
      market_id: "BTC-USDX-PERP",
      side: "buy",
      type: "limit",
      size: "1",
      price: "100",
    });
    assert.equal(placed.simulated, true);
    assert.equal(placed.status, "open");

    const open = await call("fetch_open_orders", {});
    assert.deepEqual(
      open.orders.map((o: { order_id: string }) => o.order_id),
      [placed.order_id],
    );
    await call("cancel_order", {
      order_id: placed.order_id,
      market_id: "BTC-USDX-PERP",
    });
    assert.equal((await call("fetch_open_orders", {})).orders.length, 0);

    // The only request paper mode made was the public book fetch.
    assert.deepEqual(calls, [
      "GET http://example.invalid/markets/BTC-USDX-PERP/orderbook",
    ]);
  });
});
