/**
 * The Nexus Exchange network axis — `testnet`, `mainnet`, `local` (ENG-6456,
 * parent ENG-6448).
 *
 * This file is the SINGLE place the network → target map lives. It is copied
 * from the spec's `x-nexus-networks` extension (nexus-exchange-api#69 /
 * ENG-6442), which is the authoritative map; ENG-7809 may re-decide hostnames
 * wholesale, and when it does this is the only file that changes.
 *
 * A network is NOT a release channel. The old `Network{Stable, Beta, Local}`
 * enum conflated "which deployment" with "whose money", which is the confusion
 * this axis exists to remove: `testnet` is play funds, `mainnet` is real funds,
 * and a staging/beta deployment is just a URL you point at (see
 * {@link DEMOTED_RELEASE_CHANNELS}).
 *
 * Two rules from the spec extension govern everything here:
 *
 *  1. NEVER derive a host by interpolating the network name. Mainnet is
 *     deliberately off-pattern — `api.nexus.xyz`, not `api.mainnet.nexus.xyz` —
 *     so `api.{network}.nexus.xyz` resolves for every environment that CAN be
 *     rehearsed and fails only on real funds, the one that cannot. Every host
 *     below is therefore a named literal, never a template.
 *  2. An unrecognized network identifier is treated as REAL FUNDS. The fail-safe
 *     direction is to refuse and make the caller confirm, never to assume play
 *     money — so {@link resolveNetworkId} throws instead of falling back.
 *
 * Deliberately NOT carried here: the spec's per-network `signing_domain`. This
 * server never produces an EIP-712 signature (it authenticates with HMAC), and
 * the spec publishes `chain_id: null` with an instruction to read `/metadata`
 * rather than guess. Copying a domain we would never sign with would just be a
 * second place for it to go stale.
 */

/** The public network axis, plus `local` (a developer convenience, not a network). */
export type NetworkId = "testnet" | "mainnet" | "local";

/**
 * Every valid network id, as an array so a lookup is an allowlist membership
 * test rather than an object index. Indexing a plain object with unvalidated
 * input is how `NEXUS_EXCHANGE_NETWORK=__proto__` would hand back
 * `Object.prototype` and turn a typo into a truthy, attribute-less "network".
 */
export const NETWORK_IDS = ["testnet", "mainnet", "local"] as const;

/** Whether balances on a network are real money or synthetic play money. */
export type Funds = "real" | "play";

/**
 * Funds as a **resolved target** carries them: real, play, or undeclared.
 *
 * Tri-state rather than a boolean, per parent ENG-9823's resolved question 3. A
 * bool cannot represent a custom stage whose operator has not said whose money
 * is behind it, and a bool plus a second "declared" flag makes the invalid
 * combination representable. `"unknown"` is a first-class answer here, and the
 * one every guard must fail closed on — see
 * {@link ExchangeClient.assertFundsAllow}.
 */
export type DeclaredFunds = Funds | "unknown";

