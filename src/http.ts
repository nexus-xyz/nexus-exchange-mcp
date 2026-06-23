/**
 * Hosted Streamable HTTP transport for the Nexus Exchange MCP server.
 *
 * The stdio entry (index.ts) is one process with one env key. This entry
 * serves many callers: each POST /mcp carries its own credentials in the
 * Authorization header, so the agent acts as itself rather than a shared key.
 *
 * Stateless: a fresh MCP server + transport per request, no session store
 * (MVP — sessionful SSE streaming is a follow-up). Auth is bearer passthrough:
 *
 *     Authorization: Bearer <api-key-id>:<secret-hex>
 *
 * Public market-data tools work with no header. The OAuth grant that mints a
 * scoped trade-not-withdraw key (so callers never paste a raw secret) is the
 * next PR; this is the transport it will ride on.
 */

import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ExchangeClient } from "./client.js";
import { DEFAULT_USER_AGENT, loadConfig, type ExchangeConfig } from "./config.js";
import { createServer } from "./server.js";

const MCP_PATH = "/mcp";

/**
 * Parse `Authorization: Bearer <keyId>:<secretHex>` into HMAC credentials.
 * Returns `{}` when the header is absent or malformed (→ public, unsigned
 * access — market-data tools still work).
 */
export function credentialsFromAuth(
  header: string | undefined,
): { apiKey?: string; apiSecret?: string } {
  if (!header) return {};
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!m) return {};
  const token = m[1];
  const sep = token.indexOf(":");
  // Need a non-empty id and secret on either side of the colon.
  if (sep <= 0 || sep === token.length - 1) return {};
  return { apiKey: token.slice(0, sep), apiSecret: token.slice(sep + 1) };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, obj: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

/**
 * Build the hosted HTTP server. The exchange gateway base URL is read from env
 * once; per-request credentials come from each caller's Authorization header.
 * Any env key is intentionally ignored here — hosted callers authenticate as
 * themselves, not as a shared identity.
 */
export function buildHttpServer(env: NodeJS.ProcessEnv = process.env): http.Server {
  const { baseUrl } = loadConfig(env);

  return http.createServer(async (req, res) => {
    const path = (req.url ?? "").split("?")[0];

    if (req.method === "GET" && path === "/healthz") {
      sendJson(res, 200, { status: "ok" });
      return;
    }

    if (path !== MCP_PATH) {
      sendJson(res, 404, { error: "not_found", message: `Unknown path: ${path}` });
      return;
    }

    if (req.method !== "POST") {
      // Stateless mode has no server-initiated SSE stream to attach to.
      res.writeHead(405, { "content-type": "application/json", allow: "POST" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Only POST is supported on this endpoint." },
          id: null,
        }),
      );
      return;
    }

    try {
      const authHeader = req.headers.authorization;
      const creds = credentialsFromAuth(
        Array.isArray(authHeader) ? authHeader[0] : authHeader,
      );
      const cfg: ExchangeConfig = {
        baseUrl,
        apiKey: creds.apiKey,
        apiSecret: creds.apiSecret,
        userAgent: `${DEFAULT_USER_AGENT} (hosted)`,
      };

      const server = createServer(new ExchangeClient(cfg));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);

      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : undefined;
      await transport.handleRequest(req, res, body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) {
        sendJson(res, 500, {
          jsonrpc: "2.0",
          error: { code: -32603, message: `Internal error: ${message}` },
          id: null,
        });
      }
    }
  });
}

export function startHttpServer(env: NodeJS.ProcessEnv = process.env): http.Server {
  const port = Number(env.PORT ?? 8080);
  const server = buildHttpServer(env);
  server.listen(port, () => {
    console.error(`nexus-exchange-mcp: hosted Streamable HTTP on :${port}${MCP_PATH}`);
  });
  return server;
}
