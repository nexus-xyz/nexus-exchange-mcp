/**
 * Network axis tests (ENG-6456).
 *
 * The theme is that every ambiguous input must FAIL rather than resolve to
 * something plausible: the spec's rule is that an unrecognized network is
 * treated as real funds, so "guessed a target" is the outcome these tests exist
 * to make impossible.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { loadConfig, normalizeBaseUrl } from "../src/config.js";
import {
  DEFAULT_NETWORK,
  NETWORKS,
  NETWORK_IDS,
  resolveNetworkId,
} from "../src/networks.js";
import { tools } from "../src/tools/index.js";

/** Build an env with nothing inherited from the real process. */
const env = (over: Record<string, string> = {}) =>
  over as unknown as NodeJS.ProcessEnv;

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

test("the default target is unchanged: testnet, play funds, legacy host", () => {
  // The whole change must be a no-op for anyone who sets nothing. This is the
  // regression that would silently repoint every existing install.
  const cfg = loadConfig(env());
  assert.equal(cfg.directBaseUrl, "https://exchange.nexus.xyz");
  assert.equal(cfg.gatewayBaseUrl, "https://exchange.nexus.xyz/api/exchange");
  assert.equal(cfg.network, "testnet");
  assert.equal(cfg.funds, "play");
  assert.equal(DEFAULT_NETWORK, "testnet");
});

test("a set-but-empty override falls back to the network, not to an error", () => {
  // .env.example ships `NEXUS_EXCHANGE_API_URL=` (empty) and a shell exports it
  // as "", so an empty value must mean "unset" rather than reaching URL parsing.
  for (const blank of ["", "   ", "\n"]) {
    const cfg = loadConfig(env({ NEXUS_EXCHANGE_API_URL: blank }));
    assert.equal(cfg.directBaseUrl, "https://exchange.nexus.xyz");
    assert.equal(cfg.network, "testnet");
  }
  // Same for the network variable itself.
  const cfg = loadConfig(env({ NEXUS_EXCHANGE_NETWORK: "  " }));
  assert.equal(cfg.network, "testnet");
});

test("mainnet is a named host, never interpolated from the network name", () => {
  // EDR-006: `api.{network}.nexus.xyz` resolves for every environment that can
  // be rehearsed and fails only on real funds. Guard the literal.
  assert.equal(NETWORKS.mainnet.durableRestBase, "https://api.nexus.xyz/v1");
  assert.ok(
    !NETWORKS.mainnet.durableRestBase.includes("mainnet."),
    "mainnet host must not be api.mainnet.nexus.xyz",
  );
  assert.equal(
    NETWORKS.testnet.durableRestBase,
    "https://api.testnet.nexus.xyz/v1",
  );
  assert.equal(NETWORKS.mainnet.funds, "real");
  assert.equal(NETWORKS.mainnet.faucet, false);
});

test("selecting mainnet fails loudly instead of guessing a URL", () => {
  // No DNS and no operation mapped onto its /v1 base: any URL would be a guess,
  // on the one network where a guess moves real money.
  assert.throws(() => loadConfig(env({ NEXUS_EXCHANGE_NETWORK: "mainnet" })), {
    message: /no reachable host yet[\s\S]*real money/,
  });
});

test("an unknown network throws and never falls back to a default", () => {
  for (const bad of ["devnet", "wat", "testnett", "main net"]) {
    assert.throws(
      () => loadConfig(env({ NEXUS_EXCHANGE_NETWORK: bad })),
      /Unknown NEXUS_EXCHANGE_NETWORK/,
      `${bad} must be rejected`,
    );
  }
});

test("network lookup is an allowlist, not an object index", () => {
  // `NETWORKS[raw]` would hand back Object.prototype for these and turn a typo
  // into a truthy, attribute-less "network".
  for (const bad of [
    "__proto__",
    "constructor",
    "toString",
    "hasOwnProperty",
  ]) {
    assert.throws(
      () => resolveNetworkId(bad),
      /Unknown NEXUS_EXCHANGE_NETWORK/,
      `${bad} must not resolve`,
    );
  }
});

test("network ids are case- and whitespace-insensitive", () => {
  assert.equal(resolveNetworkId("  TestNet \n"), "testnet");
  assert.equal(resolveNetworkId("LOCAL"), "local");
});

test("release channels are demoted to a URL override, not aliased", () => {
  // Aliasing `beta` to testnet would re-conflate release channel with network,
  // which is the confusion this axis removes.
  for (const channel of ["beta", "stable", "staging", "prod"]) {
    assert.throws(
      () => resolveNetworkId(channel),
      /release channel, not a network[\s\S]*NEXUS_EXCHANGE_API_URL/,
      `${channel} must point the user at the override`,
    );
  }
});

test("local resolves to the indexer and is never a fallback", () => {
  const cfg = loadConfig(env({ NEXUS_EXCHANGE_NETWORK: "local" }));
  assert.equal(cfg.directBaseUrl, "http://localhost:9090");
  assert.equal(cfg.network, "local");
  // Nothing may degrade to localhost: a failed public host must stay failed,
  // because silently succeeding against localhost hides a misconfigured client.
  assert.throws(() => loadConfig(env({ NEXUS_EXCHANGE_NETWORK: "mainnet" })));
});

test("a URL override wins for transport and carries the declared network", () => {
  // mainnet + explicit URL is the sanctioned way to reach real funds before the
  // durable host is live, so it must be allowed — and must stay labelled real.
  const cfg = loadConfig(
    env({
      NEXUS_EXCHANGE_NETWORK: "mainnet",
      NEXUS_EXCHANGE_API_URL: "https://api.nexus.xyz",
    }),
  );
  assert.equal(cfg.directBaseUrl, "https://api.nexus.xyz");
  assert.equal(cfg.network, "mainnet");
  assert.equal(cfg.funds, "real");
});

