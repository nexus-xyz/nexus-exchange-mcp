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
   * The origin this server actually talks to TODAY, or `null` when the network
   * has no host it can reach yet.
   *
   * This is deliberately separate from {@link durableRestBase}: the per-network
   * hosts are published in the contract but are not usable as transport yet, and
   * a base URL that merely looks right is worse than one that is absent.
   */
  readonly baseUrl: string | null;
  /**
   * The durable per-network REST base from the spec. Informational until the
   * hosts are live — see each entry's comment for why it is not yet `baseUrl`.
   */
  readonly durableRestBase: string;
  /** The durable per-network WebSocket origin from the spec. Informational. */
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
      // Still the legacy host, on purpose. The durable testnet host is not
      // routable yet (DNS/TLS is ENG-8155) AND, more decisively, the spec has
      // not mapped a single operation onto it: on nexus-exchange-api `main` the
      // `/api/v1/*` paths still carry a per-path `servers` override listing only
      // `exchange.nexus.xyz` and localhost, and the durable base is `/v1`-rooted
      // where this server's paths are `/api/v1`-rooted. So pointing at it today
      // would produce a wrong URL against a host that does not answer. This
      // value is exactly what the server has always used, which is why the
      // default stays byte-for-byte unchanged.
      baseUrl: "https://exchange.nexus.xyz",
      durableRestBase: "https://api.testnet.nexus.xyz/v1",
      durableWsUrl: "wss://api.testnet.nexus.xyz",
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
      durableRestBase: "https://api.nexus.xyz/v1",
      durableWsUrl: "wss://api.nexus.xyz",
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
      `${NETWORK_IDS.join(" | ")}. Refusing to guess: an unrecognized network is ` +
      `treated as real funds, so this fails rather than assuming play money.`,
  );
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
