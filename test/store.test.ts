/**
 * The credential store shared with the Nexus CLI (ENG-19784): the file's
 * location, its per-network sections, 0600, env-over-file, and what `login` and
 * `create_api_key` keep. Every test points at its own temp dir, never at a real
 * `~/.config`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, type ExchangeConfig } from "../src/config.js";
import { ExchangeClient } from "../src/client.js";
import { defineTarget } from "../src/networks.js";
import {
  readSection,
  storePath,
  withStoredCredentials,
  writeSection,
} from "../src/store.js";
import { findTool } from "../src/tools/index.js";

const env = (over: Record<string, string> = {}) =>
  over as unknown as NodeJS.ProcessEnv;

/** A fresh `XDG_CONFIG_HOME` and the config path inside it. */
function scratch(): { xdg: string; path: string } {
  const xdg = mkdtempSync(join(tmpdir(), "nexus-mcp-store-"));
  return { xdg, path: join(xdg, "nexus", "config.json") };
}

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

test("the path follows the CLI: non-empty XDG_CONFIG_HOME, else $HOME/.config", () => {
  assert.equal(
    storePath(env({ XDG_CONFIG_HOME: "/x", HOME: "/h" })),
    "/x/nexus/config.json",
  );
  assert.equal(
    storePath(env({ XDG_CONFIG_HOME: "", HOME: "/h" })),
    "/h/.config/nexus/config.json",
  );
  assert.equal(storePath(env()), undefined);
});

test("a missing file reads as an empty section", () => {
  assert.deepEqual(readSection(scratch().path, "testnet"), {});
});

test("write creates the file 0600 in a 0700 dir and reads back", () => {
  const { path } = scratch();
  writeSection(path, "testnet", { api_key: "nx_a", api_secret: "aa" });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(join(path, "..")).mode & 0o777, 0o700);
  assert.deepEqual(readSection(path, "testnet"), {
    api_key: "nx_a",
    api_secret: "aa",
  });
});

test("an existing file is tightened back to 0600 on write", () => {
  const { path } = scratch();
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "{}", { mode: 0o644 });
  writeSection(path, "testnet", { session_token: "t" });
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("a write touches one section and keeps everything else in the file", () => {
  const { path } = scratch();
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      network: "testnet",
      custom_networks: { dev: { base_url: "https://x.example.invalid" } },
      acknowledged_networks: ["mainnet"],
      networks: {
        testnet: { session_token: "keep-me" },
        mainnet: { api_key: "nx_main", api_secret: "mm" },
      },
    }),
  );
  writeSection(path, "testnet", { api_key: "nx_t", api_secret: "tt" });
  const file = readJson(path);
  assert.deepEqual(file.networks.testnet, {
    session_token: "keep-me",
    api_key: "nx_t",
    api_secret: "tt",
  });
  assert.deepEqual(file.networks.mainnet, {
    api_key: "nx_main",
    api_secret: "mm",
  });
  assert.equal(file.network, "testnet");
  assert.deepEqual(file.acknowledged_networks, ["mainnet"]);
  assert.ok(file.custom_networks.dev);
});

test("networks are isolated: a write to one never shows up in another", () => {
  const { path } = scratch();
  writeSection(path, "testnet", { api_key: "nx_t", api_secret: "tt" });
  writeSection(path, "dev", { session_token: "dev-token" });
  assert.deepEqual(readSection(path, "testnet"), {
    api_key: "nx_t",
    api_secret: "tt",
  });
  assert.deepEqual(readSection(path, "dev"), { session_token: "dev-token" });
  assert.deepEqual(readSection(path, "mainnet"), {});
  // A valid label that names an Object.prototype member is a section, not a
  // lookup into the prototype.
  assert.deepEqual(readSection(path, "__proto__"), {});
  writeSection(path, "__proto__", { session_token: "p" });
  assert.deepEqual(readSection(path, "__proto__"), { session_token: "p" });
  assert.equal(readSection(path, "testnet").api_key, "nx_t");
});

test("a malformed file is an error, and a write leaves it as it was", () => {
  const { path } = scratch();
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "{ not json");
  assert.throws(() => readSection(path, "testnet"), /not valid JSON/);
  assert.throws(
    () => writeSection(path, "testnet", { session_token: "t" }),
    /not valid JSON/,
  );
  assert.equal(readFileSync(path, "utf8"), "{ not json");
});

test("the section follows the target, and only a target that owns one gets one", () => {
  const ns = (over: Record<string, string>) =>
    loadConfig(env(over)).credentialNamespace;
  assert.equal(ns({}), "testnet");
  assert.equal(ns({ NEXUS_EXCHANGE_NETWORK: "local" }), "local");
  // A URL redirecting a named network keeps that network's section, as in the CLI.
  assert.equal(
    ns({
      NEXUS_EXCHANGE_NETWORK: "local",
      NEXUS_EXCHANGE_API_URL: "http://localhost:1",
    }),
    "local",
  );
  const bundle = {
    NEXUS_EXCHANGE_NETWORK: "custom",
    NEXUS_EXCHANGE_API_URL: "https://x.example.invalid",
    NEXUS_EXCHANGE_FUNDS: "play",
  };
  assert.equal(ns({ ...bundle, NEXUS_EXCHANGE_NETWORK_LABEL: "dev" }), "dev");
  // A custom stage calling itself `TestNet` would share testnet's section.
  assert.equal(
    ns({ ...bundle, NEXUS_EXCHANGE_NETWORK_LABEL: "TestNet" }),
    undefined,
  );
  // A bare URL declares nothing, so it owns no section.
  assert.equal(
    ns({ NEXUS_EXCHANGE_API_URL: "https://x.example.invalid" }),
    undefined,
  );
});

