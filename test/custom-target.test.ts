/**
 * The first-class custom target (ENG-9828, parent ENG-9823).
 *
 * Two themes, and they pull in opposite directions on purpose:
 *
 *  1. A private stage must be describable — URL, label, funds, faucet, gateway
 *     shape — through ONE documented mechanism, with no hostname for any such
 *     stage shipped in this package. Every host below is an RFC 2606 reserved
 *     name (`example.invalid` cannot resolve), and every label is generic.
 *  2. Nothing may be assumed on the way there. A target that never declared
 *     whose money it holds must REFUSE the tools that cannot be undone, and the
 *     legacy `NEXUS_EXCHANGE_API_URL` path must keep resolving byte-identically
 *     for configs that predate all of this.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../src/config.js";
import {
  ExchangeClient,
  FundsGuardError,
  MissingCredentialsError,
} from "../src/client.js";
import {
  MAX_TARGET_LABEL_LENGTH,
  validateTargetLabel,
} from "../src/networks.js";
import { findTool, tools } from "../src/tools/index.js";

/** Build an env with nothing inherited from the real process. */
const env = (over: Record<string, string> = {}) =>
  over as unknown as NodeJS.ProcessEnv;

/** A host that can never resolve (RFC 2606), for every target under test. */
const HOST = "https://exchange.example.invalid";

/** The minimum honest custom bundle: URL + label + funds. */
const BUNDLE = {
  NEXUS_EXCHANGE_NETWORK: "custom",
  NEXUS_EXCHANGE_API_URL: HOST,
  NEXUS_EXCHANGE_NETWORK_LABEL: "dev",
  NEXUS_EXCHANGE_FUNDS: "play",
};

/** Run `fn` with stderr captured, so warning assertions do not print. */
function captureStderr(fn: () => void): string {
  const original = console.error;
  let out = "";
  console.error = (...args: unknown[]) => {
    out += args.join(" ") + "\n";
  };
  try {
    fn();
  } finally {
    console.error = original;
  }
  return out;
}

// ── The bundle ───────────────────────────────────────────────────────────────

test("a custom bundle from env resolves to one descriptor, frozen", () => {
  const cfg = loadConfig(
    env({
      ...BUNDLE,
      NEXUS_EXCHANGE_FAUCET: "1",
      NEXUS_EXCHANGE_FUNDS: "real",
    }),
  );
  assert.deepEqual(
    { ...cfg.target },
    {
      id: "custom",
      label: "dev",
      funds: "real",
      faucet: true,
      restBase: HOST,
      gatewayPath: "/api/exchange",
    },
  );
  // `Object.freeze` on the config is shallow, so the target carries its own
  // immutability: a `funds` that can be rewritten at runtime is a dead guard.
  assert.ok(Object.isFrozen(cfg.target));
  try {
    (cfg.target as { funds: string }).funds = "play";
  } catch {
    /* strict mode throws; non-strict silently ignores — assert the value */
  }
  assert.equal(cfg.target?.funds, "real");
});

test("the custom bundle drives transport the same way a network does", () => {
  const cfg = loadConfig(env(BUNDLE));
  assert.equal(cfg.directBaseUrl, HOST);
  assert.equal(cfg.gatewayBaseUrl, `${HOST}/api/exchange`);
  assert.equal(cfg.wsUrl, "wss://exchange.example.invalid/api/exchange");
  assert.equal(
    cfg.wsAuthenticatedUrl,
    "wss://exchange.example.invalid/api/exchange/ws",
  );
});

