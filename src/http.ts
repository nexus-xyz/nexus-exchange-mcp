/**
 * Hosted Streamable HTTP front door for the Nexus Exchange MCP server.
 *
 * This is the "remote MCP server" that lets an external trader run
 * `claude mcp add --transport http nexus https://mcp.exchange.nexus.xyz/mcp`
 * WITHOUT running any key-holding software locally. It is a thin wrapper: MCP
 * tool calls resolve to the same `ToolDef[]` the stdio server exposes
 * (src/server.ts), which fan out to signed Exchange-gateway calls
 * (src/client.ts). No matching-engine / risk / backend changes.
 *
 * Transport: the SDK's `StreamableHTTPServerTransport` in stateful mode. It
 * speaks the MCP Streamable HTTP spec — POST /mcp for requests, and an
 * SSE-streamed response / standalone GET /mcp stream as the SSE fallback for
 * server→client messages. Each MCP session gets its own transport + `Server`
 * + `ExchangeClient`, keyed by the `mcp-session-id` header the SDK assigns at
 * initialize time.
 *
 * ── Credentials (MVP, no OAuth) ───────────────────────────────────────────
 * OAuth 2.1 is explicitly out of scope for this MVP (tracked separately —
 * see ENG-3598 hardening and ENG-3486 scoped key minting). Until then the
 * caller supplies their Exchange HMAC credential as request headers, captured
 * once at session initialize and reused for the life of the session:
 *
 *     X-Nexus-Api-Key:    <hmac key id>
 *     X-Nexus-Api-Secret: <hmac secret, hex>
 *
 * These are deliberately NOT named `x-api-key` / `x-signature` (the upstream
 * gateway's own header names) to avoid confusion with what we forward. If the
 * caller sends no credentials, the session still works for public market-data
 * tools, and every authenticated tool refuses. Server-env credentials (API
 * key/secret, session token, admin secret) are NEVER used in HTTP mode: a
 * header-less caller must not be able to trade as the server's account
 * (ENG-4359). See the README "Hosted HTTP server" section.
 *
 * ── Hardening (ENG-4359) ──────────────────────────────────────────────────
 * Idle sessions are evicted after `MCP_HTTP_SESSION_IDLE_TTL_MS`, and `/mcp`
 * is rate limited per client IP with a token bucket
 * (`MCP_HTTP_RATE_LIMIT_BURST` / `MCP_HTTP_RATE_LIMIT_PER_SEC`). The client
 * IP is the socket peer unless `MCP_HTTP_TRUSTED_PROXY_HOPS` says how many
 * proxies in front of us append to `X-Forwarded-For`.
 */

import { randomUUID } from "node:crypto";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { ExchangeClient } from "./client.js";
import { loadConfig, PACKAGE_VERSION, type ExchangeConfig } from "./config.js";
import { createServerForClient } from "./server.js";

/** Header names the caller uses to pass their Exchange HMAC credential. */
export const API_KEY_HEADER = "x-nexus-api-key";
export const API_SECRET_HEADER = "x-nexus-api-secret";

/**
 * `User-Agent` the hosted server sends upstream. Same normalized
 * `nexus-exchange-mcp/<version>` product token as the stdio CLI
 * (DEFAULT_USER_AGENT in config.ts), with a trailing ` (http)` comment so the
 * dashboard can tell hosted-MCP traffic apart from local stdio while both
 * still segment under one product name + version (ENG-5957).
 */
export const HTTP_USER_AGENT = `nexus-exchange-mcp/${PACKAGE_VERSION} (http)`;

/** Read a single request header as a string (Node lower-cases header keys). */
function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Build the per-session config: take the server's target (base URLs, network)
 * from the base config, but credentials ONLY from the caller's request
 * headers. Every server-env credential is dropped, so a session that sends no
 * headers can use public tools and nothing else (ENG-4359). Admin tools are
 * hidden too, since the admin secret they need is a server credential.
 */
