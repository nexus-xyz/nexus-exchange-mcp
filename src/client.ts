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
import {
  API_SPEC_VERSION,
  DEFAULT_USER_AGENT,
  hasAdminSecret,
  hasCredentials,
  hasSessionToken,
  type ExchangeConfig,
} from "./config.js";
import {
  CUSTOM_TARGET_ID,
  type DeclaredFunds,
  type ResolvedTarget,
} from "./networks.js";

/**
 * Header carrying the compiled-against Exchange API spec tag (see
 * {@link API_SPEC_VERSION}) on every upstream request — documented as a
 * contract convention in nexus-exchange-api (ENG-5953). Lower-cased to match
 * the other header keys; Node normalizes header names to lower case anyway.
 */
export const API_VERSION_HEADER = "x-nexus-api-version";

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

/**
 * A 2xx response whose body is neither empty nor JSON.
 *
 * Every one of the 92 documented 2xx responses in spec v0.7.3 is
 * `application/json` (the other 7 operations return no content at all), so a
 * non-JSON success body means the request did not reach the Exchange API —
 * `NEXUS_EXCHANGE_API_URL` points at a web front-end, a captive portal, or a
 * proxy answering with its own page. The client used to return that body as if
 * it were the endpoint's data, which handed an agent a web page typed as a
 * market list (ENG-8170). Failing is the only honest answer.
 */
