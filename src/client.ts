/**
 * Thin HTTP client for the Nexus Exchange indexer gateway.
 *
 * Public GETs go out unsigned. Private requests are signed with HMAC-SHA256
 * over the exact canonical string the indexer verifies (auth.rs::verify_hmac):
 *
 *     <timestamp>\n<METHOD>\n<path>\n<query>\n<sha256hex(body)>
 *
 * signed with the key secret (hex-decoded), hex-encoded, sent as `x-signature`
 * alongside `x-api-key` and `x-timestamp`. This is the 5-line "direct API
 * caller" format (no x-client-ip line) — identical to bots/src/client.rs.
 */

import { createHash, createHmac } from "node:crypto";
import { hasCredentials, type ExchangeConfig } from "./config.js";

/**
 * Max upstream-body length forwarded into an agent-visible error. Kept tight:
 * on a hosted / OAuth surface the agent credential is less trusted, so we bound
 * how much upstream context can reach it. Enough to convey a normal JSON error.
 */
const MAX_ERROR_BODY = 512;

/**
 * Patterns that scrub secret-looking tokens out of an upstream error body
 * before it reaches the agent. The gateway returns its own response body (not
 * our request headers), but on a hosted surface we can't assume it never echoes
 * sensitive context, so we redact common credential shapes defensively.
 */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // Bearer tokens anywhere in free text (run first so a following key/value
  // rule doesn't half-match and leave the token behind).
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]"],
  // JSON-ish "key": "value" pairs whose key names a credential. The value
  // match stops at the first quote/whitespace/delimiter, which is fine for the
  // single-token secrets these keys carry.
  [
    /("?(?:api[_-]?key|secret|signature|token|password|authorization|x-api-key|x-signature)"?\s*[:=]\s*"?)[^"\s,}]+/gi,
    "$1[REDACTED]",
  ],
];

/**
 * Bound and scrub an upstream error body for agent consumption: redact
 * credential-looking tokens, then truncate to MAX_ERROR_BODY chars.
 */
export function sanitizeErrorBody(raw: string): string {
  let out = raw;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  if (out.length > MAX_ERROR_BODY) {
    out = `${out.slice(0, MAX_ERROR_BODY)}… [truncated]`;
  }
  return out;
}

export class ExchangeApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`Exchange API ${status}: ${body}`);
    this.name = "ExchangeApiError";
  }
}

export class MissingCredentialsError extends Error {
  constructor(tool: string) {
    super(
      `Tool "${tool}" requires API credentials. Set NEXUS_EXCHANGE_API_KEY and ` +
        `NEXUS_EXCHANGE_API_SECRET in the environment. See the package README.`,
    );
    this.name = "MissingCredentialsError";
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "DELETE" | "PATCH";
  /** Path component only, leading slash, no query. e.g. "/orders" */
  path: string;
  /** Query string without the leading "?". e.g. "limit=50" */
  query?: string;
  /** JSON-serializable body for writes. */
  body?: unknown;
  /** Whether this request must be authenticated. */
  signed?: boolean;
}

export class ExchangeClient {
  constructor(private readonly cfg: ExchangeConfig) {}

  hasCredentials(): boolean {
    return hasCredentials(this.cfg);
  }

  private sign(
    method: string,
    path: string,
    query: string,
    bodyBytes: Buffer,
  ): { timestamp: string; signature: string; apiKey: string } {
    if (!this.cfg.apiKey || !this.cfg.apiSecret) {
      throw new Error("sign() called without credentials");
    }
    const timestamp = Date.now().toString();
    const bodyHash = createHash("sha256").update(bodyBytes).digest("hex");
    const canonical = [
      timestamp,
      method.toUpperCase(),
      path,
      query,
      bodyHash,
    ].join("\n");
    const secret = Buffer.from(this.cfg.apiSecret, "hex");
    const signature = createHmac("sha256", secret)
      .update(canonical)
      .digest("hex");
    return { timestamp, signature, apiKey: this.cfg.apiKey };
  }

  async request<T = unknown>(opts: RequestOptions): Promise<T> {
    const method = opts.method ?? "GET";
    const query = opts.query ?? "";
    const bodyBytes =
      opts.body === undefined
        ? Buffer.alloc(0)
        : Buffer.from(JSON.stringify(opts.body), "utf8");

    const headers: Record<string, string> = {};
    if (opts.body !== undefined) headers["content-type"] = "application/json";

    if (opts.signed) {
      if (!this.hasCredentials()) {
        throw new MissingCredentialsError(`${method} ${opts.path}`);
      }
      const { timestamp, signature, apiKey } = this.sign(
        method,
        opts.path,
        query,
        bodyBytes,
      );
      headers["x-api-key"] = apiKey;
      headers["x-timestamp"] = timestamp;
      headers["x-signature"] = signature;
    }

    const url = `${this.cfg.baseUrl}${opts.path}${query ? `?${query}` : ""}`;
    const res = await fetch(url, {
      method,
      headers,
      body: opts.body === undefined ? undefined : bodyBytes,
    });

    const text = await res.text();
    if (!res.ok) {
      throw new ExchangeApiError(res.status, sanitizeErrorBody(text));
    }
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }
}