export function configForRequest(
  base: ExchangeConfig,
  req: IncomingMessage,
): ExchangeConfig {
  return {
    ...base,
    userAgent: HTTP_USER_AGENT,
    apiKey: header(req, API_KEY_HEADER) || undefined,
    apiSecret: header(req, API_SECRET_HEADER) || undefined,
    sessionToken: undefined,
    adminSecret: undefined,
    enableAdminTools: false,
    credentialSource: "headers",
  };
}

/**
 * The client IP the rate limiter keys on. `X-Forwarded-For` is caller-supplied
 * and trivially spoofed, so it is ignored unless `trustedProxyHops` > 0. With N
 * trusted hops, each of which appends the peer it saw, the real client is the
 * Nth entry from the right; anything left of it is whatever the client sent.
 */
export function clientIp(
  req: IncomingMessage,
  trustedProxyHops: number,
): string {
  const peer = req.socket.remoteAddress ?? "unknown";
  if (trustedProxyHops <= 0) return peer;
  const xff = header(req, "x-forwarded-for");
  if (!xff) return peer;
  const hops = xff
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return hops[Math.max(0, hops.length - trustedProxyHops)] ?? peer;
}

/**
 * Error log line for a failed request. Never logs headers, and scrubs the
 * caller's secret from the error text in case anything upstream echoed it.
 */
export function formatRequestError(req: IncomingMessage, err: unknown): string {
  let detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  const secret = header(req, API_SECRET_HEADER);
  if (secret) detail = detail.split(secret).join("[redacted]");
  return `nexus-exchange-mcp-http: request failed ${detail}`;
}

/** Positive number from env, or the default. Throws on a bad value. */
function envNumber(name: string, fallback: number, min = 1): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) {
    throw new Error(`${name} must be a number >= ${min}, got "${raw}"`);
  }
  return n;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  lastSeen: number;
}

interface Bucket {
  tokens: number;
  updated: number;
}

export interface HttpServerOptions {
  /** Base config (base URL + network). Defaults to env. Its credentials are ignored. */
  config?: ExchangeConfig;
  /** Path the MCP endpoint is mounted at. Defaults to "/mcp". */
  path?: string;
  /** Idle session TTL. Default `MCP_HTTP_SESSION_IDLE_TTL_MS` or 30 min. */
  sessionIdleTtlMs?: number;
  /** Token bucket size per IP. Default `MCP_HTTP_RATE_LIMIT_BURST` or 60. */
  rateLimitBurst?: number;
  /** Token refill per second per IP. Default `MCP_HTTP_RATE_LIMIT_PER_SEC` or 2. */
  rateLimitPerSec?: number;
  /** Proxies trusted to append X-Forwarded-For. Default `MCP_HTTP_TRUSTED_PROXY_HOPS` or 0. */
  trustedProxyHops?: number;
  /** Clock in ms, injectable for tests. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Build (but do not yet listen on) the hosted MCP HTTP server. Returns the
 * Node `http.Server`; the caller calls `.listen(port)`. Exposed separately so
 * tests can drive it on an ephemeral port.
 */
export function createHttpMcpServer(opts: HttpServerOptions = {}): HttpServer {
  const baseConfig = opts.config ?? loadConfig();
  const mcpPath = opts.path ?? "/mcp";
  const idleTtlMs =
    opts.sessionIdleTtlMs ??
    envNumber("MCP_HTTP_SESSION_IDLE_TTL_MS", 30 * 60_000);
  const burst =
    opts.rateLimitBurst ?? envNumber("MCP_HTTP_RATE_LIMIT_BURST", 60);
  const perSec =
    opts.rateLimitPerSec ?? envNumber("MCP_HTTP_RATE_LIMIT_PER_SEC", 2);
  const trustedProxyHops =
    opts.trustedProxyHops ?? envNumber("MCP_HTTP_TRUSTED_PROXY_HOPS", 0, 0);
  const now = opts.now ?? Date.now;
  const sessions = new Map<string, Session>();
  // ponytail: in-memory, per-process limiter. The ceiling is per replica, not
  // global: N replicas allow N x the configured rate. Move to the ingress or a
  // shared store if that matters.
  const buckets = new Map<string, Bucket>();

  /** Take one token for `ip`; returns seconds to wait if none is left. */
  function takeToken(ip: string): number {
    const t = now();
    const b = buckets.get(ip) ?? { tokens: burst, updated: t };
    b.tokens = Math.min(burst, b.tokens + ((t - b.updated) / 1000) * perSec);
    b.updated = t;
    buckets.set(ip, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    return Math.ceil((1 - b.tokens) / perSec);
  }

  /** Close idle sessions (dropping their ExchangeClient) and full buckets. */
  function sweep(): void {
    const t = now();
    for (const [id, s] of sessions) {
      if (t - s.lastSeen >= idleTtlMs) {
        sessions.delete(id);
        void s.transport.close();
      }
    }
    const refillMs = (burst / perSec) * 1000;
    for (const [ip, b] of buckets) {
      if (t - b.updated >= refillMs) buckets.delete(ip);
    }
  }

  async function readBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    if (chunks.length === 0) return undefined;
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!raw) return undefined;
    return JSON.parse(raw);
  }

