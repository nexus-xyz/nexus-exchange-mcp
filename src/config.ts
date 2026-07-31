/**
 * Runtime configuration for the Nexus Exchange MCP server.
 *
 * Everything is read from environment variables so no secret is ever
 * hardcoded. Market-data tools work with zero config; account/trade tools
 * require an API key + secret.
 *
 * The target is chosen on the **network axis** (`NEXUS_EXCHANGE_NETWORK` —
 * testnet / mainnet / local, see `networks.ts`), with `NEXUS_EXCHANGE_API_URL`
 * as an explicit override for anything off the map (a staging or beta
 * deployment, a private indexer). Nothing here is cached or shared: `loadConfig`
 * is a pure function of its `env` argument and returns a frozen object, so the
 * hosted server can build a fresh per-request config (see
 * `configForRequest` in http.ts) with no cross-session state to race over.
 */

import {
  DEFAULT_NETWORK,
  NETWORKS,
  resolveNetworkId,
  unreachableNetworkMessage,
  type Funds,
  type NetworkId,
} from "./networks.js";

export interface ExchangeConfig {
  /**
   * Direct-service origin that serves the `/api/v1` surface, no trailing slash
   * and NO path suffix (e.g. `https://exchange.nexus.xyz`).
   *
   * Per ENG-4740 the indexer now serves its REST API directly under an
   * `/api/v1` prefix at the host root (the OpenAPI `servers` override in
   * nexus-exchange-api pins these paths to the root, not the gateway base).
   * Tools that have a v1 route hit `${directBaseUrl}/api/v1/...`.
   */
  directBaseUrl: string;
  /**
   * Legacy gateway proxy base (`${origin}/api/exchange`), used only by the
   * tools that do NOT have an `/api/v1` route: demo reads, market specs,
   * get_order (GET by id), withdrawals, adl-history/events, ws-tokens, agents,
   * api-key management, admin tiers, deposit, funding-payments, health. The
   * gateway stays live dual-stack (ENG-4751) so these keep working.
   *
   * NOTE on authenticated legacy tools: the public `/api/exchange` entry is a
   * proxy that signs with the site's own frontend key, so per-caller HMAC
   * headers are not honored there — authenticated reads/trades resolve to the
   * site account, not yours. To act as a specific account against a legacy
   * route, point NEXUS_EXCHANGE_API_URL at a direct indexer gateway that
   * verifies client HMAC (auth.rs::verify_hmac), e.g. a local
   * `http://localhost:9090`. See the README "Authentication" section.
   */
  gatewayBaseUrl: string;
  /** HMAC API key id (header `x-api-key`). Optional — only needed for private tools. */
  apiKey?: string;
  /** HMAC secret (hex). Optional — only needed for private tools. */
  apiSecret?: string;
  /**
   * Session token (Bearer) from `POST /auth/login`. Optional — only needed for
   * the API-key-management tools (`/keys`), which authenticate with a session
   * token rather than HMAC. See README "Authentication".
   */
  sessionToken?: string;
  /**
   * Admin secret (the gateway's `ADMIN_SECRET`). Optional — only needed for the
   * admin tier-management tools, which are gated off by default (see
   * `enableAdminTools`). Carries operator-level authority; never set this on an
   * untrusted agent surface.
   */
  adminSecret?: string;
  /**
   * Whether to register the admin tier-management tools (`list_tiers`,
   * `set_tier`, `delete_tier`). Off by default: these use the operator-level
   * admin secret and mutate other accounts' fee tiers, so they must not be
   * exposed to a general trading agent. Set
   * `NEXUS_EXCHANGE_ENABLE_ADMIN_TOOLS=1` to opt in (and provide `adminSecret`).
   */
  enableAdminTools: boolean;
  /**
   * Client identifier sent as `User-Agent` on every gateway request so usage
   * can be attributed to a specific surface (stdio CLI vs. hosted MCP) in the
   * exchange dashboard. Optional; defaults to {@link DEFAULT_USER_AGENT}.
   */
  userAgent?: string;
  /**
   * Which network this config targets, or `"custom"` when
   * `NEXUS_EXCHANGE_API_URL` points somewhere off the map (a staging deployment,
   * a private indexer). Informational — it labels the target, it does not route.
   *
   * Optional so a partially-constructed config (tests, embedders) stays valid;
   * `loadConfig` always sets it.
   */
  network?: NetworkId | "custom";
  /**
   * Whether balances on the selected target are real money or synthetic play
   * money, or `"unknown"` for a custom URL that names no network.
   *
   * `"unknown"` is deliberately not the same as `"play"`: the spec's rule is
   * that anything unrecognized is treated as real funds, so this must never be
   * read as "safe to experiment on".
   */
  funds?: Funds | "unknown";
  /**
   * WebSocket origin for this target, scheme-swapped from
   * {@link ExchangeConfig.gatewayBaseUrl} — `/ws`, `/stream`, `/ws/token` and
   * `/ws-tokens` all resolve against the gateway base in the spec, not the
   * direct `/api/v1` host.
   *
   * Before this existed the server could mint a WebSocket token but never told
   * the caller where to connect, which is the gap the network axis closes
   * (ENG-6448).
   */
  wsUrl?: string;
  /** Authenticated per-account stream: `${wsUrl}/ws`. Connect with `?token=…`. */
  wsAuthenticatedUrl?: string;
  /** Legacy public market-data stream: `${wsUrl}/stream`. */
  wsMarketDataUrl?: string;
}

