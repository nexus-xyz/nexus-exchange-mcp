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

import { deriveBases, loadConfig, normalizeBaseUrl } from "../src/config.js";
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

test("the default target is testnet on its durable host, play funds", () => {
  // Target IDENTITY must stay a no-op for anyone who sets nothing — testnet,
  // play funds — and that half is still the regression this pins.
  //
  // The BASE has now moved twice, both times deliberately. ENG-6221 moved it
  // off the bare origin, where `/api/v1/*` was the marketing app's 404. ENG-8869
  // moved the host: `exchange.nexus.xyz/api/exchange` proxies to a
  // decommissioned Cloud Run indexer and answers 500 on every route
  // (ENG-14039), so the shipped default was dead. `api.testnet.nexus.xyz` is
  // the durable host, and `/indexer` is the route prefix the deployment mounts
  // it under — the bare host 404s.
  const cfg = loadConfig(env());
  assert.equal(cfg.directBaseUrl, "https://api.testnet.nexus.xyz/indexer");
  assert.equal(cfg.gatewayBaseUrl, "https://api.testnet.nexus.xyz/indexer");
  assert.equal(cfg.target?.id, "testnet");
  assert.equal(cfg.target?.funds, "play");
  assert.equal(DEFAULT_NETWORK, "testnet");
  // The retired gateway must not survive anywhere in the default target: it is
  // not a fallback, it is a host that 500s.
  assert.ok(!cfg.directBaseUrl.includes("exchange.nexus.xyz/api/exchange"));
});

test("a set-but-empty override falls back to the network, not to an error", () => {
  // .env.example ships `NEXUS_EXCHANGE_API_URL=` (empty) and a shell exports it
  // as "", so an empty value must mean "unset" rather than reaching URL parsing.
  for (const blank of ["", "   ", "\n"]) {
    const cfg = loadConfig(env({ NEXUS_EXCHANGE_API_URL: blank }));
    assert.equal(cfg.directBaseUrl, "https://api.testnet.nexus.xyz/indexer");
    assert.equal(cfg.target?.id, "testnet");
  }
  // Same for the network variable itself.
  const cfg = loadConfig(env({ NEXUS_EXCHANGE_NETWORK: "  " }));
  assert.equal(cfg.target?.id, "testnet");
});

