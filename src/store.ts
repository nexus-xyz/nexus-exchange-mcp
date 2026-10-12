/**
 * Credentials kept on disk, in the file the Nexus CLI (`nexus`) already writes
 * (ENG-19784). A key `create_api_key` makes here then works in `nexus`, and one
 * `nexus auth login` saved works here.
 *
 * The file is the CLI's, so its format is the contract: `nexus-exchange-cli`
 * `src/credentials.rs` on main. It lives at `$XDG_CONFIG_HOME/nexus/config.json`,
 * falling back to `$HOME/.config/nexus/config.json` (macOS included), holds each
 * network's credentials under `networks.<label>` as `api_key`, `api_secret` and
 * `session_token` (plus `private_key`, the wallet `create_wallet` made on a
 * play-funds network, ENG-19785), and is written `0600` inside a `0700`
 * directory, through a temp file and a rename so a reader never sees half a
 * file. Every other key in it is the CLI's and is carried through a write
 * untouched.
 *
 * Only the stdio server uses it (see `index.ts`). The hosted server takes
 * credentials from request headers alone (ENG-4359), so it never reads or
 * writes this file.
 */

import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { ExchangeConfig } from "./config.js";

/** One network's section of the file, in the CLI's field names. */
export interface StoredCredentials {
  api_key?: string;
  api_secret?: string;
  session_token?: string;
  /** The wallet key `create_wallet` made. Only ever read on a play-funds target. */
  private_key?: string;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Where the CLI keeps its config, resolved exactly as `config_path()` does: a
 * non-empty `XDG_CONFIG_HOME`, else `$HOME/.config`. `undefined` when neither is
 * set, where the CLI errors; here that just means there is no file to use.
 */
export function storePath(env: NodeJS.ProcessEnv): string | undefined {
  const base = env.XDG_CONFIG_HOME || (env.HOME && join(env.HOME, ".config"));
  return base ? join(base, "nexus", "config.json") : undefined;
}

/**
 * The whole file, or `{}` when there is none. A file that is not a JSON object
 * throws rather than reading as empty, so a write cannot replace it.
 */
function readFile(path: string): Json {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${(err as Error).message}`, {
      cause: err,
    });
  }
  if (!isObject(parsed)) throw new Error(`${path} is not a JSON object.`);
  return parsed;
}

/**
 * `networks.<network>` of the file, or `{}`. Non-string and empty values read
 * as unset.
 */
export function readSection(path: string, network: string): StoredCredentials {
  const networks = readFile(path).networks;
  // `hasOwn`: a label is `[A-Za-z0-9._-]+`, so `__proto__` is a valid one, and a
  // plain index would hand back Object.prototype for it.
  const section =
    isObject(networks) && Object.hasOwn(networks, network)
      ? networks[network]
      : undefined;
  const out: StoredCredentials = {};
  if (!isObject(section)) return out;
  for (const field of [
    "api_key",
    "api_secret",
    "session_token",
    "private_key",
  ] as const) {
    const value = section[field];
    if (typeof value === "string" && value) out[field] = value;
  }
  return out;
}

let tmpSeq = 0;

/**
 * Merge `creds` into `networks.<network>` and write the file back, leaving every
 * other network and every other key as it was. Undefined fields are left alone.
 * Throws when the fields are not in the file after the write, so a caller never
 * reports as saved what another writer erased.
 *
 * Holds `.config.json.xlock` across the read, merge and rename, the lock the
 * CLI takes inside its `flock` (see {@link withXLock}). The re-read after the
 * rename stays as a check: CLIs from before the xlock take only the `flock`.
 */
export function writeSection(
  path: string,
  network: string,
  creds: StoredCredentials,
): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Tighten a directory that already existed too open. Best effort, as in the
  // CLI: one we do not own stays as it is.
  try {
    if (statSync(dir).mode & 0o077) chmodSync(dir, 0o700);
  } catch {
    // Not ours to tighten; the file itself is still 0600.
  }
  withXLock(dir, () => writeLocked(path, network, creds));
}

function writeLocked(
  path: string,
  network: string,
  creds: StoredCredentials,
): void {
  const file = readFile(path);
  const networks = isObject(file.networks) ? file.networks : {};
  const current = Object.hasOwn(networks, network)
    ? networks[network]
    : undefined;
  // An undefined field would otherwise spread over a stored one and erase it.
  const given = Object.entries(creds).filter(([, v]) => v !== undefined);
  // Computed keys and spread define own properties, so `__proto__` is stored as
  // a section rather than swapping the object's prototype.
  file.networks = {
    ...networks,
    [network]: {
      ...(isObject(current) ? current : {}),
      ...Object.fromEntries(given),
    },
  };

  const dir = dirname(path);
  // Same shape as the CLI's write: a fresh 0600 sibling, flushed, then renamed
  // over the file. Two-space JSON, no trailing newline, as serde writes it.
  const tmp = join(dir, `.config.json.tmp.${process.pid}.${tmpSeq++}`);
  try {
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeSync(fd, JSON.stringify(file, null, 2));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }

  const saved: Json = { ...readSection(path, network) };
  const lost = given.filter(([k, v]) => saved[k] !== v).map(([k]) => k);
  if (lost.length) {
    throw new Error(
      `${path} was replaced by another writer (a \`nexus\` command older than ` +
        `the shared lock) as this save landed, so it does not hold ${lost.join(", ")}.`,
    );
  }
}

