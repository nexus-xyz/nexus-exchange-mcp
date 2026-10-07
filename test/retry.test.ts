import { test } from "node:test";
import assert from "node:assert/strict";
import { ExchangeApiError, ExchangeClient } from "../src/client.js";

/**
 * Retry policy (ENG-20359): reads retry transient failures with backoff and
 * honour `Retry-After`; writes never retry; the 429 an agent finally sees says
 * how long to wait. Sleep is injected so no test waits in real time.
 */

type Reply = Response | Error;

/** Serve `replies` in order through `globalThis.fetch`, recording methods. */
async function withFetch(
  replies: Reply[],
  run: (client: ExchangeClient, delays: number[]) => Promise<void>,
): Promise<string[]> {
  const methods: string[] = [];
  const delays: number[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    methods.push(init.method ?? "GET");
    const reply = replies.shift();
    if (!reply) throw new Error("unscripted request");
    if (reply instanceof Error) throw reply;
    return reply;
  }) as typeof fetch;
  try {
    const client = new ExchangeClient(
      {
        baseUrl: "http://example.test",
        apiKey: "nx_test",
        apiSecret: "00".repeat(32),
      },
      async (ms) => {
        delays.push(ms);
      },
    );
    await run(client, delays);
  } finally {
    globalThis.fetch = realFetch;
  }
  return methods;
}

const status = (code: number, headers: Record<string, string> = {}) =>
  new Response("{}", { status: code, headers });
const ok = () => new Response("[]", { status: 200 });

test("a GET retries a 429 and waits at least Retry-After", async () => {
  const methods = await withFetch(
    [status(429, { "retry-after": "2" }), ok()],
    async (client, delays) => {
      assert.deepEqual(await client.request({ path: "/markets" }), []);
      assert.equal(delays.length, 1);
      assert.ok(delays[0] >= 2000, `waited ${delays[0]}ms`);
    },
  );
  assert.deepEqual(methods, ["GET", "GET"]);
});

test("an HTTP-date Retry-After is honoured too", async () => {
  // An HTTP-date has whole-second precision, so round up to a second boundary:
  // the wait is then at least 10s minus the few ms the test itself takes.
  const at = new Date(
    Math.ceil((Date.now() + 10_000) / 1000) * 1000,
  ).toUTCString();
  await withFetch(
    [status(429, { "retry-after": at }), ok()],
    async (client, delays) => {
      await client.request({ path: "/markets" });
      assert.ok(delays[0] >= 9_500, `waited ${delays[0]}ms`);
    },
  );
});

test("a Retry-After over 60s is capped at 60s", async () => {
  await withFetch(
    [status(429, { "retry-after": "120" }), ok()],
    async (client, delays) => {
      await client.request({ path: "/markets" });
      assert.deepEqual(delays, [60_000]);
    },
  );
});

test("an unparseable Retry-After falls back to backoff", async () => {
  await withFetch(
    [status(429, { "retry-after": "abc" }), ok()],
    async (client, delays) => {
      await client.request({ path: "/markets" });
      assert.ok(delays[0] >= 125 && delays[0] <= 250, `${delays[0]}`);
    },
  );
});

test("a GET retries a 408", async () => {
  const methods = await withFetch([status(408), ok()], async (client) => {
    await client.request({ path: "/markets" });
  });
  assert.deepEqual(methods, ["GET", "GET"]);
});

test("a GET retries 5xx and network failures with growing backoff", async () => {
  const methods = await withFetch(
    [status(503), new TypeError("fetch failed"), ok()],
    async (client, delays) => {
      await client.request({ path: "/markets" });
      // Equal jitter: attempt n waits in [base*2^n / 2, base*2^n].
      assert.equal(delays.length, 2);
      assert.ok(delays[0] >= 125 && delays[0] <= 250, `${delays[0]}`);
      assert.ok(delays[1] >= 250 && delays[1] <= 500, `${delays[1]}`);
    },
  );
  assert.equal(methods.length, 3);
});

test("a GET gives up after two retries", async () => {
  const methods = await withFetch(
    [status(500), status(500), status(500)],
    async (client) => {
      await assert.rejects(
        () => client.request({ path: "/markets" }),
        (err: Error) => err instanceof ExchangeApiError && err.status === 500,
      );
    },
  );
  assert.equal(methods.length, 3);
});

test("a 4xx other than 408/429 is not retried", async () => {
  const methods = await withFetch([status(400)], async (client) => {
    await assert.rejects(() => client.request({ path: "/markets" }));
  });
  assert.equal(methods.length, 1);
});

test("writes are never retried, even on 429 or 503", async () => {
  for (const method of ["POST", "DELETE"] as const) {
    for (const reply of [status(429, { "retry-after": "1" }), status(503)]) {
      const methods = await withFetch([reply], async (client, delays) => {
        await assert.rejects(() =>
          client.request({ method, path: "/orders", signed: true, body: {} }),
        );
        assert.equal(delays.length, 0);
      });
      assert.deepEqual(methods, [method]);
    }
  }
});

test("the 429 that reaches the agent says how long to wait", async () => {
  await withFetch(
    [
      status(429, { "retry-after": "3" }),
      status(429, { "retry-after": "3" }),
      status(429, { "retry-after": "3" }),
    ],
    async (client) => {
      await assert.rejects(
        () => client.request({ path: "/markets" }),
        (err: Error) =>
          err instanceof ExchangeApiError &&
          err.retryAfterMs === 3000 &&
          err.message.includes("retry after 3s"),
      );
    },
  );
  // A write's 429 carries the hint on its first and only attempt.
  await withFetch([status(429)], async (client) => {
    await assert.rejects(
      () =>
        client.request({
          method: "POST",
          path: "/orders",
          signed: true,
          body: {},
        }),
      /rate limited; the server sent no Retry-After/,
    );
  });
});