export interface NetworkDescriptor {
  readonly id: NetworkId;
  /** Human-facing name, as the spec spells it. */
  readonly label: string;
  /**
   * `real` means an order here moves actual money (USDX bridged from Ethereum
   * Mainnet). `play` means synthetic USDX with no real-world value.
   */
  readonly funds: Funds;
  /** Whether the synthetic-funding operations (faucet / credit) exist here. */
  readonly faucet: boolean;
  /**
   * The base this server actually talks to TODAY, or `null` when the network
   * has no host it can reach yet.
   *
   * Usually carries a path: the public hosts serve the spec under `/v1`
   * (EDR-006), which the edge strips before the indexer sees the request, so
   * the prefix is part of "where this deployment answers" and is never signed
   * over. Requests append the spec's bare path (`/orders`) to it.
   *
   * Still separate from {@link durableRestBase}, even where the two now hold
   * the same string: one is what transport uses and the other is what the
   * contract publishes, and mainnet is exactly the case where they differ —
   * a base URL that merely looks right is worse than one that is absent.
   */
  readonly baseUrl: string | null;
  /**
   * Where this network's DEPLOYMENT hangs off {@link baseUrl}. The name is
   * historical: it came from the legacy gateway, but it places every request.
   *
   * Per-network because deployment shapes are NOT uniform. It was `/api/exchange`
   * for the public gateway and `""` for a bare indexer serving at its root
   * (`local`); appending `/api/exchange` to the latter would 404 every call and
   * hand `create_ws_token` a `ws_endpoint` nothing listens on, which is worse than
   * no endpoint at all.
   *
   * Since ENG-8869 the only non-empty value left is mainnet's, which is a
   * convention rather than a measurement (see that entry). Testnet folds its
   * `/v1` prefix into {@link baseUrl}, so it is `""` — a modelling choice about
   * WHERE the prefix is written, not a claim that testnet has no prefix. The
   * field stays because
   * the closed set is a public contract via `NEXUS_EXCHANGE_GATEWAY_PATH`, and
   * because a custom stage behind the old gateway convention still needs it.
   *
   * Load-bearing on a URL override too: `resolveTarget` reads it from the named
   * network rather than hardcoding the public convention, so a URL redirects the
   * HOST and the network keeps its SHAPE.
   */
  readonly gatewayPath: "" | "/api/exchange";
  /**
   * The durable per-network REST base, as the spec's `x-nexus-networks`
   * `rest_base` publishes it. Live for `testnet` and `local`, where it is the
   * same string as {@link baseUrl}; still informational for `mainnet`, whose
   * host has no DNS record at all — see that entry's comment.
   */
  readonly durableRestBase: string;
  /**
   * The per-network WebSocket base, as the spec's `x-nexus-networks` `ws_url`
   * publishes it: `<ws_url>/ws` is the authenticated socket, `<ws_url>/stream`
   * the public one.
   *
   * LIVE for every network with a {@link baseUrl}: `loadConfig` hands this
   * string to `create_ws_token` as `ws_endpoint`'s base whenever a named network
   * selects the target, so there is one place the socket URL is written and the
   * durable and derived values cannot disagree. An explicit
   * `NEXUS_EXCHANGE_API_URL` still derives its own (scheme-swapped gateway base).
   *
   * On the public hosts it carries the `/v1` prefix, NOT the bare origin: the
   * edge routes no WebSocket path at a host's root (`wss://<host>/stream` is a
   * 404), and `/v1` is the published prefix (nexus#12253, ENG-17132). The rule
   * it follows is "the spec's REST base with the scheme swapped", because
   * `POST /ws/token` binds a token to the host that minted it.
   */
  readonly durableWsUrl: string;
}

/**
 * The network → target map, frozen so a compromised or buggy tool cannot
 * rewrite a base URL at runtime and quietly redirect signed requests (every
 * request carries an HMAC key id and signature, so the destination is
 * security-relevant, not just a routing detail).
 */