/**
 * ponytail: a lock older than 10 s is taken as left by a crashed writer and
 * broken. A real write takes milliseconds, so the only cost is a write stalled
 * past 10 s losing its lock. Two waiters breaking the same stale lock at once
 * can both win; that needs a crash first, and a lock with an owner token to fix.
 */
export const XLOCK_STALE_MS = 10_000;
/** Longer than {@link XLOCK_STALE_MS}, so a waiter always outlasts a dead lock. */
const XLOCK_WAIT_MS = 15_000;
const sleeper = new Int32Array(new SharedArrayBuffer(4));

/**
 * Run `body` holding `<dir>/.config.json.xlock`, the lock shared with the CLI
 * (`nexus-exchange-cli` `src/credentials.rs`, `XLock`; ENG-20052). Same
 * protocol on both sides: create it exclusively (`O_CREAT|O_EXCL`), write
 * `pid=<pid> created_ms=<unix ms>` into it, delete it when done. A writer that
 * finds it retries with backoff, and deletes it once its mtime is
 * {@link XLOCK_STALE_MS} old. The wait blocks the event loop, which a write
 * that is synchronous already does.
 */
function withXLock<T>(dir: string, body: () => T): T {
  const lock = join(dir, ".config.json.xlock");
  const deadline = Date.now() + XLOCK_WAIT_MS;
  let backoff = 5;
  for (;;) {
    let fd: number;
    try {
      fd = openSync(lock, "wx", 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let age: number;
      try {
        age = Date.now() - statSync(lock).mtimeMs;
      } catch {
        continue; // Released between the open and the stat.
      }
      if (age > XLOCK_STALE_MS) {
        rmSync(lock, { force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        let holder = "";
        try {
          holder = readFileSync(lock, "utf8");
        } catch {
          // Gone already; the message still names the file.
        }
        throw new Error(
          `${lock} is held (${holder}) by another nexus or MCP process; ` +
            "delete it if neither is running.",
          { cause: err },
        );
      }
      Atomics.wait(sleeper, 0, 0, backoff);
      backoff = Math.min(backoff * 2, 100);
      continue;
    }
    try {
      // Informational only: staleness is judged by mtime, so a crash before
      // this write still leaves a breakable lock.
      writeSync(fd, `pid=${process.pid} created_ms=${Date.now()}`);
    } finally {
      closeSync(fd);
    }
    try {
      return body();
    } finally {
      rmSync(lock, { force: true });
    }
  }
}

/**
 * Layer the file under the environment (stdio startup). Per field, as the CLI
 * resolves flags > env > file: an env value wins, and the file fills only what
 * the env left unset. Also records the file's path, which is what lets `login`
 * and `create_api_key` save to it.
 *
 * A target with no section of its own (`credentialNamespace` unset) gets
 * nothing from the file and writes nothing to it.
 *
 * The wallet key (`NEXUS_EXCHANGE_PRIVATE_KEY`, else the section's
 * `private_key`) is read here rather than in `loadConfig`, so the hosted
 * server, which never calls this, can never hold one. It is read only on a
 * play-funds target: holding a key for real or undeclared funds is out of scope
 * (ENG-19785), so there it is not loaded at all.
 */
export function withStoredCredentials(
  cfg: ExchangeConfig,
  env: NodeJS.ProcessEnv = process.env,
): ExchangeConfig {
  const play = cfg.target?.funds === "play";
  const envKey = (play && env.NEXUS_EXCHANGE_PRIVATE_KEY) || undefined;
  const path = storePath(env);
  const network = cfg.credentialNamespace;
  if (!path || !network) {
    return envKey ? Object.freeze({ ...cfg, privateKey: envKey }) : cfg;
  }
  const stored = readSection(path, network);
  return Object.freeze({
    ...cfg,
    apiKey: cfg.apiKey ?? stored.api_key,
    apiSecret: cfg.apiSecret ?? stored.api_secret,
    sessionToken: cfg.sessionToken ?? stored.session_token,
    privateKey: envKey ?? (play ? stored.private_key : undefined),
    credentialStorePath: path,
  });
}
