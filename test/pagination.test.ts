/**
 * Cursor pagination across the five paginated list tools (spec v0.7.2).
 *
 * These tools return `{ items, next_cursor }` and the *agent* drives the loop,
 * so what has to be right is the stop condition. All four endings are pinned
 * here:
 *
 *   - a cursor is present            → the agent should call again;
 *   - `X-Next-Cursor` is absent      → `next_cursor: null`, done, not an error;
 *   - an empty page carries a cursor → still not the end, keep going;
 *   - the same cursor comes back     → `next_cursor` forced to null plus a
 *                                      `pagination_error`, so the agent stops
 *                                      instead of looping forever on one page
 *                                      and does not mistake a truncated
 *                                      history for a complete one.
 *
 * Plus the per-endpoint `limit` maxima, which differ per route and are enforced
 * in the tool schema so an out-of-schema value is never signed or forwarded.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ExchangeClient } from "../src/client.js";
import { findTool } from "../src/tools/index.js";
import type { ExchangeConfig } from "../src/config.js";

const BASE = "http://example.test";

/** The five tools that carry v0.7.2 cursor pagination. */
const PAGINATED_TOOLS = [
  "get_trades",
  "get_fills",
  "get_order_history",
  "get_closed_positions",
  "get_equity_history",
] as const;

/** Minimal args to invoke each paginated tool (only trades needs a market). */
const BASE_ARGS: Record<string, Record<string, unknown>> = {
  get_trades: { market_id: "BTC-USDX-PERP" },
  get_fills: {},
  get_order_history: {},
  get_closed_positions: {},
  get_equity_history: {},
};

interface PagedResult {
  items: unknown;
  next_cursor: string | null;
  pagination_error?: string;
}

function fullClient(): ExchangeClient {
  const cfg: ExchangeConfig = {
    directBaseUrl: BASE,
    gatewayBaseUrl: BASE,
    apiKey: "nx_test",
    apiSecret: "00",
    enableAdminTools: false,
  } as ExchangeConfig;
  return new ExchangeClient(cfg);
}

/** One scripted upstream reply. */
interface Reply {
  body: unknown;
  /** Value of the `X-Next-Cursor` response header; omit to send none. */
  nextCursor?: string;
}

/**
 * Run `fn` with `fetch` stubbed to serve `replies` in order, recording each
 * request. A request past the end of the script throws rather than silently
 * repeating a reply, so a test that over-fetches fails loudly.
 */
async function withReplies<T>(
  replies: Reply[],
  fn: () => Promise<T>,
): Promise<{ result: T; calls: Array<{ url: string; headers: Headers }> }> {
  const calls: Array<{ url: string; headers: Headers }> = [];
  const realFetch = globalThis.fetch;
  let i = 0;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: new Headers(init.headers) });
    const reply = replies[i++];
    if (!reply) throw new Error(`unscripted request #${i}: ${url}`);
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (reply.nextCursor !== undefined) {
      headers["x-next-cursor"] = reply.nextCursor;
    }
    return new Response(JSON.stringify(reply.body), { status: 200, headers });
  }) as typeof fetch;
  try {
    const result = await fn();
    return { result, calls };
  } finally {
    globalThis.fetch = realFetch;
  }
}

// -- traversal --------------------------------------------------------------

test("a paginated tool returns items plus the X-Next-Cursor value", async () => {
  const { result, calls } = await withReplies(
    [{ body: [{ id: "f1" }], nextCursor: "cur-2" }],
    () =>
      findTool("get_fills")!.handler(fullClient(), {
        limit: 2,
      }) as Promise<PagedResult>,
  );
  assert.deepEqual(result.items, [{ id: "f1" }]);
  assert.equal(result.next_cursor, "cur-2");
  assert.equal(result.pagination_error, undefined);
  assert.equal(calls[0].url, `${BASE}/api/v1/fills?limit=2`);
});

test("the cursor is forwarded verbatim and included in the signature", async () => {
  // Cursors are opaque, so a token with URL-hostile characters must be
  // percent-encoded on the wire and signed exactly as sent.
  const opaque = "eyJvIjoxMH0=+/";
  const { result, calls } = await withReplies(
    [{ body: [{ id: "f2" }] }],
    () =>
      findTool("get_fills")!.handler(fullClient(), {
        limit: 2,
        cursor: opaque,
      }) as Promise<PagedResult>,
  );
  assert.equal(result.next_cursor, null);
  assert.equal(
    calls[0].url,
    `${BASE}/api/v1/fills?limit=2&cursor=eyJvIjoxMH0%3D%2B%2F`,
  );
  assert.ok(calls[0].headers.get("x-signature"), "signed");
  // Round-trips back to the exact token the server handed out.
  assert.equal(new URL(calls[0].url).searchParams.get("cursor"), opaque);
});

