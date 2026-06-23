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
   * User-Agent sent on every outbound request, for client-type attribution
   * (so MCP traffic is distinguishable from the SDK / CLI / web in usage
   * metrics). Defaults to {@link DEFAULT_USER_AGENT}; the hosted server
   * appends "(hosted)".
   */
  userAgent?: string;
}

/** Default to the public production gateway (README.md §"Base URLs"). */
const DEFAULT_BASE_URL = "https://exchange.nexus.xyz/api/exchange";

/** Identifies MCP-originated traffic in the exchange's per-client metrics. */
export const DEFAULT_USER_AGENT = "nexus-exchange-mcp/0.1.0";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ExchangeConfig {
  const baseUrl = (env.NEXUS_EXCHANGE_API_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  return {
    baseUrl,
    apiKey: env.NEXUS_EXCHANGE_API_KEY || undefined,
    apiSecret: env.NEXUS_EXCHANGE_API_SECRET || undefined,
  };
}

export function hasCredentials(cfg: ExchangeConfig): boolean {
  return Boolean(cfg.apiKey && cfg.apiSecret);
}
