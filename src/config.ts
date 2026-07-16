/**
 * Runtime configuration for the Nexus Exchange MCP server.
 *
 * Everything is read from environment variables so no secret is ever
 * hardcoded. Market-data tools work with zero config; account/trade tools
 * require an API key + secret.
 */

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
}

/**
 * Default to the public production host root. `/api/v1/*` resolves here
 * directly; legacy tools append `/api/exchange`. (README.md §"Base URLs".)
 */
const DEFAULT_BASE_URL = "https://exchange.nexus.xyz";

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
export const API_SPEC_VERSION = "v0.7.1";

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

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): ExchangeConfig {
  const raw = (env.NEXUS_EXCHANGE_API_URL || DEFAULT_BASE_URL).trim();
  const { directBaseUrl, gatewayBaseUrl } = deriveBases(raw);
  return {
    directBaseUrl,
    gatewayBaseUrl,
    apiKey: env.NEXUS_EXCHANGE_API_KEY || undefined,
    apiSecret: env.NEXUS_EXCHANGE_API_SECRET || undefined,
    sessionToken: env.NEXUS_EXCHANGE_SESSION_TOKEN || undefined,
    adminSecret: env.NEXUS_EXCHANGE_ADMIN_SECRET || undefined,
    enableAdminTools: isTruthy(env.NEXUS_EXCHANGE_ENABLE_ADMIN_TOOLS),
  };
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
