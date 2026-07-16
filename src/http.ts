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
 * tools and falls back to any server-env credentials. See the README "Hosted
 * HTTP server" section and the open question flagged on the PR.
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
 * Build the per-session config: start from the server's base config, then
 * overlay the caller's HMAC credential from request headers (if present) and
 * tag traffic with the hosted-MCP User-Agent. Header credentials win over any
 * server-env credentials so each session trades as its own account.
 */
export function configForRequest(
  base: ExchangeConfig,
  req: IncomingMessage,
): ExchangeConfig {
  const apiKey = header(req, API_KEY_HEADER);
  const apiSecret = header(req, API_SECRET_HEADER);
  return {
    ...base,
    userAgent: HTTP_USER_AGENT,
    apiKey: apiKey || base.apiKey,
    apiSecret: apiSecret || base.apiSecret,
  };
}

interface Session {
  transport: StreamableHTTPServerTransport;
}

export interface HttpServerOptions {
  /** Base config (base URL + optional fallback creds). Defaults to env. */
  config?: ExchangeConfig;
  /** Path the MCP endpoint is mounted at. Defaults to "/mcp". */
  path?: string;
}

/**
 * Build (but do not yet listen on) the hosted MCP HTTP server. Returns the
 * Node `http.Server`; the caller calls `.listen(port)`. Exposed separately so
 * tests can drive it on an ephemeral port.
 */
export function createHttpMcpServer(opts: HttpServerOptions = {}): HttpServer {
  const baseConfig = opts.config ?? loadConfig();
  const mcpPath = opts.path ?? "/mcp";
  const sessions = new Map<string, Session>();

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
    if (sessionId && sessions.has(sessionId)) {
      const { transport } = sessions.get(sessionId)!;
      await transport.handleRequest(req, res);
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
            sessions.set(id, { transport });
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

  return createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/healthz") {
      sendJson(res, 200, { status: "ok" });
      return;
    }

    if (url.pathname === mcpPath) {
      handleMcp(req, res).catch((err) => {
        if (!res.headersSent) {
          rpcError(res, 500, "Internal server error");
        }
        console.error("nexus-exchange-mcp-http: request failed", err);
      });
      return;
    }

    rpcError(res, 404, "Not Found");
  });
}
