/**
 * The local wallet signer (ENG-19785): signatures that verify, `create_wallet`
 * and its refusals, env over file for the key, the play-funds refusal before any
 * request, and the key never appearing in a tool result. Every test uses its own
 * temp dir, never a real `~/.config`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  bytesToHex,
  concatBytes,
  hexToBytes,
  utf8ToBytes,
} from "@noble/hashes/utils.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { loadConfig } from "../src/config.js";
import { ExchangeClient, FundsGuardError } from "../src/client.js";
import { createServerForClient } from "../src/server.js";
import {
  readSection,
  withStoredCredentials,
  writeSection,
} from "../src/store.js";
import { findTool } from "../src/tools/index.js";
import {
  LOGIN_MESSAGE,
  personalSign,
  signRegisterAgent,
  walletAddress,
} from "../src/wallet.js";

// Hardhat account #0 and the known-answer vectors the TypeScript, Rust and
// Python SDKs pin (nexus-exchange-ts test/wallet.test.ts); the RegisterAgent
// inputs are the server's own (`eip712_register_agent_digest_pinned`).
const TEST_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_ADDR = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const LOGIN_SIG =
  "0xff4ddf3b1af438fe00d02368ad8fa5fc5e57667e6826dbda3ddddc395a5287bb6eab0bc97652f6e7e1f08f665b868ca143da79e18dae8021799cdafc4af670ea1b";
const REGISTER_DIGEST =
  "5a52159bdde9c9ba6c1880598078c3326e8e32ea39c93425baafc76590d2a902";
const REGISTER_SIG =
  "0x40cc533ba443982d33463c30426a3e81569d07d68be841daefb2bf6baf4c890403efb48f19c76ab06bceec7530b149a5c91d71688f6c7009de47a99d2e68af951c";
const AGENT = "0xaaaaaaaaaaaaaaaaaaaabbbbbbbbbbbbbbbbbbbb";

const env = (over: Record<string, string> = {}) =>
  over as unknown as NodeJS.ProcessEnv;

/** The address a 65-byte `r||s||v` signature over `digest` recovers to. */
function recover(signature: string, digest: Uint8Array): string {
  const raw = hexToBytes(signature.slice(2));
  const pub = secp256k1.Signature.fromBytes(raw.slice(0, 64), "compact")
    .addRecoveryBit(raw[64] - 27)
    .recoverPublicKey(digest)
    .toBytes(false);
  return `0x${bytesToHex(keccak_256(pub.slice(1)).slice(12))}`;
}

/** EIP-191 digest, computed here independently of src/wallet.ts. */
function eip191(message: string): Uint8Array {
  const m = utf8ToBytes(message);
  return keccak_256(
    concatBytes(utf8ToBytes(`\x19Ethereum Signed Message:\n${m.length}`), m),
  );
}

/** A stdio-shaped config for `over`, storing in a fresh scratch dir. */
function stdio(over: Record<string, string> = {}, fileEnv = {}) {
  const xdg = mkdtempSync(join(tmpdir(), "nexus-mcp-wallet-"));
  const path = join(xdg, "nexus", "config.json");
  return { cfg: stdioAt(path, over, fileEnv), path };
}

/** `withStoredCredentials` over an existing file. */
function stdioAt(path: string, over: Record<string, string>, fileEnv = {}) {
  return withStoredCredentials(
    loadConfig(env(over)),
    env({ XDG_CONFIG_HOME: join(path, "..", ".."), ...fileEnv }),
  );
}

/** Run `fn` with every fetch answered by `answer`, recording the requests. */
async function withFetch<T>(
  answer: (url: string, body: any) => unknown,
  fn: (calls: Array<{ url: string; body: any }>) => Promise<T>,
): Promise<T> {
  const calls: Array<{ url: string; body: any }> = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const body = init.body
      ? JSON.parse(Buffer.from(init.body as Uint8Array).toString("utf8"))
      : undefined;
    calls.push({ url, body });
    return new Response(JSON.stringify(answer(url, body) ?? {}), {
      status: 200,
    });
  }) as typeof fetch;
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = real;
  }
}

const LOCAL = { NEXUS_EXCHANGE_NETWORK: "local" };

test("signatures match the cross-SDK known answers and recover the wallet", () => {
  assert.equal(walletAddress(TEST_KEY), TEST_ADDR);
  assert.equal(walletAddress(TEST_KEY.slice(2)), TEST_ADDR);
  const login = personalSign(TEST_KEY, LOGIN_MESSAGE);
  assert.equal(login, LOGIN_SIG);
  assert.equal(recover(login, eip191(LOGIN_MESSAGE)), TEST_ADDR);

  const reg = signRegisterAgent(TEST_KEY, {
    agent: AGENT,
    expiresAt: 1_700_000_000,
    nonce: 1,
    network: "testnet",
  });
  assert.equal(reg, REGISTER_SIG);
  assert.equal(recover(reg, hexToBytes(REGISTER_DIGEST)), TEST_ADDR);
});