  function sendJson(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(text);
  }

  /** JSON-RPC framed error (no id — used before a session/request id exists). */
  function rpcError(res: ServerResponse, status: number, message: string) {
    sendJson(res, status, {
      jsonrpc: "2.0",
      error: { code: -32000, message },
      id: null,
    });
  }

  async function handleMcp(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const sessionId = header(req, "mcp-session-id");

    // Reuse the transport for an established session.
    const existing = sessionId ? sessions.get(sessionId) : undefined;
    if (existing) {
      existing.lastSeen = now();
      await existing.transport.handleRequest(req, res);
      return;
    }

    // A POST that initializes a new session: read the body to confirm it is an
    // `initialize` request, then stand up a fresh transport + server + client.
    if (req.method === "POST") {
      let body: unknown;
      try {
        body = await readBody(req);
      } catch {
        rpcError(res, 400, "Invalid JSON body");
        return;
      }

      if (!sessionId && isInitializeRequest(body)) {
        const sessionConfig = configForRequest(baseConfig, req);
        const client = new ExchangeClient(sessionConfig);
        const server = createServerForClient(client);

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, { transport, lastSeen: now() });
          },
          onsessionclosed: (id) => {
            sessions.delete(id);
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };

        await server.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }

      // Non-initialize POST without a valid session.
      rpcError(
        res,
        400,
        "Bad Request: no valid session id. Send an `initialize` request first.",
      );
      return;
    }

    // GET (SSE stream) / DELETE (session teardown) require an existing session.
    rpcError(res, 400, "Bad Request: missing or unknown mcp-session-id.");
  }

  const httpServer = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/healthz") {
      sendJson(res, 200, { status: "ok" });
      return;
    }

    if (url.pathname === mcpPath) {
      const retryAfter = takeToken(clientIp(req, trustedProxyHops));
      if (retryAfter > 0) {
        res.setHeader("retry-after", String(retryAfter));
        rpcError(res, 429, "Too Many Requests");
        return;
      }
      handleMcp(req, res).catch((err) => {
        if (!res.headersSent) {
          rpcError(res, 500, "Internal server error");
        }
        console.error(formatRequestError(req, err));
      });
      return;
    }

    rpcError(res, 404, "Not Found");
  });

  // unref: the sweep must never keep the process alive on its own.
  const timer = setInterval(sweep, Math.min(idleTtlMs, 60_000));
  timer.unref?.();
  httpServer.on("close", () => clearInterval(timer));
  return httpServer;
}