export const NETWORKS: Readonly<Record<NetworkId, NetworkDescriptor>> =
  Object.freeze({
    testnet: Object.freeze({
      id: "testnet",
      label: "Testnet",
      funds: "play",
      faucet: true,
      // ON THE DURABLE HOST AS OF ENG-8869. `api.testnet.nexus.xyz` resolves
      // and fronts the `apps-prod-testnet` indexer, so testnet no longer points
      // at the legacy `exchange.nexus.xyz/api/exchange` gateway. That was not a
      // tidy-up: the legacy gateway proxies to the Cloud Run indexer
      // `exchange-indexer-t3jdki3hoa-uc.a.run.app`, which is decommissioned and
      // answers `500` on every route (ENG-14039). The base this server shipped
      // was dead, so this is a repair rather than a migration.
      //
      // THE BASE IS THE SPEC'S `/v1` REST BASE (EDR-006, ENG-18323). Every
      // tool appends the spec's bare path (`/orders`) and signs that path; the
      // edge strips `/v1` before the indexer verifies, so what is signed is
      // what is checked. This replaced `/indexer` plus a per-path `/api/v1`,
      // which put two prefixes on one host (ENG-17186). The bridge routes are
      // the one exception (see `V1_ONLY_PATH` in `client.ts`). The bare host
      // routes nothing, so copy the base whole. Measured 2026-09-30,
      // unauthenticated:
      //
      //   /v1/markets/summary      -> 200 JSON
      //   /v1/account              -> 401 JSON (routed; auth evaluated)
      //   /v1/api/v1/bridge/assets -> 401 JSON (routed)
      //   /markets/summary         -> 404 (no route)
      baseUrl: "https://api.testnet.nexus.xyz/v1",
      gatewayPath: "",
      // The same string as `baseUrl`, and the spec's `rest_base`.
      durableRestBase: "https://api.testnet.nexus.xyz/v1",
      // The REST base with the scheme swapped (spec `ws_url`, ENG-17132).
      // Measured 2026-09-23 with an RFC 6455 upgrade:
      //
      //   wss://api.testnet.nexus.xyz/v1/stream        -> 101
      //   wss://api.testnet.nexus.xyz/v1/ws?token=x    -> 401 (handler reached)
      //   wss://api.testnet.nexus.xyz/stream, /ws      -> 404 (no route)
      durableWsUrl: "wss://api.testnet.nexus.xyz/v1",
    }),
    mainnet: Object.freeze({
      id: "mainnet",
      label: "Mainnet",
      funds: "real",
      faucet: false,
      // No reachable host. `api.nexus.xyz` has no DNS yet and no operation is
      // mapped onto its `/v1` base, so any URL built for it would be a guess —
      // on the single network where a guess moves real money. Selecting mainnet
      // therefore fails loudly (see `unreachableNetworkMessage`) rather than
      // emitting a plausible-looking wrong URL. Point NEXUS_EXCHANGE_API_URL at
      // it deliberately once it is live.
      baseUrl: null,
      // NOT unused, despite `baseUrl` being null. Selecting mainnet alone throws
      // before any URL is built, but `NEXUS_EXCHANGE_NETWORK=mainnet` alongside
      // an explicit URL is the sanctioned way to reach real funds today — and
      // this field decides where every request lands on the one network that
      // moves real money.
      //
      // It stays the public-gateway convention for now, on purpose. Since
      // ENG-18323 this server's paths are bare, which is the shape the `/v1`
      // `durableRestBase` serves, so `""` is where this lands once
      // `api.nexus.xyz` resolves (ENG-15183). Until then no operation is
      // mapped onto that host and neither value is a measurement, so the
      // convention stands: the one every other undeclared
      // shape in this package already resolves to (`resolveGatewayPath`'s
      // default, and the bare-URL form's assumption) — a second, different
      // default for one network would be a guess wearing a disguise. An operator
      // whose mainnet deployment serves at its root says so the documented way:
      // the full `custom` bundle with `NEXUS_EXCHANGE_FUNDS=real` and
      // `NEXUS_EXCHANGE_GATEWAY_PATH=/`, which declares the shape instead of
      // inheriting it. `test/networks.test.ts` pins both halves of that.
      gatewayPath: "/api/exchange",
      durableRestBase: "https://api.nexus.xyz/v1",
      // The REST base with the scheme swapped, `/v1` included: the same shape as
      // testnet (spec `ws_url`, nexus#12253). The bare origin this used to carry
      // is the shape that 404s on testnet. Like everything else in this entry it
      // DOES NOT RESOLVE YET — `api.nexus.xyz` has no DNS (ENG-15183) — so it is
      // the URL mainnet will serve, not one that answers today.
      durableWsUrl: "wss://api.nexus.xyz/v1",
    }),
    local: Object.freeze({
      id: "local",
      label: "Local",
      funds: "play",
      faucet: true,
      // The one network whose durable base and today's base agree, because it
      // is just the indexer served directly. Never a fallback for a public host
      // that fails to resolve: silently succeeding against localhost hides a
      // misconfigured client, so nothing in this package falls back to it.
      baseUrl: "http://localhost:9090",
      // No `/api/exchange` prefix: the spec's local `servers` entry is the bare
      // origin (the public one carries the gateway path), because the indexer
      // serves the spec's paths directly. `deriveBases` appends the prefix by
      // default, so local has to say otherwise explicitly.
      gatewayPath: "",
      durableRestBase: "http://localhost:9090",
      durableWsUrl: "ws://localhost:9090",
    }),
  });

/** The network used when nothing selects one. Play funds, never real. */
export const DEFAULT_NETWORK: NetworkId = "testnet";

/**
 * Names that used to be `Network` enum values across the SDKs but are release
 * channels, not networks (`beta` is a deployment OF testnet, not a third pool
 * of money). They are demoted to an explicit URL override rather than aliased
 * to a network, because silently aliasing would re-conflate the two axes this
 * change exists to separate.
 */
const DEMOTED_RELEASE_CHANNELS = new Set(["stable", "beta", "staging", "prod"]);