test("a malformed key is refused without being quoted", () => {
  for (const bad of ["zz", "0x1234", "0".repeat(64), `0x${"g".repeat(64)}`]) {
    assert.throws(
      () => walletAddress(bad),
      (err: Error) =>
        /not a valid secp256k1 private key/.test(err.message) &&
        !err.message.includes(bad),
    );
  }
});

test("create_wallet stores a key 0600 under the network and returns only the address", async () => {
  const { cfg, path } = stdio(LOCAL);
  const client = new ExchangeClient(cfg);
  const result = (await findTool("create_wallet")!.handler(client, {})) as {
    address: string;
    saved_to: string;
  };
  const key = readSection(path, "local").private_key!;
  assert.match(key, /^0x[0-9a-f]{64}$/);
  assert.deepEqual(result, { address: walletAddress(key), saved_to: path });
  assert.ok(!JSON.stringify(result).includes(key.slice(2)));
  assert.equal(statSync(path).mode & 0o777, 0o600);
  // Read back at the next start, with nothing in the environment.
  assert.equal(stdioAt(path, LOCAL).privateKey, key);
});

test("an existing wallet is replaced only with confirm, and never one from env", async () => {
  const { cfg, path } = stdio(LOCAL);
  const client = new ExchangeClient(cfg);
  const tool = findTool("create_wallet")!;
  const first = (await tool.handler(client, {})) as { address: string };
  await assert.rejects(
    async () => tool.handler(client, {}),
    new RegExp(`already exists.*${first.address}.*confirm: true`),
  );
  const second = (await tool.handler(client, { confirm: true })) as {
    address: string;
  };
  assert.notEqual(second.address, first.address);
  assert.equal(
    walletAddress(readSection(path, "local").private_key!),
    second.address,
  );

  // A key from NEXUS_EXCHANGE_PRIVATE_KEY would win over the file again at the
  // next start, so it is not replaced even with confirm.
  const fromEnv = new ExchangeClient(
    stdioAt(path, LOCAL, { NEXUS_EXCHANGE_PRIVATE_KEY: TEST_KEY }),
  );
  await assert.rejects(
    async () => tool.handler(fromEnv, { confirm: true }),
    /NEXUS_EXCHANGE_PRIVATE_KEY/,
  );
});

test("NEXUS_EXCHANGE_PRIVATE_KEY wins over the file, and neither loads off play funds", () => {
  const { path } = stdio(LOCAL);
  writeSection(path, "local", { private_key: "0xfile" });
  writeSection(path, "mainnet", { private_key: "0xfile" });
  assert.equal(stdioAt(path, LOCAL).privateKey, "0xfile");
  assert.equal(
    stdioAt(path, LOCAL, { NEXUS_EXCHANGE_PRIVATE_KEY: "0xenv" }).privateKey,
    "0xenv",
  );
  const mainnet = {
    NEXUS_EXCHANGE_NETWORK: "mainnet",
    NEXUS_EXCHANGE_API_URL: "http://127.0.0.1:9",
  };
  assert.equal(stdioAt(path, mainnet).privateKey, undefined);
  assert.equal(
    stdioAt(path, mainnet, { NEXUS_EXCHANGE_PRIVATE_KEY: "0xenv" }).privateKey,
    undefined,
  );
});

const REFUSED_TARGETS: Record<string, Record<string, string>> = {
  mainnet: {
    NEXUS_EXCHANGE_NETWORK: "mainnet",
    NEXUS_EXCHANGE_API_URL: "http://127.0.0.1:9",
  },
  "custom real": {
    NEXUS_EXCHANGE_NETWORK: "custom",
    NEXUS_EXCHANGE_API_URL: "https://x.example.invalid",
    NEXUS_EXCHANGE_NETWORK_LABEL: "dev",
    NEXUS_EXCHANGE_FUNDS: "real",
  },
  "custom unknown": {
    NEXUS_EXCHANGE_NETWORK: "custom",
    NEXUS_EXCHANGE_API_URL: "https://x.example.invalid",
    NEXUS_EXCHANGE_NETWORK_LABEL: "dev",
    NEXUS_EXCHANGE_FUNDS: "unknown",
  },
};

const SELF_SIGNED: Record<string, Record<string, unknown>> = {
  create_wallet: {},
  login: {},
  register_agent: { agent: AGENT, nonce: 1 },
  register_bridge_wallet: { address: TEST_ADDR, message: "m", confirm: true },
};

test("off play funds, create_wallet and self-signing refuse before any request", async () => {
  for (const [name, over] of Object.entries(REFUSED_TARGETS)) {
    // A key in the config, as if one had been loaded, changes nothing.
    const client = new ExchangeClient({
      ...stdio(over).cfg,
      privateKey: TEST_KEY,
      apiKey: "nx",
      apiSecret: "00",
    });
    for (const [tool, args] of Object.entries(SELF_SIGNED)) {
      await withFetch(
        () => ({}),
        async (calls) => {
          await assert.rejects(
            async () => findTool(tool)!.handler(client, args),
            (err: Error) =>
              err instanceof FundsGuardError && !err.message.includes(TEST_KEY),
            `${tool} on ${name}`,
          );
          assert.equal(calls.length, 0, `${tool} on ${name} sent nothing`);
        },
      );
    }
  }
});