test("env wins over the file per field; the file fills what env left unset", () => {
  const { xdg, path } = scratch();
  writeSection(path, "testnet", {
    api_key: "nx_file",
    api_secret: "ff",
    session_token: "file-token",
  });
  const cfg = withStoredCredentials(
    loadConfig(
      env({
        NEXUS_EXCHANGE_API_KEY: "nx_env",
        NEXUS_EXCHANGE_API_SECRET: "ee",
      }),
    ),
    env({ XDG_CONFIG_HOME: xdg }),
  );
  assert.equal(cfg.apiKey, "nx_env");
  assert.equal(cfg.apiSecret, "ee");
  assert.equal(cfg.sessionToken, "file-token");
  assert.equal(cfg.credentialStorePath, path);

  const fromFile = withStoredCredentials(
    loadConfig(env()),
    env({ XDG_CONFIG_HOME: xdg }),
  );
  assert.equal(fromFile.apiKey, "nx_file");
  assert.equal(fromFile.apiSecret, "ff");

  // Another network's section is never read.
  const local = withStoredCredentials(
    loadConfig(env({ NEXUS_EXCHANGE_NETWORK: "local" })),
    env({ XDG_CONFIG_HOME: xdg }),
  );
  assert.equal(local.apiKey, undefined);
  assert.equal(local.sessionToken, undefined);
});

const BASE = "http://example.test";

/** A stdio-shaped client on play funds, storing to `path` when given. */
function client(path?: string, over: Partial<ExchangeConfig> = {}) {
  return new ExchangeClient({
    baseUrl: BASE,
    target: defineTarget({
      id: "local",
      label: "local",
      funds: "play",
      faucet: true,
      restBase: BASE,
      gatewayPath: "",
    }),
    enableAdminTools: false,
    credentialNamespace: "local",
    credentialStorePath: path,
    ...over,
  });
}

/** Answer every fetch with `body`, recording the request headers. */
async function withFetch<T>(
  body: unknown,
  run: (seen: Headers[]) => Promise<T>,
): Promise<T> {
  const seen: Headers[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    seen.push(new Headers(init.headers));
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  try {
    return await run(seen);
  } finally {
    globalThis.fetch = real;
  }
}

test("login keeps the token in the session and in the section", async () => {
  const { path } = scratch();
  const c = client(path);
  const result = await withFetch({ token: "tok", address: "0xA" }, () =>
    findTool("login")!.handler(c, { signature: "0x00" }),
  );
  assert.deepEqual(result, { token: "tok", address: "0xA", saved_to: path });
  assert.deepEqual(readSection(path, "local"), { session_token: "tok" });
  // The next bearer call presents it with no env and no restart.
  const seen = await withFetch({}, (s) =>
    findTool("fetch_api_keys")!
      .handler(c, {})
      .then(() => s),
  );
  assert.equal(seen[0].get("authorization"), "Bearer tok");
});

test("create_api_key after login redacts a saved secret, says where, and signs with the key", async () => {
  const { path } = scratch();
  const c = client(path);
  await withFetch({ token: "tok" }, () =>
    findTool("login")!.handler(c, { signature: "0x00" }),
  );
  const result = await withFetch({ key_id: "nx_new", secret: "ab" }, (s) =>
    findTool("create_api_key")!
      .handler(c, {})
      .then((r) => {
        assert.equal(s[0].get("authorization"), "Bearer tok");
        return r;
      }),
  );
  assert.deepEqual(result, {
    key_id: "nx_new",
    secret: "[REDACTED]",
    saved_to: path,
  });
  // The key joins the token from `login` rather than replacing it.
  assert.deepEqual(readSection(path, "local"), {
    session_token: "tok",
    api_key: "nx_new",
    api_secret: "ab",
  });
  const seen = await withFetch({}, (s) =>
    findTool("fetch_balance")!
      .handler(c, {})
      .then(() => s),
  );
  assert.equal(seen[0].get("x-api-key"), "nx_new");
});

test("create_api_key returns the secret in full when it was not saved", async () => {
  // No store (a bare URL, or no HOME): kept for the session only.
  const unsaved = await withFetch({ key_id: "nx_new", secret: "ab" }, () =>
    findTool("create_api_key")!.handler(
      client(undefined, { sessionToken: "t" }),
      {},
    ),
  );
  assert.deepEqual(unsaved, { key_id: "nx_new", secret: "ab" });

  // A save that fails says why and keeps the secret visible.
  const { path } = scratch();
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "{ not json");
  const failed = (await withFetch({ key_id: "nx_new", secret: "ab" }, () =>
    findTool("create_api_key")!.handler(
      client(path, { sessionToken: "t" }),
      {},
    ),
  )) as Record<string, string>;
  assert.equal(failed.secret, "ab");
  assert.match(failed.save_error, /not valid JSON/);
});

test("a hosted session neither keeps nor saves what a tool returns", async () => {
  const { path } = scratch();
  const c = client(path, { sessionToken: "t", credentialSource: "headers" });
  const result = await withFetch({ key_id: "nx_new", secret: "ab" }, () =>
    findTool("create_api_key")!.handler(c, {}),
  );
  assert.deepEqual(result, { key_id: "nx_new", secret: "ab" });
  assert.equal(c.hasCredentials(), false);
  assert.throws(() => readFileSync(path), /ENOENT/);
});
