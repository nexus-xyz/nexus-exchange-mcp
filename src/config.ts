/**
 * Runtime configuration for the Nexus Exchange MCP server.
 *
 * Everything is read from environment variables so no secret is ever
 * hardcoded. Market-data tools work with zero config; account/trade tools
 * require an API key + secret.
 */

export interface ExchangeConfig {
  /**
   * Direct-service origin that serves the `/api/v1` surface, no trailing
   * slash and NO path suffix (e.g. `https://exchange.nexus.xyz`).
   *
   * Per ENG-4740 the indexer now serves its REST API directly under an
   * `/api/v1` prefix at the host root (the OpenAPI `servers` override in
   * nexus-exchange-api pins these paths to the root, not the gateway base).
   * Tools that have a v1 route hit `${directBaseUrl}/api/v1/...`.
   */
  directBaseUrl: string;
  /**
   * Legacy gateway proxy base (`${origin}/api/exchange`), used only by the
   * handful of tools that do NOT have an `/api/v1` route yet (demo reads,
   * market specs, get_order by id, withdrawals, adl-history, ws-tokens).
   * The gateway stays live dual-stack (ENG-4751) so these keep working.
   *
   * NOTE on authenticated legacy tools: the public `/api/exchange` entry is a
   * proxy that signs with the site's own frontend key, so per-caller HMAC
   * headers are not honored there — authenticated reads resolve to the site
   * account, not yours. To act as a specific account against a legacy route,
   * point NEXUS_EXCHANGE_API_URL at a direct gateway that verifies client
   * HMAC (auth.rs::verify_hmac). See the README "Authentication" section.
   */
  gatewayBaseUrl: string;
  /** HMAC API key id (header `x-api-key`). Optional — only needed for private tools. */
  apiKey?: string;
  /** HMAC secret (hex). Optional — only needed for private tools. */
  apiSecret?: string;
}

/**
 * Default to the public production host root. `/api/v1/*` resolves here
 * directly; legacy tools append `/api/exchange`. (README.md §"Base URLs".)
 */
const DEFAULT_BASE_URL = "https://exchange.nexus.xyz";

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
function deriveBases(raw: string): {
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
  };
}

export function hasCredentials(cfg: ExchangeConfig): boolean {
  return Boolean(cfg.apiKey && cfg.apiSecret);
}