test("a custom stage can declare the bare-origin gateway shape", () => {
  // A private indexer serves the legacy routes at its root — the `local` shape.
  // Without this the gateway prefix is appended unconditionally, which 404s every
  // legacy route and hands `get_ws_token` a ws_endpoint nothing listens on.
  const cfg = loadConfig(env({ ...BUNDLE, NEXUS_EXCHANGE_GATEWAY_PATH: "/" }));
  assert.equal(cfg.target?.gatewayPath, "");
  assert.equal(cfg.gatewayBaseUrl, HOST);
  assert.equal(cfg.wsMarketDataUrl, "wss://exchange.example.invalid/stream");

  // Spelled "/" and not "" on purpose: a set-but-blank variable means "unset"
  // everywhere else here, so it cannot also mean "serve at the root". Blank
  // therefore keeps the public-gateway default rather than silently changing it.
  assert.equal(
    loadConfig(env({ ...BUNDLE, NEXUS_EXCHANGE_GATEWAY_PATH: "  " })).target
      ?.gatewayPath,
    "/api/exchange",
  );

  // Closed set: anything else is a declaration error, never a guessed prefix.
  for (const bad of ["/api/v1", "api/exchange", "/API/exchange", "/ws"]) {
    assert.throws(
      () => loadConfig(env({ ...BUNDLE, NEXUS_EXCHANGE_GATEWAY_PATH: bad })),
      /NEXUS_EXCHANGE_GATEWAY_PATH must be/,
      `${bad} must be rejected`,
    );
  }
  // A trailing slash normalizes rather than failing.
  assert.equal(
    loadConfig(
      env({ ...BUNDLE, NEXUS_EXCHANGE_GATEWAY_PATH: "/api/exchange/" }),
    ).target?.gatewayPath,
    "/api/exchange",
  );
});

test("the custom target needs a host, a label and funds — none defaulted", () => {
  assert.throws(
    () => loadConfig(env({ NEXUS_EXCHANGE_NETWORK: "custom" })),
    /needs a host[\s\S]*ships no hostname/,
  );
  assert.throws(
    () => loadConfig(env({ ...BUNDLE, NEXUS_EXCHANGE_NETWORK_LABEL: "" })),
    /requires NEXUS_EXCHANGE_NETWORK_LABEL/,
  );
  assert.throws(
    () => loadConfig(env({ ...BUNDLE, NEXUS_EXCHANGE_FUNDS: "" })),
    /requires NEXUS_EXCHANGE_NETWORK_LABEL/,
  );
  // `custom` is spelled case-insensitively, like every other network value.
  assert.equal(
    loadConfig(env({ ...BUNDLE, NEXUS_EXCHANGE_NETWORK: " CUSTOM " })).target
      ?.id,
    "custom",
  );
});

test("funds is a closed tri-state, read as an allowlist not an object index", () => {
  for (const funds of ["real", "play", "unknown"]) {
    assert.equal(
      loadConfig(env({ ...BUNDLE, NEXUS_EXCHANGE_FUNDS: funds })).target?.funds,
      funds,
      funds,
    );
  }
  // `NEXUS_EXCHANGE_FUNDS=__proto__` must not hand back a truthy non-answer.
  for (const bad of ["__proto__", "constructor", "toString", "yes", "0", "1"]) {
    assert.throws(
      () => loadConfig(env({ ...BUNDLE, NEXUS_EXCHANGE_FUNDS: bad })),
      /NEXUS_EXCHANGE_FUNDS must be one of/,
      `${bad} must be rejected`,
    );
  }
  // Case and surrounding whitespace are fine, as with every network value; it
  // is the value itself that must be one of three.
  assert.equal(
    loadConfig(env({ ...BUNDLE, NEXUS_EXCHANGE_FUNDS: " REAL \n" })).target
      ?.funds,
    "real",
  );
});

test("a bundle variable without NEXUS_EXCHANGE_NETWORK=custom is refused", () => {
  // Silently ignoring `NEXUS_EXCHANGE_FUNDS=play` is the worst outcome: the
  // operator believes they configured a safety property that is not in effect.
  // Honoring it would create a second, undocumented way to describe a target.
  for (const [name, value] of [
    ["NEXUS_EXCHANGE_FUNDS", "play"],
    ["NEXUS_EXCHANGE_NETWORK_LABEL", "dev"],
    ["NEXUS_EXCHANGE_FAUCET", "1"],
    ["NEXUS_EXCHANGE_GATEWAY_PATH", ""],
  ] as const) {
    const base = { NEXUS_EXCHANGE_API_URL: HOST, [name]: value };
    if (value === "") {
      // Blank reads as unset, so `.env.example`'s empty placeholders are safe.
      assert.doesNotThrow(() => loadConfig(env(base)));
      continue;
    }
    assert.throws(
      () => loadConfig(env(base)),
      new RegExp(`${name} is only read when NEXUS_EXCHANGE_NETWORK=custom`),
      `${name} must not be silently dropped`,
    );
  }
});

// ── The label ────────────────────────────────────────────────────────────────

