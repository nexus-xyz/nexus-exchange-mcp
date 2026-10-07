/**
 * The wallet key the stdio server may hold on a play-funds target (ENG-19785),
 * and the signatures it makes with it: EIP-191 `personal_sign` for `login` and
 * the bridge-wallet challenge, and EIP-712 for `RegisterAgent`.
 *
 * Ported from the TypeScript SDK's `src/wallet.ts` (nexus-exchange-ts), which
 * this package does not depend on. `test/wallet.test.ts` pins the same
 * known-answer vectors the TypeScript, Rust and Python SDKs pin against the
 * server's own digest, so a drift from the wire contract fails there.
 *
 * No error raised here ever quotes the key.
 */

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  bytesToHex,
  concatBytes,
  hexToBytes,
  utf8ToBytes,
} from "@noble/hashes/utils.js";

/** The fixed message `POST /auth/login` verifies. */
export const LOGIN_MESSAGE = "Sign in to Nexus Exchange";

/**
 * The `RegisterAgent` domain `chainId`. The server verifies against the
 * request's `chain_id` and falls back to this one (`NEXUS_DEMO_CHAIN_ID`,
 * ENG-9412) when the request carries none. The pinned spec has no `chain_id`
 * request field and `/metadata` publishes no signing domain, so this is the one
 * value a registration sent from here verifies under.
 */
const REGISTER_AGENT_CHAIN_ID = 20056;

const INVALID_KEY =
  "The wallet key (NEXUS_EXCHANGE_PRIVATE_KEY, or `private_key` in the Nexus " +
  "CLI config) is not a valid secp256k1 private key: expected 32 bytes of hex.";

const INVALID_AGENT_KEY =
  "The agent key (NEXUS_EXCHANGE_AGENT_PRIVATE_KEY, or the " +
  "X-Nexus-Agent-Private-Key header) is not a valid secp256k1 private key: " +
  "expected 32 bytes of hex.";

/** A fresh random secp256k1 private key, `0x`-prefixed hex. */
export function newPrivateKey(): string {
  return `0x${bytesToHex(secp256k1.utils.randomSecretKey())}`;
}

function keyBytes(key: string, invalid = INVALID_KEY): Uint8Array {
  // Checked here before any library parses it, so no parse error quotes it.
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(key)) throw new Error(invalid);
  const bytes = hexToBytes(key.replace(/^0x/, ""));
  if (!secp256k1.utils.isValidSecretKey(bytes)) throw new Error(invalid);
  return bytes;
}

/** The key's Ethereum address, lowercase `0x`-prefixed hex. */
export function walletAddress(key: string): string {
  const pub = secp256k1.getPublicKey(keyBytes(key), false);
  return `0x${bytesToHex(keccak_256(pub.subarray(1)).subarray(12))}`;
}

/**
 * A 65-byte `r || s || v` signature over a 32-byte digest, `v` in {27, 28}.
 * Deterministic (RFC 6979) and low-S, as the SDKs sign.
 */
function signDigest(key: string, digest: Uint8Array): string {
  const sig = secp256k1.sign(digest, keyBytes(key), {
    prehash: false,
    lowS: true,
    format: "recovered",
  });
  // noble lays it out recovery id first; Ethereum puts `v` last.
  return `0x${bytesToHex(sig.subarray(1))}${(27 + sig[0]).toString(16)}`;
}

const keccakUtf8 = (s: string) => keccak_256(utf8ToBytes(s));
const word = (n: number | bigint) =>
  hexToBytes(BigInt(n).toString(16).padStart(64, "0"));

/** EIP-191 `personal_sign` over `message`'s UTF-8 bytes. */
export function personalSign(key: string, message: string): string {
  const bytes = utf8ToBytes(message);
  const prefix = utf8ToBytes(`\x19Ethereum Signed Message:\n${bytes.length}`);
  return signDigest(key, keccak_256(concatBytes(prefix, bytes)));
}

/**
 * EIP-712 signature over `RegisterAgent{agent, expiresAt, nonce}` under the
 * `Nexus Exchange` v1 domain, salted with `keccak256(network)` (ENG-15643): the
 * server binds a registration to its own network name, so one signed for
 * `testnet` does not verify anywhere else.
 */
export function signRegisterAgent(
  key: string,
  r: { agent: string; expiresAt: number; nonce: number; network: string },
): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(r.agent)) {
    throw new Error("`agent` must be a 0x-prefixed 20-byte hex address.");
  }
  const domain = keccak_256(
    concatBytes(
      keccakUtf8(
        "EIP712Domain(string name,string version,uint256 chainId,bytes32 salt)",
      ),
      keccakUtf8("Nexus Exchange"),
      keccakUtf8("1"),
      word(REGISTER_AGENT_CHAIN_ID),
      keccakUtf8(r.network),
    ),
  );
  const struct = keccak_256(
    concatBytes(
      keccakUtf8("RegisterAgent(address agent,uint64 expiresAt,uint64 nonce)"),
      word(BigInt(r.agent)),
      word(r.expiresAt),
      word(r.nonce),
    ),
  );
  return signDigest(
    key,
    keccak_256(concatBytes(new Uint8Array([0x19, 0x01]), domain, struct)),
  );
}

/**
 * The four `agentAuth` headers for one request, signed by a registered agent
 * key (ENG-20358). Ported from the TypeScript SDK's `src/agent.ts`, byte for
 * byte: the digest is `keccak256` of six LF-joined fields with no EIP-191
 * prefix,
 *
 *     {METHOD}\n{path}\n{query}\n{sha256hex(body)}\n{timestamp_ms}\n{nonce}
 *
 * and `path` is the same bare path the HMAC scheme signs. The server refuses a
 * nonce that is not above the highest it has accepted for the agent on a write,
 * so the caller issues it (see `ExchangeClient`).
 */
export function agentAuthHeaders(
  key: string,
  r: {
    method: string;
    path: string;
    query: string;
    body: Uint8Array;
    timestampMs: number;
    nonce: number;
  },
): Record<string, string> {
  keyBytes(key, INVALID_AGENT_KEY);
  const canonical = [
    r.method.toUpperCase(),
    r.path,
    r.query,
    bytesToHex(sha256(r.body)),
    String(r.timestampMs),
    String(r.nonce),
  ].join("\n");
  return {
    "x-agent": walletAddress(key),
    "x-timestamp": String(r.timestampMs),
    "x-nonce": String(r.nonce),
    "x-signature": signDigest(key, keccakUtf8(canonical)),
  };
}