export class NonJsonResponseError extends Error {
  constructor(
    public readonly status: number,
    public readonly contentType: string | null,
    public readonly body: string,
  ) {
    super(
      `Exchange API returned ${status} with a non-JSON body` +
        `${contentType ? ` (content-type: ${contentType})` : ""}. This is not ` +
        `the Exchange API — check that NEXUS_EXCHANGE_API_URL points at a host ` +
        `serving the API rather than a web front-end. Body: ${body}`,
    );
    this.name = "NonJsonResponseError";
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

export class MissingSessionTokenError extends Error {
  constructor(tool: string) {
    super(
      `Tool "${tool}" requires a session token. Sign in with the \`login\` tool ` +
        `(or POST /auth/login) and set NEXUS_EXCHANGE_SESSION_TOKEN in the ` +
        `environment. See the package README.`,
    );
    this.name = "MissingSessionTokenError";
  }
}

export class MissingAdminSecretError extends Error {
  constructor(tool: string) {
    super(
      `Tool "${tool}" requires the admin secret. Set NEXUS_EXCHANGE_ADMIN_SECRET ` +
        `in the environment. Admin tools are operator-only.`,
    );
    this.name = "MissingAdminSecretError";
  }
}

/**
 * Name the configured target in a guard message, without naming its host.
 *
 * The label is deliberately the only caller-supplied part: it is validated to
 * `[A-Za-z0-9._-]` (see `validateTargetLabel`), so no control character can
 * reach a log line through here, and the base URL of a private stage stays out
 * of an agent-visible error.
 */
function describeTarget(target: ResolvedTarget | undefined): string {
  if (!target) return "no target configured";
  return target.id === CUSTOM_TARGET_ID
    ? `custom target "${target.label}"`
    : `network ${target.id}`;
}

/**
 * What a tool needs to know about the target's funds before it will run. Declared
 * per tool as `ToolDef.fundsGuard`; enforced by
 * {@link ExchangeClient.assertFundsAllow}.
 *
 * - `"declared-funds"` — the target must say whether its money is real or play.
 *   For tools whose effect cannot be undone: an order that fills, collateral or
 *   margin that moves, an on-chain deposit address that funds get sent to.
 * - `"play-funds"` — the target must be play funds AND have a faucet. For the
 *   synthetic-funding tools, which exist only where the money is synthetic.
 */
export type FundsRequirement = "declared-funds" | "play-funds";

/**
 * A tool refused because of what the configured target says (or fails to say)
 * about its funds.
 *
 * Not an upstream error and not a missing credential: the request was never
 * made. The message names the environment variables that would make the call
 * possible, because "declare your funds" is only actionable if it says how.
 */
export class FundsGuardError extends Error {
  constructor(
    public readonly tool: string,
    message: string,
  ) {
    super(message);
    this.name = "FundsGuardError";
  }
}

/**
 * How a request authenticates:
 * - `"hmac"`   — per-account HMAC (x-api-key/x-timestamp/x-signature).
 * - `"bearer"` — session token from /auth/login (Authorization: Bearer …),
 *                used by the /keys management endpoints.
 * - `"admin"`  — operator admin secret (Authorization: Bearer …), used by the
 *                /admin endpoints.
 */
export type AuthMode = "hmac" | "bearer" | "admin";

interface RequestOptions {
  method?: "GET" | "POST" | "DELETE" | "PATCH" | "PUT";
  /**
   * Full path from the chosen base's origin, leading slash, no query.
   * For the direct v1 surface this INCLUDES the version prefix, e.g.
   * "/api/v1/orders"; for the legacy gateway it is the bare route, e.g.
   * "/orders". Whatever is passed here is exactly what gets HMAC-signed, so it
   * must match what the server verifies over (nexus-exchange-api#41: "the
   * caller signs the full request path, not the stripped path").
   */
  path: string;
  /** Query string without the leading "?". e.g. "limit=50" */
  query?: string;
  /** JSON-serializable body for writes. */
  body?: unknown;
  /** Whether this request must be authenticated with per-account HMAC. */
  signed?: boolean;
  /**
   * Non-HMAC authentication mode for endpoints that use a Bearer token instead
   * of HMAC (`/keys` → `"bearer"`, `/admin` → `"admin"`). Mutually exclusive
   * with `signed`. Omit for public requests.
   */
  auth?: AuthMode;
  /**
   * Which base URL to hit. "v1" (default) is the direct-service host root that
   * serves `/api/v1`; "gateway" is the legacy `/api/exchange` proxy, used by
   * the routes without a v1 equivalent. Defaulting to "v1" fails safe: a route
   * missing a v1 counterpart 404s loudly rather than silently resolving to the
   * wrong account through the public gateway proxy.
   */
  surface?: "v1" | "gateway";
}

/**
 * Response header carrying the cursor for the next page of a list endpoint
 * (spec v0.7.2). Present **only** when more results exist; its absence is the
 * documented signal that this was the last page, not an error.
 */
export const NEXT_CURSOR_HEADER = "x-next-cursor";

/**
 * One page of a cursor-paginated list endpoint: the decoded body plus the next
 * cursor, or `null` for that cursor on the last page.
 */
export interface Page<T> {
  items: T;
  nextCursor: string | null;
}

export class ExchangeClient {
  constructor(private readonly cfg: ExchangeConfig) {}

  /**
   * Whether the admin tier-management tools should be registered for this
   * client (mirrors `ExchangeConfig.enableAdminTools`). Off by default so a
   * general trading agent never sees the operator-only tools.
   */
  enableAdminTools(): boolean {
    return this.cfg.enableAdminTools;
  }

  hasCredentials(): boolean {
    return hasCredentials(this.cfg);
  }

  hasSessionToken(): boolean {
    return hasSessionToken(this.cfg);
  }

  hasAdminSecret(): boolean {
    return hasAdminSecret(this.cfg);
  }

  /**
   * Where an authenticated WebSocket token is meant to be used
   * (`${wsUrl}/ws`), or `undefined` on a config built without the network axis.
   * Minting a token without telling the caller where to connect is the gap the
   * network axis closes (ENG-6448), so the token tools return this alongside it.
   */
  wsAuthenticatedUrl(): string | undefined {
    return this.cfg.wsAuthenticatedUrl;
  }

  /** Where a legacy `/stream` token is meant to be used (`${wsUrl}/stream`). */
  wsMarketDataUrl(): string | undefined {
    return this.cfg.wsMarketDataUrl;
  }

  /**
   * The resolved target, or `undefined` on a config built without one (tests,
   * embedders). Callers that decide anything must go through
   * {@link assertFundsAllow} rather than reading `funds` themselves, so the
   * fail-closed reading of an absent target lives in exactly one place.
   */
  target(): ResolvedTarget | undefined {
    return this.cfg.target;
  }

  /**
   * Refuse a tool whose safety depends on whose money is behind the configured
   * target. Throws {@link FundsGuardError}; returns silently when allowed.
   *
   * The tri-state is matched **positively** — `=== "play"`, never `!== "real"`
   * (parent ENG-9823, resolved question 3). Negating `real` lets an undeclared
   * target fall through as though it were safe, which is the one direction that
   * costs money; matching `play` makes `unknown` fail closed for free. For the
   * same reason an absent target is read as undeclared rather than skipped.
   *
   * This is why `funds` stopped being a label. A custom stage that never said
   * whose money it holds is precisely where an irreversible action must not
   * proceed on an assumption — so it does not.
   */
  assertFundsAllow(need: FundsRequirement, tool: string): void {
    const target = this.cfg.target;
    const funds: DeclaredFunds = target?.funds ?? "unknown";

    if (need === "play-funds") {
      if (funds === "play" && target?.faucet === true) return;
      throw new FundsGuardError(
        tool,
        `Tool "${tool}" funds an account with synthetic money, which only exists ` +
          `on a play-funds target with a faucet. This target ` +
          `(${describeTarget(target)}) ${
            funds === "play"
              ? "is play funds but declares no faucet. On a custom stage, set " +
                "NEXUS_EXCHANGE_FAUCET=1 if it has one."
              : `reports funds "${funds}". Refusing rather than sending a funding ` +
                `request at a host that may hold real money.`
          }`,
      );
    }

    // "declared-funds": real or play both proceed — the point is that somebody
    // said which, so the caller knows what an irreversible action would move.
    if (funds !== "unknown") return;
    throw new FundsGuardError(
      tool,
      `Tool "${tool}" cannot be undone once it runs, and this target ` +
        `(${describeTarget(target)}) has not declared whose money is behind it. ` +
        `Refusing rather than assuming play funds. Either select a named network ` +
        `with NEXUS_EXCHANGE_NETWORK (testnet | mainnet | local), or describe the ` +
        `stage: NEXUS_EXCHANGE_NETWORK=custom with NEXUS_EXCHANGE_NETWORK_LABEL ` +
        `and NEXUS_EXCHANGE_FUNDS=real|play. Read-only tools are unaffected, and ` +
        `so is cancelling an order.`,
    );
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
    return (await this.send<T>(opts)).items;
  }

  /**
   * Issue a `GET` against a cursor-paginated list endpoint and return the
   * decoded body alongside its `X-Next-Cursor` header.
   *
   * A present-but-empty header is normalized to `null`: an empty cursor cannot
   * be sent back, and forwarding it would re-request the first page forever.
   */
  async requestPage<T = unknown>(opts: RequestOptions): Promise<Page<T>> {
    return this.send<T>(opts);
  }

  private async send<T>(opts: RequestOptions): Promise<Page<T>> {
    const method = opts.method ?? "GET";
    const query = opts.query ?? "";
    const bodyBytes =
      opts.body === undefined
        ? Buffer.alloc(0)
        : Buffer.from(JSON.stringify(opts.body), "utf8");

    const headers: Record<string, string> = {
      // Identifies the calling surface (stdio CLI vs. hosted MCP) so usage can
      // be attributed in the exchange dashboard.
      "user-agent": this.cfg.userAgent ?? DEFAULT_USER_AGENT,
      // The Exchange API spec tag this server is compiled against. Emitted on
      // EVERY upstream request — public reads and signed writes alike — so the
      // edge can attribute/segment by contract version (ENG-5957). It is a
      // fixed compiled-in constant (no caller/env input), so there is no
      // header-injection surface here.
      [API_VERSION_HEADER]: API_SPEC_VERSION,
    };
    if (opts.body !== undefined) headers["content-type"] = "application/json";

    // `signed: true` is shorthand for HMAC; `auth` selects a non-HMAC mode.
    const authMode: AuthMode | undefined = opts.signed ? "hmac" : opts.auth;
    const where = `${method} ${opts.path}`;

    if (authMode === "hmac") {
      if (!this.hasCredentials()) {
        throw new MissingCredentialsError(where);
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
    } else if (authMode === "bearer") {
      if (!this.hasSessionToken()) {
        throw new MissingSessionTokenError(where);
      }
      headers["authorization"] = `Bearer ${this.cfg.sessionToken}`;
    } else if (authMode === "admin") {
      if (!this.hasAdminSecret()) {
        throw new MissingAdminSecretError(where);
      }
      headers["authorization"] = `Bearer ${this.cfg.adminSecret}`;
    }

    const base =
      opts.surface === "gateway"
        ? this.cfg.gatewayBaseUrl
        : this.cfg.directBaseUrl;
    const url = `${base}${opts.path}${query ? `?${query}` : ""}`;
    const res = await fetch(url, {
      method,
      headers,
      body: opts.body === undefined ? undefined : bodyBytes,
    });

    const text = await res.text();
    if (!res.ok) {
      throw new ExchangeApiError(res.status, sanitizeErrorBody(text));
    }
    const nextCursor =
      (res.headers.get(NEXT_CURSOR_HEADER) ?? "").trim() || null;
    // An empty body is legitimate: 7 operations in the spec document a 2xx with
    // no content. `undefined` is the right value for those — distinct from a
    // body we received and could not read. The cursor still rides along, since
    // a paginated endpoint may legitimately return no items and a next cursor.
    if (!text) return { items: undefined as T, nextCursor };
    try {
      return { items: JSON.parse(text) as T, nextCursor };
    } catch {
      // This branch used to return the raw text as if it were the payload.
      // ENG-8170 replaced that with a throw, and the throw wins here: a 2xx
      // whose body we cannot parse is a broken response, and handing it back
      // wrapped in `{ items, nextCursor }` would launder it into something that
      // looks structured. Nothing to wrap — this path does not return.
      throw new NonJsonResponseError(
        res.status,
        res.headers.get("content-type"),
        sanitizeErrorBody(text),
      );
    }
  }
}