test("a target label is constrained to what is safe as a credential key", () => {
  // Fleet-wide rule (parent ENG-9823, resolved question 2): the label is the key
  // stored credentials are namespaced under in the sibling clients, so a label
  // that can name a path — or normalize onto another label — is refused. This
  // server namespaces nothing, and enforces it anyway: an invariant honored in
  // four clients out of five is not an invariant.
  for (const ok of ["dev", "example", "one-two", "a.b_c-1", "A1"]) {
    assert.equal(validateTargetLabel(ok, "X"), ok, ok);
  }
  // Surrounding whitespace is trimmed (a shell heredoc adds a newline).
  assert.equal(validateTargetLabel("  dev\n", "X"), "dev");

  for (const bad of [
    "../other", // traversal
    "one/two", // path separator
    "one:two", // keyring separator
    "one two", // whitespace
    "one\ntwo", // log forging
    "one\u0000two", // NUL
    "café", // non-ASCII: normalization makes keys ambiguous
    "",
    "   ",
    ".",
    "..",
    "x".repeat(MAX_TARGET_LABEL_LENGTH + 1),
  ]) {
    assert.throws(
      () => validateTargetLabel(bad, "NEXUS_EXCHANGE_NETWORK_LABEL"),
      /NEXUS_EXCHANGE_NETWORK_LABEL/,
      `${JSON.stringify(bad)} must be rejected`,
    );
  }
  assert.equal(
    validateTargetLabel("x".repeat(MAX_TARGET_LABEL_LENGTH), "X").length,
    MAX_TARGET_LABEL_LENGTH,
  );
});

test("a rejected label cannot forge a log line through the error message", () => {
  // The message echoes untrusted input, so control characters are replaced
  // before they reach stderr — a bare newline would otherwise look like a new
  // record. The value is quoted and clipped, never interpolated raw.
  const raw = "a\nnexus-exchange-mcp: INFO: all clear";
  assert.throws(
    () => validateTargetLabel(raw, "NEXUS_EXCHANGE_NETWORK_LABEL"),
    (err: unknown) => {
      const message = (err as Error).message;
      assert.ok(!message.includes("\n"), "no raw newline reaches the message");
      return true;
    },
  );
});

// ── The legacy path stays exactly as it was ──────────────────────────────────

test("NEXUS_EXCHANGE_API_URL alone is unchanged: same URLs, undeclared funds", () => {
  // The sugar path (parent ENG-9823, resolved question 1). It is not deprecated:
  // still the ergonomic path for tests and local development. What it reports is
  // what it always reported — a `custom` label with funds it does not know.
  const cfg = loadConfig(env({ NEXUS_EXCHANGE_API_URL: HOST }));
  assert.equal(cfg.directBaseUrl, HOST);
  assert.equal(cfg.gatewayBaseUrl, `${HOST}/api/exchange`);
  assert.equal(cfg.target?.id, "custom");
  assert.equal(cfg.target?.label, "custom");
  assert.equal(cfg.target?.funds, "unknown");
  assert.equal(cfg.target?.faucet, false);
  // The gateway path is taken literally for a bare override, as before: a caller
  // who needs the bare-origin shape says so through the bundle.
  assert.equal(cfg.target?.gatewayPath, "/api/exchange");

  // A value that still carries the old gateway suffix normalizes as it always did.
  const suffixed = loadConfig(
    env({ NEXUS_EXCHANGE_API_URL: `${HOST}/api/exchange` }),
  );
  assert.equal(suffixed.directBaseUrl, HOST);
  assert.equal(suffixed.gatewayBaseUrl, `${HOST}/api/exchange`);
});

test("plaintext http still warns on a custom stage, loopback stays quiet", () => {
  // A private stage on plain http is exactly the case this warning exists for:
  // HMAC over http exposes the key id and signature to anyone on the path.
  const warned = captureStderr(() =>
    loadConfig(
      env({
        ...BUNDLE,
        NEXUS_EXCHANGE_API_URL: "http://exchange.example.invalid",
      }),
    ),
  );
  assert.match(warned, /plaintext http/);

  const quiet = captureStderr(() =>
    loadConfig(
      env({ ...BUNDLE, NEXUS_EXCHANGE_API_URL: "http://localhost:9090" }),
    ),
  );
  assert.equal(quiet, "", "loopback carries no network exposure");
});