/**
 * Bound untrusted input before it is echoed into an error message or a log
 * line. Keeps a pathological `NEXUS_EXCHANGE_NETWORK` from flooding stderr.
 */
function quoteForMessage(raw: string): string {
  const clipped = raw.length > 64 ? `${raw.slice(0, 64)}…` : raw;
  // Replace control characters so a crafted value cannot forge log lines: a
  // bare newline in an error message would otherwise look like a new record.
  // eslint-disable-next-line no-control-regex
  return JSON.stringify(clipped.replace(/[\u0000-\u001f\u007f]/g, "?"));
}

/**
 * Resolve a `NEXUS_EXCHANGE_NETWORK` value to a known network, or throw.
 *
 * Case- and whitespace-insensitive, but never lenient about the result: an
 * unknown identifier throws rather than defaulting, because the spec's fail-safe
 * rule is to treat anything unrecognized as real funds and require confirmation.
 */
export function resolveNetworkId(raw: string): NetworkId {
  const id = raw.trim().toLowerCase();
  if ((NETWORK_IDS as readonly string[]).includes(id)) {
    return id as NetworkId;
  }
  if (DEMOTED_RELEASE_CHANNELS.has(id)) {
    throw new Error(
      `NEXUS_EXCHANGE_NETWORK=${quoteForMessage(raw)} is a release channel, not a ` +
        `network. The network axis is ${NETWORK_IDS.join(" | ")}. To target a ` +
        `staging or beta deployment, leave NEXUS_EXCHANGE_NETWORK unset and point ` +
        `NEXUS_EXCHANGE_API_URL at its URL instead.`,
    );
  }
  throw new Error(
    `Unknown NEXUS_EXCHANGE_NETWORK=${quoteForMessage(raw)}. Valid values are ` +
      `${NETWORK_IDS.join(" | ")} | ${CUSTOM_TARGET_ID}. Refusing to guess: an ` +
      `unrecognized network is treated as real funds, so this fails rather than ` +
      `assuming play money. To target a private stage, use ` +
      `NEXUS_EXCHANGE_NETWORK=${CUSTOM_TARGET_ID} and declare its bundle (see ` +
      `the README "A custom stage" section).`,
  );
}

// ── The custom target (ENG-9828, parent ENG-9823) ───────────────────────────
//
// Everything below this line is CLIENT-SIDE ONLY. `custom` is not a value the
// server accepts and it must never appear in the spec's `x-nexus-networks`, so
// it is deliberately NOT a member of {@link NETWORK_IDS} and has no entry in
// {@link NETWORKS} — those two stay a faithful copy of the spec extension.
//
// What it replaces: this server used to synthesize an inline `"custom"` label
// with `funds: "unknown"` inside `loadConfig` and carry the pair as widened
// union types (`NetworkId | "custom"`, `Funds | "unknown"`). The label was
// honest about not knowing whose money was behind the URL, but nothing acted on
// it. A private stage is exactly where that matters, so the pair became a
// descriptor — built once, validated once, frozen, and passed around.

/**
 * The id of the client-side custom target. Not a network: a network is a pool of
 * money named by the spec, and this is "whatever host the operator pointed us
 * at". No hostname for any private stage appears in this package — the caller
 * supplies it.
 */
export const CUSTOM_TARGET_ID = "custom";

/** What a resolved target can be: a named network, or the custom target. */
export type TargetId = NetworkId | typeof CUSTOM_TARGET_ID;

/**
 * Characters allowed in a caller-supplied target label.
 *
 * Restricted on purpose (parent ENG-9823, resolved question 2): across the
 * fleet this label is the key stored credentials are namespaced under — it ends
 * up in a keyring entry or a filesystem path — so `../other`, `one/two`,
 * `one:two`, `one two`, an embedded newline or NUL, and non-ASCII (where
 * normalization makes two distinct labels collide) must all be rejected, or one
 * target's label can address another target's credentials.
 *
 * This server namespaces nothing — its credentials come from the environment —
 * but the constraint is enforced here anyway. It is a fleet-wide invariant, and
 * a label that is safe in four clients and lax in the fifth is not an invariant.
 * It also means the label is safe to interpolate into an error message or a log
 * line, since no control character can reach one.
 */
const TARGET_LABEL_RE = /^[A-Za-z0-9._-]+$/;

/** Cap on a caller-supplied label, so it cannot flood a log line. */
export const MAX_TARGET_LABEL_LENGTH = 64;

