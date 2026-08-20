/**
 * Runtime configuration for the Nexus Exchange MCP server.
 *
 * Everything is read from environment variables so no secret is ever
 * hardcoded. Market-data tools work with zero config; account/trade tools
 * require an API key + secret.
 *
 * The target is chosen on the **network axis** (`NEXUS_EXCHANGE_NETWORK` —
 * testnet / mainnet / local, see `networks.ts`) or is the client-side `custom`
 * target, which carries a caller-supplied bundle describing a private stage
 * (ENG-9828). `NEXUS_EXCHANGE_API_URL` on its own is DEPRECATED sugar over
 * `custom` that supplies only the URL, leaving funds undeclared (ENG-10957): it
 * keeps working exactly as it always has and only gains a one-line stderr notice
 * naming the declared form. Either way the result is one frozen
 * {@link ResolvedTarget}, built once by `resolveTarget` and read by every guard,
 * so there is no configuration mechanism with its own semantics.
 *
 * Nothing here is cached or shared: `loadConfig` is a pure function of its `env`
 * argument and returns a frozen object, so the hosted server can build a fresh
 * per-request config (see `configForRequest` in http.ts) with no cross-session
 * state to race over.
 */

import {
  CUSTOM_TARGET_ID,
  DEFAULT_NETWORK,
  defineTarget,
  NETWORKS,
  resolveNetworkId,
  unreachableNetworkMessage,
  validateTargetLabel,
  type DeclaredFunds,
  type ResolvedTarget,
} from "./networks.js";