test("a custom URL is validated exactly like the override always was", () => {
  for (const [bad, message] of [
    ["https://user:pw@exchange.example.invalid", /must not embed credentials/],
    ["https://exchange.example.invalid/?x=1", /query string or fragment/],
    ["file:///etc/passwd", /must use http or https/],
    ["not a url", /not a valid absolute URL/],
  ] as const) {
    assert.throws(
      () => loadConfig(env({ ...BUNDLE, NEXUS_EXCHANGE_API_URL: bad })),
      message,
      bad,
    );
  }
});

// ── The guard ────────────────────────────────────────────────────────────────

/** A fully-credentialled client on the given env, so only funds can refuse. */
function clientFor(over: Record<string, string>): ExchangeClient {
  return new ExchangeClient(
    loadConfig(
      env({
        ...over,
        NEXUS_EXCHANGE_API_KEY: "nx_test",
        NEXUS_EXCHANGE_API_SECRET: "00",
      }),
    ),
  );
}

/**
 * Every tool that must not run against a target of unknown provenance, and what
 * it requires. Asserted as a literal set so adding a money-moving tool without
 * classifying it shows up here as a reviewable diff rather than as silence.
 */
const GUARDED = {
  place_order: "declared-funds",
  place_orders_batch: "declared-funds",
  amend_order: "declared-funds",
  deposit_collateral: "declared-funds",
  submit_deposit: "declared-funds",
  adjust_isolated_margin: "declared-funds",
  create_bridge_deposit_address: "declared-funds",
  claim_credit: "play-funds",
  claim_faucet: "play-funds",
} as const;

test("the guarded set is exactly the tools that move value", () => {
  const declared = Object.fromEntries(
    tools.filter((t) => t.fundsGuard).map((t) => [t.name, t.fundsGuard]),
  );
  assert.deepEqual(declared, GUARDED);
});

test("undeclared funds refuses every guarded tool, before any request", async () => {
  // The whole point of ENG-9828: `funds: "unknown"` used to be carried as a
  // label and acted on by nothing. A bare URL is the sugar that produces it.
  const client = clientFor({ NEXUS_EXCHANGE_API_URL: HOST });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("no request may leave the process for a refused tool");
  }) as typeof fetch;
  try {
    for (const name of Object.keys(GUARDED)) {
      await assert.rejects(
        () => findTool(name)!.handler(client, {}) as Promise<unknown>,
        FundsGuardError,
        `${name} must refuse an undeclared target`,
      );
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a config with no target at all fails closed the same way", async () => {
  // An embedder building an ExchangeConfig by hand has declared nothing, which
  // is not the same as declaring play funds.
  const client = new ExchangeClient({
    directBaseUrl: HOST,
    gatewayBaseUrl: HOST,
    apiKey: "nx_test",
    apiSecret: "00",
  });
  await assert.rejects(
    () => findTool("place_order")!.handler(client, {}) as Promise<unknown>,
    FundsGuardError,
  );
  assert.equal(client.target(), undefined);
});

test("declaring funds — either way — unlocks the irreversible tools", async () => {
  // `real` is a legitimate declaration, not a second refusal: the operator has
  // said what the money is, which is all this guard ever asked for.
  for (const funds of ["real", "play"]) {
    const client = clientFor({ ...BUNDLE, NEXUS_EXCHANGE_FUNDS: funds });
    assert.doesNotThrow(
      () => client.assertFundsAllow("declared-funds", "t"),
      funds,
    );
  }
  const undeclared = clientFor({ ...BUNDLE, NEXUS_EXCHANGE_FUNDS: "unknown" });
  assert.throws(
    () => undeclared.assertFundsAllow("declared-funds", "t"),
    FundsGuardError,
    "an explicit `unknown` is honest, and still refuses",
  );
});

test("the funding tools match play funds positively, so unknown fails closed", () => {
  // `funds !== "real"` would let an undeclared target through as if it were
  // safe. Matching `play` is what makes the tri-state fail in the right
  // direction (parent ENG-9823, resolved question 3).
  const allowed = clientFor({ ...BUNDLE, NEXUS_EXCHANGE_FAUCET: "1" });
  assert.doesNotThrow(() =>
    allowed.assertFundsAllow("play-funds", "claim_faucet"),
  );

  for (const funds of ["real", "unknown"]) {
    assert.throws(
      () =>
        clientFor({
          ...BUNDLE,
          NEXUS_EXCHANGE_FUNDS: funds,
          NEXUS_EXCHANGE_FAUCET: "1",
        }).assertFundsAllow("play-funds", "claim_faucet"),
      FundsGuardError,
      funds,
    );
  }
});

