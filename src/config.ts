/**
 * Runtime configuration for the Nexus Exchange MCP server.
 *
 * Everything is read from environment variables so no secret is ever
 * hardcoded. Market-data tools work with zero config; account/trade tools
 * require an API key + secret.
 */

export interface ExchangeConfig {
  /**
   * Exchange API base URL, no trailing slash.
   *
   * Defaults to the public gateway `https://exchange.nexus.xyz/api/exchange`,
   * which serves all PUBLIC market-data + demo reads with no credentials and
   * works out of the box for the demo.
   *
   * NOTE on authenticated tools: the public `/api/exchange` entry is a proxy
   * that signs with the site's own frontend key, so per-caller HMAC headers
   * are not honored there — authenticated reads/trades resolve to the site
   * account, not yours. To trade as a specific account, point this at a direct
   * indexer gateway that verifies client HMAC (auth.rs::verify_hmac), e.g. a
   * local `http://localhost:9090`. See the README "Authentication" section.
   */
  baseUrl: string;
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
}

/** Default to the public production gateway (README.md §"Base URLs"). */
const DEFAULT_BASE_URL = "https://exchange.nexus.xyz/api/exchange";

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): ExchangeConfig {
  const baseUrl = (env.NEXUS_EXCHANGE_API_URL || DEFAULT_BASE_URL).replace(
    /\/+$/,
    "",
  );
  return {
    baseUrl,
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