export interface ExchangeConfig {
  /**
   * Deployment base for the `/api/v1` surface, no trailing slash (e.g.
   * `https://exchange.nexus.xyz/api/exchange`, or `http://localhost:9090` for a
   * bare indexer). Tools with a v1 route hit `${directBaseUrl}/api/v1/...`.
   *
   * NOT the bare host root on a gatewayed deployment. ENG-4740 read the spec's
   * per-path `servers` override as pinning `/api/v1` to the root; measured, the
   * public root answers `/api/v1/*` with the marketing app's 404 HTML and only
   * `…/api/exchange/api/v1/*` reaches the API. See {@link deriveBases}.
   *
   * Equal to {@link ExchangeConfig.gatewayBaseUrl} by construction — one
   * deployment, two surfaces that differ by path. Kept distinct so a call site
   * still declares which surface it is addressing.
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
   * route, target a direct indexer gateway that verifies client HMAC
   * (auth.rs::verify_hmac): `NEXUS_EXCHANGE_NETWORK=local` for the
   * `http://localhost:9090` from the exchange `docker-compose`, or the `custom`
   * bundle with `NEXUS_EXCHANGE_GATEWAY_PATH=/`. Naming the network is what
   * carries the bare-origin shape — a bare `NEXUS_EXCHANGE_API_URL` assumes the
   * public-gateway path. See the README "Authentication" section.
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
   * The resolved target: which deployment this config points at, whose money is
   * behind it, and whether it has a faucet. Built once by `loadConfig` and
   * frozen — see {@link ResolvedTarget}.
   *
   * This replaces the separate `network` / `funds` fields, which were widened
   * union types assembled inline here (`NetworkId | "custom"`, `Funds |
   * "unknown"`). Read `target.id` and `target.funds` instead.
   *
   * Optional so a partially-constructed config (tests, embedders) stays valid,
   * and its ABSENCE fails closed: a config with no target has undeclared funds,
   * so the guarded tools refuse rather than assuming play money. `loadConfig`
   * always sets it.
   */
  target?: ResolvedTarget;
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
 * The package version, and the single source of truth for the version we
 * advertise on the wire (`User-Agent`) and in the MCP handshake
 * (`SERVER_VERSION`). release-please keeps this line in step with
 * package.json on every release via the `x-release-please-version` annotation
 * (wired through `extra-files` in release-please-config.json), so the metered
 * client version can never silently drift from the published package version.
 */
export const PACKAGE_VERSION = "0.2.0"; // x-release-please-version

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
export const API_SPEC_VERSION = "v0.8.1";

/**
 * Default `User-Agent` for upstream requests, normalized to the
 * `nexus-exchange-mcp/<version>` product token (ENG-5957). The hosted
 * Streamable HTTP server appends a ` (http)` comment (see src/http.ts) so the
 * dashboard can tell local stdio traffic apart from the hosted MCP front door
 * while both still segment under the same product name + version.
 */
export const DEFAULT_USER_AGENT = `nexus-exchange-mcp/${PACKAGE_VERSION}`;

/**
 * Resolve a configured base URL into the bases the two REST surfaces hang off.
 *
 * `gatewayPath` names the *deployment shape*, not just where the legacy routes
 * live: `/api/exchange` for a host behind the public gateway, `""` for a bare
 * indexer serving at its root. BOTH surfaces sit under it — the base names the
 * deployment, the path names the surface (`/api/v1/account` vs `/account`), and
 * the two are composed at request time.
 *
 * This previously stripped `/api/exchange` when building the v1 base, on the
 * premise (ENG-4740, nexus-exchange-api#41) that the indexer serves `/api/v1`
 * at the host root. That premise was read faithfully off the spec — the
 * per-path `servers` override on `/api/v1/*` really does list the bare
 * `https://exchange.nexus.xyz` — but the SPEC IS WRONG about the public host.
 * That is true of `local` and false of the public host, where the marketing app
 * owns the root. Measured against `exchange.nexus.xyz`:
 *
 *     /api/v1/account                 404, text/html   (Next.js frontend)
 *     /api/exchange/api/v1/account    401, application/json  (auth reached)
 *
 * `local` is unaffected because its `gatewayPath` is `""`, so the deployment
 * base IS the origin and `/api/v1/...` still resolves at the root — the shape
 * the old premise described, now expressed as data rather than assumed.
 *
 * The signed path is unchanged either way: HMAC covers the logical path
 * (`/api/v1/account`), never the deployment prefix, because the gateway strips
 * its own prefix before the indexer verifies.
 *
 * DELIBERATE DIVERGENCE FROM THE PINNED SPEC — do not "correct" this back when
 * syncing. `scripts/check_spec_drift.py` invariant 4/5 checks the GATEWAY base
 * against the spec's ROOT servers, which still agree, and nothing there checks
 * the v1 base against the per-path override — so a sync that restores the old
 * stripping passes `spec:drift` green. What catches it is `npm test`:
 * "deriveBases hangs both surfaces off one deployment base" pins the composed v1
 * base, so restoring the stripping fails a required check rather than only
 * contradicting a comment. The upstream fix belongs in nexus-exchange-api's
 * per-path `servers` list; until it lands, reality wins over the contract here.
 *
 * Either form of `NEXUS_EXCHANGE_API_URL` is still accepted so existing configs
 * keep working: a bare origin, or a value that still carries the `/api/exchange`
 * suffix — the suffix is normalized off the origin before `gatewayPath` is
 * applied, so passing it cannot double up.
 */
export function deriveBases(
  raw: string,
  gatewayPath: string = "/api/exchange",
): {
  directBaseUrl: string;
  gatewayBaseUrl: string;
} {
  const trimmed = raw.replace(/\/+$/, "");
  const origin = trimmed.replace(/\/api\/exchange$/, "");
  // One deployment base, two surfaces. These are equal by construction and the
  // distinction between them lives in the request path; they are kept as
  // separate fields so call sites still say which surface they mean.
  const deploymentBase = `${origin}${gatewayPath}`;
  return { directBaseUrl: deploymentBase, gatewayBaseUrl: deploymentBase };
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

/**
 * The one line printed when `NEXUS_EXCHANGE_API_URL` ALONE selected the target
 * (ENG-10957, parent ENG-10950). Nothing is removed and no behaviour changes —
 * this is the marker that says the declared form exists and why it is better.
 *
 * A fixed string, with no host or other environment value interpolated into it:
 * a private stage's hostname must not reach a log through this notice, and a
 * value nothing validated must not be able to forge a second record. It is one
 * line for the same reason — see `validateTargetLabel`.
 *
 * stderr only, and that is load-bearing rather than stylistic: the stdio surface
 * speaks JSON-RPC on stdout, so a stray line there corrupts the protocol for
 * every client that ever starts this server.
 */
const BARE_URL_DEPRECATION_NOTICE =
  "nexus-exchange-mcp: NOTICE: NEXUS_EXCHANGE_API_URL on its own is deprecated " +
  "and still works. On its own it also assumes the PUBLIC-GATEWAY shape, so " +
  "/api/v1 resolves under /api/exchange; for an indexer that serves at its " +
  "root, add NEXUS_EXCHANGE_NETWORK=local or the bundle's " +
  "NEXUS_EXCHANGE_GATEWAY_PATH=/. Prefer NEXUS_EXCHANGE_NETWORK=custom with " +
  "NEXUS_EXCHANGE_NETWORK_LABEL and NEXUS_EXCHANGE_FUNDS: the bundle declares " +
  "whose money is behind the URL, which a bare URL cannot — so the tools that " +
  'cannot be undone refuse on it. See the README "A custom stage".';

/**
 * Every environment variable that carries part of a custom bundle. Read ONLY
 * when `NEXUS_EXCHANGE_NETWORK=custom`; setting one otherwise is an error rather
 * than a silent no-op (see {@link resolveTarget}).
 */
const CUSTOM_BUNDLE_VARS = [
  "NEXUS_EXCHANGE_NETWORK_LABEL",
  "NEXUS_EXCHANGE_FUNDS",
  "NEXUS_EXCHANGE_FAUCET",
  "NEXUS_EXCHANGE_GATEWAY_PATH",
] as const;

/**
 * Accepted `NEXUS_EXCHANGE_FUNDS` values, as an array so the lookup is an
 * allowlist membership test rather than an object index — the same reason
 * {@link NETWORK_IDS} is an array, and the reason
 * `NEXUS_EXCHANGE_FUNDS=__proto__` cannot produce a truthy non-answer.
 */
const DECLARED_FUNDS_VALUES: readonly DeclaredFunds[] = [
  "real",
  "play",
  "unknown",
];

/** Read an env var, treating set-but-blank as unset (a shell exports `X=` as ""). */
function readVar(env: NodeJS.ProcessEnv, name: string): string {
  return (env[name] ?? "").trim();
}

/**
 * Parse `NEXUS_EXCHANGE_FUNDS`. Required for a custom bundle and has no default:
 * a staging deployment of mainnet is real-funds-shaped, so defaulting to `play`
 * would make every guard lie in exactly the direction that costs money, and
 * defaulting to `real` would make a dev stage unusable. `unknown` is accepted as
 * an explicit, honest answer — it just keeps the guards closed.
 */
function resolveDeclaredFunds(raw: string): DeclaredFunds {
  const value = raw.toLowerCase();
  if (!DECLARED_FUNDS_VALUES.includes(value as DeclaredFunds)) {
    throw new Error(
      `NEXUS_EXCHANGE_FUNDS must be one of ${DECLARED_FUNDS_VALUES.join(" | ")}, ` +
        `got ${JSON.stringify(raw)}. It says whose money is behind ` +
        `NEXUS_EXCHANGE_API_URL and has no default: a staging deployment of ` +
        `mainnet holds real funds, so this server will not assume either way.`,
    );
  }
  return value as DeclaredFunds;
}

/**
 * Parse `NEXUS_EXCHANGE_GATEWAY_PATH` — where the legacy gateway surface hangs
 * off the custom stage's host root. Blank (or unset) means the
 * `/api/exchange` default; see {@link resolveTarget}.
 *
 * A closed set of the only two real deployment shapes (mirroring
 * `NetworkDescriptor.gatewayPath`): `/api/exchange` for a host behind the public
 * gateway convention, and `/` for a bare indexer that serves the legacy routes
 * at its root — the `local` shape, and the one a private stage is most likely to
 * be. Getting it wrong 404s every legacy route and hands `get_ws_token` a
 * `ws_endpoint` nothing listens on, so it is a declared value, never a guess.
 *
 * The bare-origin shape is spelled `/` rather than the empty string on purpose:
 * everywhere else here a set-but-blank variable means "unset" (a shell exports
 * `X=` as `""`, and `.env.example` ships blank placeholders), so an empty value
 * cannot also carry a meaning. `/` is the same thing said in a way that survives
 * that convention.
 */
function resolveGatewayPath(raw: string): "" | "/api/exchange" {
  const value = raw.replace(/\/+$/, "");
  if (value === "" || value === "/api/exchange") return value;
  throw new Error(
    `NEXUS_EXCHANGE_GATEWAY_PATH must be "/api/exchange" (a host behind the ` +
      `public gateway) or "/" (a bare indexer serving the legacy routes at its ` +
      `root), got ${JSON.stringify(raw)}.`,
  );
}

/** What {@link resolveTarget} resolved, and by which mechanism. */
interface TargetSelection {
  target: ResolvedTarget;
  /**
   * True only when `NEXUS_EXCHANGE_API_URL` ALONE selected the target — the
   * deprecated form, and the one {@link BARE_URL_DEPRECATION_NOTICE} is about.
   *
   * False when a named network selected the target and the URL merely redirected
   * its host: that use declares funds through the network and is a modifier, not
   * a selector, so it is deliberately not deprecated (parent ENG-10950).
   *
   * Returned rather than re-derived from the environment by the caller so the
   * notice cannot drift out of step with the branch it describes.
   */
  viaBareUrl: boolean;
}

/**
 * Resolve the target this config points at, from the environment.
 *
 * Three mechanisms, in the order they are checked:
 *
 *  1. `NEXUS_EXCHANGE_NETWORK=custom` — the full custom bundle. The one
 *     documented way to describe a private stage: URL + label + funds, plus an
 *     optional faucet flag and gateway path.
 *  2. `NEXUS_EXCHANGE_API_URL` alone — DEPRECATED sugar over (1) that supplies
 *     only the URL, so funds are UNDECLARED (ENG-10957, parent ENG-10950).
 *     Nothing is removed and nothing behaves differently: still byte-identical
 *     for transport (`/api/exchange` appended, taken literally), still
 *     normalizing a legacy `/api/exchange` suffix, and still reporting the label
 *     `custom` with `funds: "unknown"`. It gains only the stderr notice, because
 *     a bare URL cannot say whose money is behind it — which is exactly why the
 *     tools that cannot be undone refuse on it.
 *  3. A named network, or the default. Unchanged.
 *
 * (2) with a network ALSO named keeps that network's metadata: the caller is
 * telling us whose money is behind the URL, and "mainnet + explicit URL" is the
 * sanctioned way to reach real funds before the durable host is live. That is a
 * modifier on a declared target, so it is not the deprecated form.
 */
function resolveTarget(env: NodeJS.ProcessEnv): TargetSelection {
  const override = readVar(env, "NEXUS_EXCHANGE_API_URL");
  const rawNetwork = readVar(env, "NEXUS_EXCHANGE_NETWORK");
  const isCustom = rawNetwork.toLowerCase() === CUSTOM_TARGET_ID;

  if (isCustom) {
    if (!override) {
      throw new Error(
        `NEXUS_EXCHANGE_NETWORK=${CUSTOM_TARGET_ID} needs a host: set ` +
          `NEXUS_EXCHANGE_API_URL to the stage's root URL. This package ships no ` +
          `hostname for any private stage — the caller supplies it.`,
      );
    }
    const rawLabel = readVar(env, "NEXUS_EXCHANGE_NETWORK_LABEL");
    const rawFunds = readVar(env, "NEXUS_EXCHANGE_FUNDS");
    if (!rawLabel || !rawFunds) {
      throw new Error(
        `NEXUS_EXCHANGE_NETWORK=${CUSTOM_TARGET_ID} requires ` +
          `NEXUS_EXCHANGE_NETWORK_LABEL (a name for this stage) and ` +
          `NEXUS_EXCHANGE_FUNDS (${DECLARED_FUNDS_VALUES.join(" | ")} — whose ` +
          `money is behind it). Both are required and neither has a default. To ` +
          `point at a host without describing it, leave NEXUS_EXCHANGE_NETWORK ` +
          `unset and set NEXUS_EXCHANGE_API_URL alone; the tools that move funds ` +
          `then refuse, because nothing declared what they would be moving.`,
      );
    }
    const target = defineTarget({
      id: CUSTOM_TARGET_ID,
      label: validateTargetLabel(rawLabel, "NEXUS_EXCHANGE_NETWORK_LABEL"),
      funds: resolveDeclaredFunds(rawFunds),
      // Assumed absent until declared: "not real money" does not imply "has a
      // faucet", and the funding tools must not route at one that is not there.
      faucet: isTruthy(env.NEXUS_EXCHANGE_FAUCET),
      restBase: normalizeBaseUrl(override),
      // Unset keeps the public-gateway convention, which is what every existing
      // config resolves to; `/` opts into the bare-indexer shape.
      gatewayPath: resolveGatewayPath(
        readVar(env, "NEXUS_EXCHANGE_GATEWAY_PATH") || "/api/exchange",
      ),
    });
    return { target, viaBareUrl: false };
  }

  // A bundle variable set without selecting the custom target is refused, not
  // ignored. Silently dropping `NEXUS_EXCHANGE_FUNDS=play` would leave the
  // operator believing they had configured a safety property that is not in
  // effect, and honoring it here would create a second, undocumented way to
  // describe a target. Blank values are already treated as unset above, so
  // `.env.example`'s empty placeholders do not trip this.
  const stray = CUSTOM_BUNDLE_VARS.filter((name) => readVar(env, name));
  if (stray.length > 0) {
    throw new Error(
      `${stray.join(", ")} ${stray.length === 1 ? "is" : "are"} only read when ` +
        `NEXUS_EXCHANGE_NETWORK=${CUSTOM_TARGET_ID}. Set that to describe a ` +
        `custom stage, or unset ${stray.length === 1 ? "it" : "them"} — this ` +
        `server will not apply half a bundle and leave you thinking the rest ` +
        `took effect.`,
    );
  }

  // Throws on anything unrecognized rather than defaulting — an unknown network
  // is treated as real funds, so guessing is the one thing we must not do.
  const selected = rawNetwork ? resolveNetworkId(rawNetwork) : undefined;

  if (override) {
    const desc = selected ? NETWORKS[selected] : undefined;
    const target = defineTarget({
      id: desc?.id ?? CUSTOM_TARGET_ID,
      label: desc?.label ?? CUSTOM_TARGET_ID,
      funds: desc?.funds ?? "unknown",
      faucet: desc?.faucet ?? false,
      restBase: normalizeBaseUrl(override),
      // A named network keeps its own deployment SHAPE; the URL only redirects
      // the HOST. `local` serves both surfaces at its origin (`gatewayPath:
      // ""`), so taking the URL and discarding the shape would send
      // `/api/v1/*` to `…/api/exchange/api/v1/*` on a bare indexer that serves
      // nothing under that prefix. This field used to move only the LEGACY
      // base, which is why hardcoding it here was invisible; now that both
      // surfaces hang off it (see {@link deriveBases}) it decides where v1
      // lands too, and a hardcode silently 404s every v1 tool.
      //
      // With no network named — the deprecated bare-URL form — there is no
      // descriptor to read a shape from, so the public-gateway convention
      // stands: that is what every existing config already resolves to. A bare
      // indexer declares itself with `NEXUS_EXCHANGE_NETWORK=local` (host
      // included) or the custom bundle's `NEXUS_EXCHANGE_GATEWAY_PATH=/`.
      gatewayPath: desc?.gatewayPath ?? "/api/exchange",
    });
    // The deprecated form is the URL SELECTING the target. With a network also
    // named, the network selected it and the URL only redirected the host —
    // funds are declared either way, so there is nothing to warn about.
    return { target, viaBareUrl: !selected };
  }

  const desc = NETWORKS[selected ?? DEFAULT_NETWORK];
  if (desc.baseUrl === null) {
    throw new Error(unreachableNetworkMessage(desc));
  }
  const target = defineTarget({
    id: desc.id,
    label: desc.label,
    funds: desc.funds,
    faucet: desc.faucet,
    restBase: desc.baseUrl,
    gatewayPath: desc.gatewayPath,
  });
  return { target, viaBareUrl: false };
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): ExchangeConfig {
  const { target, viaBareUrl } = resolveTarget(env);

  // Printed after resolution, so a config that fails validation throws instead
  // of first advertising a replacement for a target it never built. Once per
  // `loadConfig`, which both surfaces call once per process at startup (stdio:
  // `createServer`; hosted: `createHttpMcpServer` — `configForRequest` overlays
  // the per-session credential and does not re-read the environment).
  if (viaBareUrl) console.error(BARE_URL_DEPRECATION_NOTICE);

  // Applies to a custom stage exactly as it does to a named network: a private
  // deployment on plain http is precisely the case this warning exists for.
  warnIfPlaintext(target.restBase);
  const { directBaseUrl, gatewayBaseUrl } = deriveBases(
    target.restBase,
    target.gatewayPath,
  );
  // `/ws`, `/stream`, `/ws/token` and `/ws-tokens` carry no per-path `servers`
  // override in the spec, so they resolve against the ROOT server — the gateway
  // base — not the direct `/api/v1` host.
  const wsUrl = gatewayBaseUrl.replace(/^http/, "ws");

  // Frozen: a tool handler receives this object, and a base URL that can be
  // rewritten at runtime is a redirect for every signed request that follows.
  return Object.freeze({
    directBaseUrl,
    gatewayBaseUrl,
    // Already frozen by `defineTarget` — `Object.freeze` is shallow, so the
    // target has to carry its own immutability rather than inherit it here.
    target,
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