test("a faucet is absent until declared, separately from funds", () => {
  // "Not real money" does not imply "has a faucet", so the funding tools must not
  // route at one that is not there.
  const noFaucet = clientFor(BUNDLE);
  assert.equal(noFaucet.target()?.faucet, false);
  assert.throws(
    () => noFaucet.assertFundsAllow("play-funds", "claim_faucet"),
    /declares no faucet[\s\S]*NEXUS_EXCHANGE_FAUCET=1/,
  );
  // A named play-funds network has one, so nothing changes there.
  const local = clientFor({ NEXUS_EXCHANGE_NETWORK: "local" });
  assert.doesNotThrow(() =>
    local.assertFundsAllow("play-funds", "claim_faucet"),
  );
});

test("a named network keeps working unguarded-as-before, mainnet included", () => {
  // testnet/local are declared play funds with a faucet, so every guarded tool
  // stays available; `mainnet` + an explicit URL is declared real funds, so the
  // irreversible tools work and only the synthetic-funding ones refuse.
  const local = clientFor({ NEXUS_EXCHANGE_NETWORK: "local" });
  for (const need of ["declared-funds", "play-funds"] as const) {
    assert.doesNotThrow(() => local.assertFundsAllow(need, "t"), need);
  }

  const mainnet = clientFor({
    NEXUS_EXCHANGE_NETWORK: "mainnet",
    NEXUS_EXCHANGE_API_URL: HOST,
  });
  assert.doesNotThrow(() =>
    mainnet.assertFundsAllow("declared-funds", "place_order"),
  );
  assert.throws(
    () => mainnet.assertFundsAllow("play-funds", "claim_faucet"),
    /reports funds "real"/,
  );
});

test("reads and cancels are never funds-guarded", async () => {
  // A guardrail that blocks cancelling would trap a caller holding open risk,
  // which is the opposite of the point. Reads are safe against any host.
  for (const name of [
    "cancel_order",
    "preview_order",
    "list_markets",
    "get_positions",
    "get_open_orders",
    "set_cancel_on_disconnect",
  ]) {
    assert.equal(findTool(name)?.fundsGuard, undefined, name);
  }

  // Not just unclassified — actually reachable on an undeclared target. Reaching
  // the credential check proves the funds guard let it through.
  const client = new ExchangeClient({
    directBaseUrl: HOST,
    gatewayBaseUrl: HOST,
  });
  await assert.rejects(
    () =>
      findTool("cancel_order")!.handler(client, {
        order_id: "abc",
        market_id: "BTC-USDX-PERP",
      }) as Promise<unknown>,
    MissingCredentialsError,
  );
});

test("the guard is wired into the tool objects themselves, and frozen there", async () => {
  // Both transports and every test reach handlers through these same objects, so
  // the check cannot be skipped by a caller that bypasses server.ts — and cannot
  // be swapped back out at runtime.
  for (const tool of tools) {
    assert.ok(Object.isFrozen(tool), `${tool.name} is frozen`);
  }
  const guarded = findTool("place_order")!;
  try {
    (guarded as { handler: unknown }).handler = async () => "bypassed";
  } catch {
    /* strict mode throws; non-strict silently ignores — assert the behaviour */
  }
  const client = new ExchangeClient({
    directBaseUrl: HOST,
    gatewayBaseUrl: HOST,
  });
  await assert.rejects(
    () => guarded.handler(client, {}) as Promise<unknown>,
    FundsGuardError,
  );
});

test("a guard refusal rejects, it does not throw synchronously", () => {
  // Every caller treats a handler as returning a promise; a synchronous throw
  // would escape `.catch()` and bypass the transport's error framing.
  const client = new ExchangeClient({
    directBaseUrl: HOST,
    gatewayBaseUrl: HOST,
  });
  const returned = findTool("place_order")!.handler(client, {});
  assert.ok(returned instanceof Promise);
  return assert.rejects(() => returned, FundsGuardError);
});