test("a full agent-driven walk reaches the last page", async () => {
  // What an agent actually does: call, read next_cursor, call again, stop on
  // null. Two pages of results then a terminal page.
  const client = fullClient();
  const collected: unknown[] = [];
  const urls: string[] = [];

  const script: Reply[] = [
    { body: [{ id: 1 }], nextCursor: "c2" },
    { body: [{ id: 2 }], nextCursor: "c3" },
    { body: [{ id: 3 }] },
  ];
  await withReplies(script, async () => {
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = (await findTool("get_order_history")!.handler(client, {
        limit: 1,
        ...(cursor === undefined ? {} : { cursor }),
      })) as PagedResult;
      collected.push(...(page.items as unknown[]));
      if (page.next_cursor === null) return;
      cursor = page.next_cursor;
    }
    throw new Error("walk did not terminate");
  }).then(({ calls }) => urls.push(...calls.map((c) => c.url)));

  assert.deepEqual(collected, [{ id: 1 }, { id: 2 }, { id: 3 }]);
  assert.deepEqual(urls, [
    `${BASE}/api/v1/orders/history?limit=1`,
    `${BASE}/api/v1/orders/history?limit=1&cursor=c2`,
    `${BASE}/api/v1/orders/history?limit=1&cursor=c3`,
  ]);
});

// -- termination ------------------------------------------------------------

test("an absent X-Next-Cursor header means the last page, not an error", async () => {
  for (const name of PAGINATED_TOOLS) {
    const { result } = await withReplies(
      [{ body: [{ n: 1 }] }],
      () =>
        findTool(name)!.handler(
          fullClient(),
          BASE_ARGS[name],
        ) as Promise<PagedResult>,
    );
    assert.equal(result.next_cursor, null, name);
    assert.equal(result.pagination_error, undefined, name);
    assert.deepEqual(result.items, [{ n: 1 }], name);
  }
});

test("an empty first page terminates cleanly", async () => {
  const { result } = await withReplies(
    [{ body: [] }],
    () =>
      findTool("get_closed_positions")!.handler(
        fullClient(),
        {},
      ) as Promise<PagedResult>,
  );
  assert.deepEqual(result.items, []);
  assert.equal(result.next_cursor, null);
  assert.equal(result.pagination_error, undefined);
});

test("an empty page that still carries a cursor is not the end", async () => {
  // A sparse window must not truncate the walk: the agent has to be told to
  // keep going, so the cursor is passed through untouched.
  const { result } = await withReplies(
    [{ body: [], nextCursor: "cur-9" }],
    () =>
      findTool("get_equity_history")!.handler(
        fullClient(),
        {},
      ) as Promise<PagedResult>,
  );
  assert.deepEqual(result.items, []);
  assert.equal(result.next_cursor, "cur-9");
});

test("a present-but-empty cursor header is treated as absent", async () => {
  // An empty cursor cannot be sent back; forwarding it would make the agent
  // re-request the first page forever.
  for (const value of ["", "   "]) {
    const { result } = await withReplies(
      [{ body: [{ id: "x" }], nextCursor: value }],
      () =>
        findTool("get_fills")!.handler(
          fullClient(),
          {},
        ) as Promise<PagedResult>,
    );
    assert.equal(result.next_cursor, null, JSON.stringify(value));
  }
});

test("a repeated cursor stops the walk and flags the truncation", async () => {
  // Pathological upstream: hands back the same cursor it was given. Returning
  // that to the agent would loop forever, one tool call per iteration.
  const { result, calls } = await withReplies(
    [{ body: [{ id: "f2" }], nextCursor: "stuck" }],
    () =>
      findTool("get_fills")!.handler(fullClient(), {
        cursor: "stuck",
      }) as Promise<PagedResult>,
  );
  // The loop-breaker: null, so an agent following the documented rule stops.
  assert.equal(result.next_cursor, null);
  // ...but the results are explicitly NOT presented as the end of the history.
  assert.match(result.pagination_error!, /same pagination cursor/);
  assert.match(result.pagination_error!, /INCOMPLETE/);
  assert.match(result.pagination_error!, /Do not retry/);
  // The items still reach the agent — the page was real.
  assert.deepEqual(result.items, [{ id: "f2" }]);
  assert.equal(calls.length, 1, "one request, no internal retry");
});