test("an override with no network is custom/unknown funds, never play", () => {
  const cfg = loadConfig(
    env({ NEXUS_EXCHANGE_API_URL: "https://staging.example.com" }),
  );
  assert.equal(cfg.network, "custom");
  // "unknown" must not be read as "safe to experiment on".
  assert.equal(cfg.funds, "unknown");
  assert.notEqual(cfg.funds, "play");
});

test("a base URL carrying a query or fragment is rejected", () => {
  // `${base}${path}?${query}` would bury the path inside a query value and send
  // a signed request somewhere else entirely.
  assert.throws(
    () => normalizeBaseUrl("https://h.example/?x=1"),
    /query string or fragment/,
  );
  assert.throws(
    () => normalizeBaseUrl("https://h.example/#frag"),
    /query string or fragment/,
  );
});

test("a base URL with embedded credentials or a bad scheme is rejected", () => {
  assert.throws(
    () => normalizeBaseUrl("https://user:pw@h.example"),
    /must not embed credentials/,
  );
  assert.throws(
    () => normalizeBaseUrl("file:///etc/passwd"),
    /must use http or https/,
  );
  assert.throws(
    () => normalizeBaseUrl("not a url"),
    /not a valid absolute URL/,
  );
});

test("base URL normalization trims trailing slashes and keeps the path", () => {
  assert.equal(normalizeBaseUrl("https://h.example///"), "https://h.example");
  assert.equal(
    normalizeBaseUrl("https://h.example/api/exchange/"),
    "https://h.example/api/exchange",
  );
});

test("ws endpoints hang off the gateway base with the scheme swapped", () => {
  // /ws, /stream, /ws/token and /ws-tokens carry no per-path servers override in
  // the spec, so they resolve against the ROOT (gateway) server — not the direct
  // /api/v1 host. Getting this wrong points the caller at a host that 404s.
  const cfg = loadConfig(env());
  assert.equal(cfg.wsUrl, "wss://exchange.nexus.xyz/api/exchange");
  assert.equal(
    cfg.wsAuthenticatedUrl,
    "wss://exchange.nexus.xyz/api/exchange/ws",
  );
  assert.equal(
    cfg.wsMarketDataUrl,
    "wss://exchange.nexus.xyz/api/exchange/stream",
  );

  const local = loadConfig(env({ NEXUS_EXCHANGE_NETWORK: "local" }));
  assert.equal(local.wsUrl, "ws://localhost:9090/api/exchange");
});

test("plaintext http to a non-loopback host warns; loopback stays quiet", () => {
  const warned = captureStderr(() =>
    loadConfig(env({ NEXUS_EXCHANGE_API_URL: "http://indexer.internal" })),
  );
  assert.match(warned, /plaintext http/);

  for (const host of [
    "http://localhost:9090",
    "http://127.0.0.1:9090",
    "http://[::1]:9090",
  ]) {
    const quiet = captureStderr(() =>
      loadConfig(env({ NEXUS_EXCHANGE_API_URL: host })),
    );
    assert.equal(quiet, "", `${host} is loopback and must not warn`);
  }
});

test("the network map and the loaded config are frozen", () => {
  // A base URL that can be rewritten at runtime is a redirect for every signed
  // request that follows it.
  assert.ok(Object.isFrozen(NETWORKS));
  assert.ok(Object.isFrozen(NETWORKS.mainnet));
  try {
    (NETWORKS.testnet as { baseUrl: string | null }).baseUrl = "http://evil";
  } catch {
    /* strict mode throws; non-strict silently ignores — assert the value below */
  }
  assert.equal(NETWORKS.testnet.baseUrl, "https://exchange.nexus.xyz");

  const cfg = loadConfig(env());
  try {
    (cfg as { directBaseUrl: string }).directBaseUrl = "http://evil";
  } catch {
    /* as above */
  }
  assert.equal(cfg.directBaseUrl, "https://exchange.nexus.xyz");
});

test("every declared network id has a descriptor and vice versa", () => {
  assert.deepEqual([...NETWORK_IDS].sort(), Object.keys(NETWORKS).sort());
  for (const id of NETWORK_IDS) {
    assert.equal(NETWORKS[id].id, id, `${id} descriptor is self-consistent`);
  }
});

test("ws token tools return the endpoint the token is for", async () => {
  const findTool = (name: string) => tools.find((t) => t.name === name)!;
  const stub = {
    request: async () => ({ token: "tok_123" }),
    wsAuthenticatedUrl: () => "wss://h.example/api/exchange/ws",
    wsMarketDataUrl: () => "wss://h.example/api/exchange/stream",
  } as never;

  const authed = (await findTool("get_ws_token").handler(stub, {})) as Record<
    string,
    unknown
  >;
  assert.equal(authed.token, "tok_123");
  assert.equal(authed.ws_endpoint, "wss://h.example/api/exchange/ws");
  // The token must not be duplicated into the URL — one credential, one place.
  assert.ok(!String(authed.ws_endpoint).includes("tok_123"));

  const legacy = (await findTool("get_ws_token_legacy").handler(
    stub,
    {},
  )) as Record<string, unknown>;
  assert.equal(legacy.ws_endpoint, "wss://h.example/api/exchange/stream");
});

test("a non-object upstream payload is passed through unreshaped", async () => {
  const stub = {
    request: async () => "plain-token-string",
    wsAuthenticatedUrl: () => "wss://h.example/api/exchange/ws",
  } as never;
  const out = await tools
    .find((t) => t.name === "get_ws_token")!
    .handler(stub, {});
  assert.equal(out, "plain-token-string");
});