/**
 * The default target is no longer a constant here: it is
 * `NETWORKS[DEFAULT_NETWORK].baseUrl` (testnet — play funds), so the host lives
 * in exactly one place (`networks.ts`). The resolved value is unchanged from
 * when this was a local constant: `https://exchange.nexus.xyz`, the host root,
 * where `/api/v1/*` resolves directly and legacy tools append `/api/exchange`.
 * (README.md §"Base URLs".)
 */

/**
 * The package version, and the single source of truth for the version we
 * advertise on the wire (`User-Agent`) and in the MCP handshake
 * (`SERVER_VERSION`). release-please keeps this line in step with
 * package.json on every release via the `x-release-please-version` annotation
 * (wired through `extra-files` in release-please-config.json), so the metered
 * client version can never silently drift from the published package version.
 */
export const PACKAGE_VERSION = "0.1.0"; // x-release-please-version

/**
 * Exchange API spec tag this server is compiled against, sent as
 * `X-Nexus-Api-Version` on every upstream request so the edge can attribute and
 * segment usage by the contract version we target (ENG-5957, parent ENG-5350).
 *
 * This is the hosted MCP's OWN pin — it advances independently of the SDKs. It
 * MUST equal the `.api-version` file (the pin the drift check and the
 * api-version-sync bot own); a unit test enforces that, so a spec bump is
 * always a reviewed code change rather than a silently altered wire header. We
 * keep it as a compiled-in constant rather than reading `.api-version` at
 * runtime: the published npm package and container images ship only `dist/`
 * (see package.json `files`), so a runtime file read would break there — the
 * constant is baked into `dist/config.js` and always emits the right tag.
 */
export const API_SPEC_VERSION = "v0.7.2";

/**
 * Default `User-Agent` for upstream requests, normalized to the
 * `nexus-exchange-mcp/<version>` product token (ENG-5957). The hosted
 * Streamable HTTP server appends a ` (http)` comment (see src/http.ts) so the
 * dashboard can tell local stdio traffic apart from the hosted MCP front door
 * while both still segment under the same product name + version.
 */
export const DEFAULT_USER_AGENT = `nexus-exchange-mcp/${PACKAGE_VERSION}`;

/**
 * Split a configured base URL into the direct-service origin (serves
 * `/api/v1`) and the legacy gateway base (`origin/api/exchange`).
 *
 * We accept either form for `NEXUS_EXCHANGE_API_URL` so existing configs keep
 * working: a bare origin (`https://exchange.nexus.xyz`, the new default) OR a
 * value that still includes the old gateway suffix
 * (`https://exchange.nexus.xyz/api/exchange`). In the latter case we strip the
 * trailing `/api/exchange` before building v1 URLs — otherwise `/api/v1` would
 * wrongly resolve to `…/api/exchange/api/v1/…` (see nexus-exchange-api#41).
 */
export function deriveBases(raw: string): {
  directBaseUrl: string;
  gatewayBaseUrl: string;
} {
  const trimmed = raw.replace(/\/+$/, "");
  const directBaseUrl = trimmed.replace(/\/api\/exchange$/, "");
  return { directBaseUrl, gatewayBaseUrl: `${directBaseUrl}/api/exchange` };
}

/**
 * Validate and normalize a `NEXUS_EXCHANGE_API_URL` override.
 *
 * Base URLs are concatenated with a path and a query by the client
 * (`${base}${path}?${query}`), so a base carrying its own query or fragment
 * silently corrupts every request it builds: `https://h/?x=1` + `/api/v1/orders`
 * requests `/` with the path buried in a query value. That is a misdirected —
 * and, for signed calls, credential-bearing — request, so it is rejected here
 * rather than at the far end.
 *
 * Also rejected: any scheme that is not http(s) (a `file:`/`data:` base is never
 * a valid exchange, and `fetch` would do something surprising with it), and
 * embedded `user:password@` credentials (they would ride along on every request
 * and land in any log that records a URL).
 */