test("an explicit signature is still accepted off play funds", async () => {
  const client = new ExchangeClient(stdio(REFUSED_TARGETS.mainnet).cfg);
  const calls = await withFetch(
    () => ({}),
    async (calls) => {
      await findTool("login")!.handler(client, { signature: "0xsig" });
      return calls;
    },
  );
  assert.deepEqual(calls[0].body, {
    message: LOGIN_MESSAGE,
    signature: "0xsig",
  });
});

test("login, register_agent and register_bridge_wallet sign with the held wallet", async () => {
  const client = new ExchangeClient({
    ...stdio(LOCAL).cfg,
    privateKey: TEST_KEY,
    apiKey: "nx",
    apiSecret: "00",
  });
  const calls = await withFetch(
    () => ({}),
    async (calls) => {
      await findTool("login")!.handler(client, {});
      await findTool("register_agent")!.handler(client, {
        agent: AGENT,
        nonce: 7,
      });
      await findTool("register_bridge_wallet")!.handler(client, {
        address: TEST_ADDR.toUpperCase().replace("0X", "0x"),
        message: "challenge\n  ",
        confirm: true,
      });
      return calls;
    },
  );
  assert.equal(
    recover(calls[0].body.signature, eip191(LOGIN_MESSAGE)),
    TEST_ADDR,
  );

  const reg = calls[1].body;
  assert.equal(reg.wallet, TEST_ADDR);
  const day = 24 * 60 * 60 * 1000;
  assert.ok(Math.abs(reg.expires_at - (Date.now() + 30 * day)) < 60_000);
  // Salted with the target's own network name.
  assert.equal(
    reg.signature,
    signRegisterAgent(TEST_KEY, {
      agent: AGENT,
      expiresAt: reg.expires_at,
      nonce: 7,
      network: "local",
    }),
  );

  assert.equal(
    recover(calls[2].body.signature, eip191("challenge\n  ")),
    TEST_ADDR,
  );
});

test("self-signing refuses what the held wallet should not sign", async () => {
  const other = "0x1111111111111111111111111111111111111111";
  const held = new ExchangeClient({
    ...stdio(LOCAL).cfg,
    privateKey: TEST_KEY,
    apiKey: "nx",
    apiSecret: "00",
  });
  const devPlay = new ExchangeClient({
    ...stdio({
      ...REFUSED_TARGETS["custom real"],
      NEXUS_EXCHANGE_FUNDS: "play",
    }).cfg,
    privateKey: TEST_KEY,
  });
  const cases: Array<[ExchangeClient, string, object, RegExp]> = [
    [held, "login", { message: "anything else" }, /signs only/],
    [
      held,
      "register_agent",
      { agent: AGENT, nonce: 1, wallet: other },
      /not this server's wallet/,
    ],
    [
      held,
      "register_bridge_wallet",
      { address: other, message: "m", confirm: true },
      /not this server's wallet/,
    ],
    [devPlay, "register_agent", { agent: AGENT, nonce: 1 }, /custom target/],
    [new ExchangeClient(stdio(LOCAL).cfg), "login", {}, /holds no wallet/],
  ];
  for (const [client, tool, args, why] of cases) {
    await withFetch(
      () => ({}),
      async (calls) => {
        await assert.rejects(
          async () => findTool(tool)!.handler(client, args),
          why,
        );
        assert.equal(calls.length, 0, tool);
      },
    );
  }
});

test("create_wallet, login, create_api_key, fetch_balance: the key never reaches a tool result", async () => {
  const { cfg, path } = stdio(LOCAL);
  const server = createServerForClient(new ExchangeClient(cfg));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const mcp = new Client({ name: "test", version: "0" }, { capabilities: {} });
  await mcp.connect(a);

  const texts: string[] = [];
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await mcp.callTool({ name, arguments: args });
    const text = (res.content as Array<{ text: string }>)[0].text;
    texts.push(text);
    assert.ok(!res.isError, `${name}: ${text}`);
    return JSON.parse(text);
  };

  await withFetch(
    (url, body) => {
      if (url.endsWith("/auth/login")) {
        // The server's check: the signature recovers to some wallet.
        return {
          token: "tok",
          address: recover(body.signature, eip191(body.message)),
        };
      }
      if (url.endsWith("/keys")) return { key_id: "nx_new", secret: "ab" };
      return { balances: [] };
    },
    async () => {
      const wallet = await call("create_wallet");
      const login = await call("login");
      assert.equal(login.address, wallet.address);
      await call("create_api_key");
      await call("fetch_balance");
      // A refusal is a tool result too.
      const again = await mcp.callTool({
        name: "create_wallet",
        arguments: {},
      });
      assert.ok(again.isError);
      texts.push((again.content as Array<{ text: string }>)[0].text);
    },
  );
  await mcp.close();

  const key = readSection(path, "local").private_key!;
  for (const text of texts) {
    assert.ok(!text.toLowerCase().includes(key.slice(2)), text);
  }
});