test("mainnet is a named host, never interpolated from the network name", () => {
  // EDR-006: `api.{network}.nexus.xyz` resolves for every environment that can
  // be rehearsed and fails only on real funds. Guard the literal.
  // Mainnet is untouched by ENG-8869 and keeps its `/v1`-in-base form. That
  // form is known-stale (ENG-9134 settled the layout as path-versioned
  // `/api/v1`), but it is deliberately NOT "corrected" here: `api.nexus.xyz`
  // has no DNS record at all, so nothing about its shape can be measured, and
  // testnet turning out to be `/indexer`-prefixed means host-root is not the
  // obvious correction either. Recording an unverified real-funds base is the
  // expensive mistake; it waits for ENG-8155's mainnet half.
  assert.equal(NETWORKS.mainnet.durableRestBase, "https://api.nexus.xyz/v1");
  assert.ok(
    !NETWORKS.mainnet.durableRestBase.includes("mainnet."),
    "mainnet host must not be api.mainnet.nexus.xyz",
  );
  // Testnet's WAS `/v1`-rooted and is not any more: it is measured, so ENG-9134
  // could be applied to it. It is also now the same string as `baseUrl`.
  assert.equal(
    NETWORKS.testnet.durableRestBase,
    "https://api.testnet.nexus.xyz/indexer",
  );
  assert.equal(NETWORKS.testnet.durableRestBase, NETWORKS.testnet.baseUrl);
  assert.ok(
    !NETWORKS.testnet.durableRestBase.endsWith("/v1"),
    "a /v1-in-base testnet value would compose /v1/api/v1/... (ENG-9134)",
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
  assert.equal(cfg.target?.id, "local");
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
  // `mainnet.gatewayPath` is NOT dead code just because `baseUrl` is null: this
  // is the path that reaches real money, and since ENG-6221 the field places
  // BOTH surfaces, so it decides where every /api/v1 call lands here. The value
  // is a convention, not a measurement — nothing is mapped onto api.nexus.xyz
  // and its durable base is /v1-rooted — and the convention it follows is the
  // one every other undeclared shape in this package resolves to. Pinned so
  // that stays a decision rather than a leftover.
  assert.equal(cfg.directBaseUrl, "https://api.nexus.xyz/api/exchange");
  assert.equal(cfg.gatewayBaseUrl, "https://api.nexus.xyz/api/exchange");
  assert.equal(cfg.target?.id, "mainnet");
  assert.equal(cfg.target?.funds, "real");
  // The network's own metadata rides along, so a faucet call still refuses here.
  assert.equal(cfg.target?.faucet, false);

  // The other half: a real-funds deployment that serves at its ROOT is not
  // stuck with that convention. It declares the shape through the full bundle,
  // which is what makes the default above safe to keep — the escape hatch is
  // tested, not just documented.
  const bareRoot = loadConfig(
    env({
      NEXUS_EXCHANGE_NETWORK: "custom",
      NEXUS_EXCHANGE_API_URL: "https://api.nexus.xyz",
      NEXUS_EXCHANGE_NETWORK_LABEL: "mainnet-direct",
      NEXUS_EXCHANGE_FUNDS: "real",
      NEXUS_EXCHANGE_GATEWAY_PATH: "/",
    }),
  );
  assert.equal(bareRoot.directBaseUrl, "https://api.nexus.xyz");
  assert.equal(bareRoot.gatewayBaseUrl, "https://api.nexus.xyz");
  assert.equal(bareRoot.target?.funds, "real");
});

test("an override with no network is custom/unknown funds, never play", () => {
  // Deprecated as of ENG-10957 and otherwise unchanged; the notice it prints is
  // captured here and asserted on in custom-target.test.ts.
  let cfg!: ReturnType<typeof loadConfig>;
  captureStderr(() => {
    cfg = loadConfig(
      env({ NEXUS_EXCHANGE_API_URL: "https://staging.example.com" }),
    );
  });
  assert.equal(cfg.target?.id, "custom");
  assert.equal(cfg.target?.label, "custom");
  // "unknown" must not be read as "safe to experiment on".
  assert.equal(cfg.target?.funds, "unknown");
  assert.notEqual(cfg.target?.funds, "play");
  // Faucet is absent until declared: "not real money" does not imply it exists.
  assert.equal(cfg.target?.faucet, false);
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
  // Userinfo with NO password is the form that reads as a hostname to a human:
  // `https://h.example@evil.example` is a request to evil.example carrying
  // "h.example" as a username. Rejected because `parsed.username` is set, not
  // because a colon appeared — pinned here because the sibling SDKs differ on
  // exactly this shape (py accepts it), so a regression would be silent.
  assert.throws(
    () => normalizeBaseUrl("https://h.example@evil.example"),
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

test("ws endpoints are the published /v1 socket base, not the bare host", () => {
  // ENG-17132: the public edge routes no WebSocket path at a host's root
  // (`wss://api.testnet.nexus.xyz/stream` is a 404); `/v1/stream` upgrades
  // (101) and `/v1/ws?token=x` reaches the handler (401), measured 2026-09-23.
  // `/v1` is the published prefix (spec `ws_url`, nexus#12253).
  const cfg = loadConfig(env());
  assert.equal(cfg.wsUrl, "wss://api.testnet.nexus.xyz/v1");
  assert.equal(cfg.wsAuthenticatedUrl, "wss://api.testnet.nexus.xyz/v1/ws");
  assert.equal(cfg.wsMarketDataUrl, "wss://api.testnet.nexus.xyz/v1/stream");
  // The durable value and the one a config actually hands `create_ws_token` are
  // the same string by construction, so they cannot drift apart again.
  assert.equal(NETWORKS.testnet.durableWsUrl, cfg.wsUrl);

  // Local is NOT `…/api/exchange`: the indexer serves the legacy routes at its
  // root, so appending the gateway prefix would hand the caller a ws_endpoint
  // nothing listens on. `gatewayPath` is what keeps the two apart.
  const local = loadConfig(env({ NEXUS_EXCHANGE_NETWORK: "local" }));
  assert.equal(local.wsUrl, "ws://localhost:9090");
  assert.equal(local.wsAuthenticatedUrl, "ws://localhost:9090/ws");
  assert.equal(local.wsMarketDataUrl, "ws://localhost:9090/stream");
  assert.equal(local.gatewayBaseUrl, "http://localhost:9090");
});

test("the gateway path is per-network, not appended unconditionally", () => {
  // The bug this pins: `deriveBases` used to append `/api/exchange` always, but
  // the spec's ROOT `servers` list is not uniform — the public host carries the
  // gateway path and local development is the bare origin. Deriving the wrong
  // one 404s every legacy route and misdirects the minted WebSocket token.
  //
  // These expectations are checked against the spec by invariant 4 in
  // scripts/check_spec_drift.py, which runs where openapi.pinned.json exists
  // (it is gitignored and fetched by that job, so a unit test cannot read it);
  // here they are asserted as literals so the derivation itself is covered.
  //
  // They are no longer all spec root servers. Testnet's is a recorded
  // deliberate divergence (SPEC_LEADING_BASES in that script): the pinned spec
  // still publishes a `/v1`-rooted durable base and knows nothing of the
  // `/indexer` route prefix. Correcting the spec is ENG-9962.
  //
  // ENG-8869 note: testnet used to be the `/api/exchange` half of this pair.
  // Its deployment is now route-prefixed and carries `/indexer` in `baseUrl`,
  // so its `gatewayPath` is "" — the prefix moved fields, it did not vanish,
  // and the composed base below still proves the derivation. Mainnet is the
  // remaining non-empty shape.
  assert.equal(NETWORKS.testnet.gatewayPath, "");
  assert.equal(NETWORKS.local.gatewayPath, "");
  assert.equal(NETWORKS.mainnet.gatewayPath, "/api/exchange");
  assert.equal(
    deriveBases(NETWORKS.testnet.baseUrl!, NETWORKS.testnet.gatewayPath)
      .gatewayBaseUrl,
    "https://api.testnet.nexus.xyz/indexer",
  );
  assert.equal(
    deriveBases(NETWORKS.local.baseUrl!, NETWORKS.local.gatewayPath)
      .gatewayBaseUrl,
    "http://localhost:9090",
  );
  // The gatewayPath DEFAULT keeps the old behaviour, so an existing caller that
  // passes no shape is unchanged. Note this is the function's default argument,
  // not any network's value — no built-in network reaches it any more.
  assert.equal(
    deriveBases("https://exchange.nexus.xyz").gatewayBaseUrl,
    "https://exchange.nexus.xyz/api/exchange",
  );
  // And the new base is passed through untouched: `deriveBases` strips only a
  // trailing `/api/exchange`, so a `…/indexer` base must survive intact.
  assert.equal(
    deriveBases("https://api.testnet.nexus.xyz/indexer", "").gatewayBaseUrl,
    "https://api.testnet.nexus.xyz/indexer",
  );
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
    // The bare override also prints the ENG-10957 deprecation notice, which is
    // asserted on in custom-target.test.ts. What matters here is that loopback
    // draws no plaintext warning: it carries no network exposure.
    assert.doesNotMatch(quiet, /plaintext/, `${host} is loopback`);
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
  assert.equal(
    NETWORKS.testnet.baseUrl,
    "https://api.testnet.nexus.xyz/indexer",
  );

  const cfg = loadConfig(env());
  try {
    (cfg as { directBaseUrl: string }).directBaseUrl = "http://evil";
  } catch {
    /* as above */
  }
  assert.equal(cfg.directBaseUrl, "https://api.testnet.nexus.xyz/indexer");
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

  const authed = (await findTool("create_ws_token").handler(
    stub,
    {},
  )) as Record<string, unknown>;
  assert.equal(authed.token, "tok_123");
  assert.equal(authed.ws_endpoint, "wss://h.example/api/exchange/ws");
  // The token must not be duplicated into the URL — one credential, one place.
  assert.ok(!String(authed.ws_endpoint).includes("tok_123"));

  const legacy = (await findTool("create_ws_token_legacy").handler(
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
    .find((t) => t.name === "create_ws_token")!
    .handler(stub, {});
  assert.equal(out, "plain-token-string");
});

test("an upstream ws_endpoint wins over the locally derived one", async () => {
  // The spec publishes only `{token}` today, but if the API starts returning the
  // endpoint itself then IT is authoritative — overwriting it with a value
  // derived from local config would send the caller to the wrong host.
  const stub = {
    request: async () => ({
      token: "tok_123",
      ws_endpoint: "wss://upstream.example/ws",
    }),
    wsAuthenticatedUrl: () => "wss://h.example/api/exchange/ws",
  } as never;
  const out = (await tools
    .find((t) => t.name === "create_ws_token")!
    .handler(stub, {})) as Record<string, unknown>;
  assert.equal(out.ws_endpoint, "wss://upstream.example/ws");
  assert.ok(!("ws_endpoint_note" in out), "no note contradicting the upstream");
});

test("each network's socket base resolves to the published URL", () => {
  // Per-network literals, so a change to any of them is a deliberate edit here.
  // Mainnet's host has no DNS yet (ENG-15183): the value is the shape it will
  // serve, not a URL that answers today.
  assert.equal(NETWORKS.testnet.durableWsUrl, "wss://api.testnet.nexus.xyz/v1");
  assert.equal(NETWORKS.mainnet.durableWsUrl, "wss://api.nexus.xyz/v1");
  assert.equal(NETWORKS.local.durableWsUrl, "ws://localhost:9090");

  // Mainnet with an explicit host is the sanctioned way to reach it today; the
  // URL redirected the host, so the socket derives from THAT host rather than
  // from the published one — a token must be spent where it was minted.
  const mainnet = loadConfig(
    env({
      NEXUS_EXCHANGE_NETWORK: "mainnet",
      NEXUS_EXCHANGE_API_URL: "https://mainnet.example.invalid",
    }),
  );
  assert.equal(mainnet.wsUrl, "wss://mainnet.example.invalid/api/exchange");

  // The same holds for testnet with an override: overrides still win.
  const redirected = loadConfig(
    env({
      NEXUS_EXCHANGE_NETWORK: "testnet",
      NEXUS_EXCHANGE_API_URL: "https://testnet.example.invalid/indexer",
    }),
  );
  assert.equal(redirected.wsUrl, "wss://testnet.example.invalid/indexer");
  assert.equal(
    redirected.wsAuthenticatedUrl,
    "wss://testnet.example.invalid/indexer/ws",
  );
});

test("the socket base is the REST base with the scheme swapped", () => {
  // `POST /ws/token` binds a token to the host that minted it, so the socket
  // URL has to be the REST base with `http` -> `ws` and nothing else changed.
  const swap = (rest: string) => rest.replace(/^http/, "ws");
  const specRestBase: Record<string, string> = {
    // The spec's `x-nexus-networks` `rest_base` values (nexus#12253).
    testnet: "https://api.testnet.nexus.xyz/v1",
    mainnet: "https://api.nexus.xyz/v1",
    local: "http://localhost:9090",
  };
  for (const id of NETWORK_IDS) {
    assert.equal(
      NETWORKS[id].durableWsUrl,
      swap(specRestBase[id]),
      `${id}: durableWsUrl is not the spec REST base with the scheme swapped`,
    );
  }
  // Against THIS file's REST base it holds exactly for mainnet and local.
  assert.equal(
    NETWORKS.mainnet.durableWsUrl,
    swap(NETWORKS.mainnet.durableRestBase),
  );
  assert.equal(
    NETWORKS.local.durableWsUrl,
    swap(NETWORKS.local.durableRestBase),
  );

  // Testnet is the recorded exception: its REST base is still `/indexer`
  // (moving REST to `/v1` is a separate change). Both prefixes are stripped to
  // `/` at the edge on the same host, so the token binding still holds — the
  // origin must match exactly. When REST moves, the first assertion flips and
  // this block should collapse into the exact equality above.
  assert.equal(
    NETWORKS.testnet.durableRestBase,
    "https://api.testnet.nexus.xyz/indexer",
  );
  const origin = (u: string) => new URL(u).host;
  assert.equal(
    origin(NETWORKS.testnet.durableWsUrl),
    origin(NETWORKS.testnet.durableRestBase),
  );
  assert.equal(
    origin(loadConfig(env()).wsUrl!),
    origin(loadConfig(env()).gatewayBaseUrl),
  );
});