export function normalizeBaseUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      `NEXUS_EXCHANGE_API_URL is not a valid absolute URL: ${JSON.stringify(raw)}. ` +
        `Expected something like "https://exchange.nexus.xyz".`,
    );
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(
      `NEXUS_EXCHANGE_API_URL must use http or https, got "${parsed.protocol}".`,
    );
  }
  if (parsed.username || parsed.password) {
    throw new Error(
      "NEXUS_EXCHANGE_API_URL must not embed credentials (user:password@). " +
        "Set NEXUS_EXCHANGE_API_KEY / NEXUS_EXCHANGE_API_SECRET instead.",
    );
  }
  if (parsed.search || parsed.hash) {
    throw new Error(
      "NEXUS_EXCHANGE_API_URL must not carry a query string or fragment — it is " +
        "concatenated with a request path, so either one would corrupt every URL " +
        `this server builds. Got ${JSON.stringify(raw)}.`,
    );
  }
  // Re-serialize from the parsed URL so odd-but-legal input normalizes, then
  // drop trailing slashes the way deriveBases expects.
  return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "");
}

/** Loopback hosts, where plaintext http carries no real network exposure. */
function isLoopback(hostname: string): boolean {
  // `new URL("http://[::1]:1").hostname` keeps the brackets; strip them first.
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    /^127\./.test(host)
  );
}

/**
 * Warn when signed traffic would cross a real network in plaintext. Not fatal:
 * an internal deployment behind a private link is a legitimate setup, and
 * refusing outright would break it. But HMAC over http exposes the key id and
 * signature to anyone on the path, so it should never happen silently.
 *
 * stderr, not stdout — stdout is the MCP protocol channel on the stdio surface.
 */
function warnIfPlaintext(baseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return;
  }
  if (parsed.protocol !== "http:" || isLoopback(parsed.hostname)) return;
  console.error(
    `nexus-exchange-mcp: WARNING: API base ${parsed.origin} uses plaintext http. ` +
      "API key id and HMAC signature will cross the network unencrypted. Use " +
      "https unless this host is reachable only over a trusted private link.",
  );
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): ExchangeConfig {
  const override = (env.NEXUS_EXCHANGE_API_URL ?? "").trim();
  const rawNetwork = (env.NEXUS_EXCHANGE_NETWORK ?? "").trim();
  // Throws on anything unrecognized rather than defaulting — an unknown network
  // is treated as real funds, so guessing is the one thing we must not do.
  const selected = rawNetwork ? resolveNetworkId(rawNetwork) : undefined;

  let baseUrl: string;
  let network: NetworkId | "custom";
  let funds: Funds | "unknown";

  if (override) {
    // The explicit override wins for transport. This is where a staging/beta
    // deployment lives now that it is no longer a network value. If the caller
    // also named a network, keep that label — they are telling us whose money is
    // behind this URL, and "mainnet + custom URL" is the sanctioned way to reach
    // real funds before the durable host is live.
    baseUrl = normalizeBaseUrl(override);
    network = selected ?? "custom";
    funds = selected ? NETWORKS[selected].funds : "unknown";
  } else {
    const desc = NETWORKS[selected ?? DEFAULT_NETWORK];
    if (desc.baseUrl === null) {
      throw new Error(unreachableNetworkMessage(desc));
    }
    baseUrl = desc.baseUrl;
    network = desc.id;
    funds = desc.funds;
  }

  warnIfPlaintext(baseUrl);
  const { directBaseUrl, gatewayBaseUrl } = deriveBases(baseUrl);
  // `/ws`, `/stream`, `/ws/token` and `/ws-tokens` carry no per-path `servers`
  // override in the spec, so they resolve against the ROOT server — the gateway
  // base — not the direct `/api/v1` host.
  const wsUrl = gatewayBaseUrl.replace(/^http/, "ws");

  // Frozen: a tool handler receives this object, and a base URL that can be
  // rewritten at runtime is a redirect for every signed request that follows.
  return Object.freeze({
    directBaseUrl,
    gatewayBaseUrl,
    network,
    funds,
    wsUrl,
    wsAuthenticatedUrl: `${wsUrl}/ws`,
    wsMarketDataUrl: `${wsUrl}/stream`,
    apiKey: env.NEXUS_EXCHANGE_API_KEY || undefined,
    apiSecret: env.NEXUS_EXCHANGE_API_SECRET || undefined,
    sessionToken: env.NEXUS_EXCHANGE_SESSION_TOKEN || undefined,
    adminSecret: env.NEXUS_EXCHANGE_ADMIN_SECRET || undefined,
    enableAdminTools: isTruthy(env.NEXUS_EXCHANGE_ENABLE_ADMIN_TOOLS),
  });
}

/** Treat `1`/`true`/`yes`/`on` (any case) as enabled; everything else is off. */
function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function hasCredentials(cfg: ExchangeConfig): boolean {
  return Boolean(cfg.apiKey && cfg.apiSecret);
}

export function hasSessionToken(cfg: ExchangeConfig): boolean {
  return Boolean(cfg.sessionToken);
}

export function hasAdminSecret(cfg: ExchangeConfig): boolean {
  return Boolean(cfg.adminSecret);
}