/**
 * A fully-resolved target: everything the server needs to know about where it
 * is pointed and whose money is there.
 *
 * This is the shape the named networks and the custom target BOTH produce, which
 * is the point — a guard reads the same fields either way, so there is one code
 * path instead of one per configuration mechanism.
 */
export interface ResolvedTarget {
  readonly id: TargetId;
  /**
   * Human-facing name. For a named network this is the spec's spelling; for the
   * custom target it is caller-supplied and validated against
   * {@link TARGET_LABEL_RE}.
   */
  readonly label: string;
  /** Whose money is behind this target — `"unknown"` when nobody said. */
  readonly funds: DeclaredFunds;
  /**
   * Whether the synthetic-funding operations (faucet / credit) exist here.
   *
   * SEPARATE from {@link funds}, and assumed absent until declared: "not real
   * money" does not imply "has a faucet", and routing a funding call at a stage
   * that has none just produces a confusing upstream error.
   */
  readonly faucet: boolean;
  /** Host root this target is reached at, no trailing slash, no query/fragment. */
  readonly restBase: string;
  /** Where the legacy gateway surface hangs off {@link restBase}. */
  readonly gatewayPath: "" | "/api/exchange";
}

/**
 * Validate a caller-supplied target label, or throw.
 *
 * Surrounding whitespace is trimmed first (an env var routinely picks up a
 * trailing newline from a shell heredoc); everything after that must satisfy
 * {@link TARGET_LABEL_RE}. `.` and `..` are rejected explicitly — both pass the
 * character class and both are path traversal in the clients that use the label
 * as a path segment.
 *
 * @param varName the environment variable being read, named in the error so the
 * message is actionable rather than describing an abstract "label".
 */
export function validateTargetLabel(raw: string, varName: string): string {
  const label = raw.trim();
  if (!label) {
    throw new Error(`${varName} must not be empty.`);
  }
  if (label.length > MAX_TARGET_LABEL_LENGTH) {
    throw new Error(
      `${varName} is ${label.length} characters; the maximum is ` +
        `${MAX_TARGET_LABEL_LENGTH}.`,
    );
  }
  if (label === "." || label === "..") {
    throw new Error(
      `${varName}=${quoteForMessage(label)} is not a usable label: it is a ` +
        `path traversal in the clients that namespace stored credentials by it.`,
    );
  }
  if (!TARGET_LABEL_RE.test(label)) {
    throw new Error(
      `${varName}=${quoteForMessage(raw)} contains characters that are not ` +
        `allowed in a target label. Use only letters, digits, "." , "_" and "-" ` +
        `(no "/", ":", whitespace, or non-ASCII): this label is the key stored ` +
        `credentials are namespaced under across the Nexus clients, so a label ` +
        `that can name a path or normalize onto another label is refused.`,
    );
  }
  return label;
}

/**
 * Build a {@link ResolvedTarget}, validating every field and freezing the
 * result.
 *
 * The single constructor for both configuration mechanisms, so the invariants
 * (label shape, tri-state funds, closed gateway-path set) hold once instead of
 * per branch. Frozen for the same reason {@link NETWORKS} is: a tool handler
 * receives this object transitively, and a target whose `funds` or `restBase`
 * can be rewritten at runtime is a disabled guard and a redirect for every
 * signed request that follows.
 */
export function defineTarget(fields: {
  id: TargetId;
  label: string;
  funds: DeclaredFunds;
  faucet: boolean;
  restBase: string;
  gatewayPath: "" | "/api/exchange";
}): ResolvedTarget {
  if (!fields.restBase) {
    throw new Error(`Target "${fields.label}" has no base URL.`);
  }
  return Object.freeze({ ...fields });
}

/** The error text for selecting a network that has no reachable host yet. */
export function unreachableNetworkMessage(desc: NetworkDescriptor): string {
  return (
    `NEXUS_EXCHANGE_NETWORK="${desc.id}" has no reachable host yet: ` +
    `${desc.durableRestBase} is not resolvable (DNS is ENG-8155) and no operation ` +
    `is mapped onto it in the pinned spec, so this server cannot build a correct ` +
    `URL for it. ${
      desc.funds === "real"
        ? "Refusing rather than guessing, because this network moves real money. "
        : ""
    }Set NEXUS_EXCHANGE_API_URL explicitly to target it once it is live.`
  );
}