test("an agent loop terminates against a permanently stuck upstream", async () => {
  // The end-to-end version of the guard: the same loop as the happy-path walk,
  // against an upstream that always echoes the cursor. It must exit.
  const client = fullClient();
  let requests = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    requests += 1;
    if (requests > 20) throw new Error("runaway pagination loop");
    return new Response(JSON.stringify([{ id: requests }]), {
      status: 200,
      headers: { "content-type": "application/json", "x-next-cursor": "stuck" },
    });
  }) as typeof fetch;
  try {
    let cursor: string | undefined;
    let pages = 0;
    let stalled: string | undefined;
    for (;;) {
      const page = (await findTool("get_fills")!.handler(client, {
        ...(cursor === undefined ? {} : { cursor }),
      })) as PagedResult;
      pages += 1;
      stalled = page.pagination_error;
      if (page.next_cursor === null) break;
      cursor = page.next_cursor;
      assert.ok(pages < 5, "loop should have terminated by now");
    }
    // Page 1 has no requested cursor to compare against, so the guard fires on
    // page 2 — the first request that could have proved the cursor is stuck.
    assert.equal(pages, 2);
    assert.match(stalled!, /cannot advance/);
    assert.equal(requests, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a first page whose cursor equals nothing is not mistaken for a repeat", async () => {
  // The guard compares against the cursor that was *sent*. On the first page
  // none was sent, so any cursor the server returns is genuine progress.
  const { result } = await withReplies(
    [{ body: [{ id: 1 }], nextCursor: "abc" }],
    () =>
      findTool("get_fills")!.handler(fullClient(), {}) as Promise<PagedResult>,
  );
  assert.equal(result.next_cursor, "abc");
  assert.equal(result.pagination_error, undefined);
});

// -- schemas ---------------------------------------------------------------

test("every paginated tool advertises and accepts a cursor", () => {
  for (const name of PAGINATED_TOOLS) {
    const tool = findTool(name)!;
    const props = (tool.inputSchema as { properties: Record<string, unknown> })
      .properties;
    assert.ok(props.cursor, `${name} advertises cursor in tools/list`);
    assert.equal(
      tool.zod.safeParse({ ...BASE_ARGS[name], cursor: "abc" }).success,
      true,
      name,
    );
    // Cursor stays optional — the first page takes no cursor.
    assert.equal(tool.zod.safeParse(BASE_ARGS[name]).success, true, name);
    // An empty cursor is not a cursor; reject it rather than send `cursor=`.
    assert.equal(
      tool.zod.safeParse({ ...BASE_ARGS[name], cursor: "" }).success,
      false,
      name,
    );
    // Non-strings are rejected client-side rather than stringified into the
    // signed query.
    for (const bad of [1, null, true, {}]) {
      assert.equal(
        tool.zod.safeParse({ ...BASE_ARGS[name], cursor: bad }).success,
        false,
        `${name} cursor=${JSON.stringify(bad)}`,
      );
    }
  }
});

test("paginated tools keep their own per-endpoint limit maximum", () => {
  // The maxima are NOT interchangeable — a single shared bound would either
  // reject valid requests or forward out-of-schema ones. In particular none of
  // these is 366: that bound belongs to /account/portfolio-history, which has
  // no cursor at all, and is below equity-history's own default of 720.
  const caps: Array<[string, number]> = [
    ["get_trades", 1000],
    ["get_fills", 1000],
    ["get_order_history", 500],
    ["get_closed_positions", 200],
    ["get_equity_history", 720],
  ];
  for (const [name, cap] of caps) {
    const tool = findTool(name)!;
    const args = BASE_ARGS[name];
    assert.equal(
      tool.zod.safeParse({ ...args, limit: cap }).success,
      true,
      `${name} accepts its maximum ${cap}`,
    );
    assert.equal(
      tool.zod.safeParse({ ...args, limit: cap + 1 }).success,
      false,
      `${name} rejects ${cap + 1}`,
    );
    assert.equal(
      tool.zod.safeParse({ ...args, limit: 0 }).success,
      false,
      name,
    );
    assert.equal(
      tool.zod.safeParse({ ...args, limit: 1.5 }).success,
      false,
      name,
    );
  }
  // Sanity: the two 1000-cap tools would previously have accepted anything.
  assert.equal(
    findTool("get_trades")!.zod.safeParse({
      market_id: "BTC-USDX-PERP",
      limit: 5000,
    }).success,
    false,
  );
});

test("only the five cursor-paginated endpoints take a cursor", () => {
  // The spec puts `cursor` on exactly five GETs. Advertising it anywhere else
  // would invite an agent to send a parameter the endpoint ignores and then
  // wait for a `next_cursor` that never comes.
  const paginated = new Set<string>(PAGINATED_TOOLS);
  for (const tool of [
    "get_portfolio_history",
    "get_positions",
    "get_open_orders",
    "get_account_state",
    "get_funding_payments",
    "list_deposits",
    "get_market_adl_events",
  ]) {
    const def = findTool(tool);
    if (!def || paginated.has(tool)) continue;
    const props = (def.inputSchema as { properties: Record<string, unknown> })
      .properties;
    assert.equal(props.cursor, undefined, `${tool} advertises no cursor`);
    assert.equal(
      def.zod.safeParse({ cursor: "abc" }).success,
      false,
      `${tool} rejects cursor`,
    );
  }
});

test("paginated tool descriptions tell an agent how to page and when to stop", () => {
  // The agent drives the loop from the description alone, so the envelope and
  // the stop condition have to be stated, not implied.
  for (const name of PAGINATED_TOOLS) {
    const { description } = findTool(name)!;
    assert.match(description, /next_cursor/, name);
    assert.match(description, /null when this is the last page/, name);
    assert.match(description, /ONE page, not a total/, name);
  }
});
