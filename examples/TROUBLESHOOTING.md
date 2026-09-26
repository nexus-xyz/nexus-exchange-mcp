# Troubleshooting

Common failure modes when running the examples (or the server under a real
agent), roughly in the order you'll hit them.

## Every tool errors immediately / `Cannot find module dist/index.js`

The examples spawn the **built** server. Run `npm install && npm run build`
first; rerun `npm run build` after pulling changes.

## `/api/v1` tools return 404 with an HTML body

A 404 whose body is HTML (not JSON) means the request reached a web app, not
the exchange API — the host you're pointing at doesn't serve the direct
`/api/v1` surface. Check `NEXUS_EXCHANGE_API_URL`:

- It must be the deployment's **base** (e.g. `https://api.testnet.nexus.xyz/indexer`
  or `http://localhost:9090`) — not a SURFACE path like `…/api/v1`. A route
  prefix the deployment mounts the API under, such as testnet's `/indexer`, is
  part of the base and must be kept. A legacy value ending in `/api/exchange`
  is accepted and normalized.
- **Check the gateway path, which is where `/api/v1` hangs off that host.** It
  comes from the network, not the URL (ENG-6221): testnet serves
  `…/indexer/api/v1/…`, while an indexer serving at its root needs
  `NEXUS_EXCHANGE_NETWORK=local` alongside the URL (or, for a stage that is not
  a named network, the full `custom` bundle — `NEXUS_EXCHANGE_NETWORK=custom`
  plus `NEXUS_EXCHANGE_NETWORK_LABEL`, `NEXUS_EXCHANGE_FUNDS` and
  `NEXUS_EXCHANGE_GATEWAY_PATH=/`; that last variable is refused on its own). A
  bare `NEXUS_EXCHANGE_API_URL` assumes the retired public-gateway shape, so
  pointing it alone at a bare indexer — or at testnet's `/indexer` base — sends
  `/api/v1/*` under `/api/exchange`, where nothing is served. Name the network.
- Pointing at the **bare host root** used to be the documented advice and was
  the cause of this exact 404: `https://exchange.nexus.xyz/api/v1/*` was the
  marketing app, and `https://api.testnet.nexus.xyz/api/v1/*` is a 404 with no
  route behind it. Composing the v1 surface under the deployment's prefix is
  what ENG-6221 fixed; ENG-8869 changed which prefix that is.
- Legacy-gateway tools (marked "(legacy)" in the top-level README table) can
  work while `/api/v1` tools 404 on the same host — that's the dual-stack
  migration (ENG-4740/ENG-4751), not a bug in your config.

## `Tool "…" requires API credentials`

The tool is HMAC-authenticated and the server has no key. Set
`NEXUS_EXCHANGE_API_KEY` + `NEXUS_EXCHANGE_API_SECRET` in the environment the
**server** runs in (for Claude Desktop: the `env` block of the server entry;
for the examples: your shell). Public and `demo_*` tools never need this.

## Authenticated calls succeed but show the WRONG account

You're going through the public production proxy, which re-signs requests with
the site's own frontend key — your per-caller HMAC headers are not honored, so
reads resolve to the site account. Point `NEXUS_EXCHANGE_API_URL` at a
**direct** indexer gateway that verifies client HMAC, and **name the network it
belongs to**:

```bash
NEXUS_EXCHANGE_NETWORK=local NEXUS_EXCHANGE_API_URL=http://localhost:9090
```

The network is what carries the deployment shape (ENG-6221): a bare URL assumes
the public-gateway one and sends every `/api/v1` route under `/api/exchange`,
where a local indexer serves nothing — trading the wrong-account failure for a 404. For an indexer that is not one of the named networks, describe it with the
full `custom` bundle and `NEXUS_EXCHANGE_GATEWAY_PATH=/`. See "Authentication"
in the top-level README.

## `Exchange API 401` on signed calls

- Key id or secret is wrong (the secret must be the **hex** string, decoded
  server-side — not base64).
- Clock skew: the HMAC canonical string starts with a client timestamp; a
  machine clock minutes off will fail verification.
- The key was deleted (`delete_api_key`) or the agent registration expired
  (`fetch_agents` shows expiries).
- On a **gatewayed** deployment the signature covers the _logical_ route
  (`/api/v1/orders`), not the wire path (`/api/exchange/api/v1/orders`) — the
  deployment's gateway path belongs to the base and is not signed over, so
  verification depends on the gateway stripping its own prefix before the
  indexer checks. If signed calls 401 there while the same key works against a
  bare indexer (`NEXUS_EXCHANGE_NETWORK=local`), that stripping is the thing to
  check, not your canonical string.

## `Exchange API 429` / rate limits

The gateway enforces per-account request budgets. Agents should:

1. Call `fetch_rate_limit_status` and pace themselves against the remaining
   budget — it's cheap and HMAC-scoped to your key.
2. Back off on 429 (the response is machine-readable JSON).
3. Batch: one `create_orders` call instead of N `create_order` calls;
   `fetch_tickers` instead of N `fetch_ticker` calls.
4. Prefer WebSocket streaming (see `ws-streaming.mjs`) over polling loops for
   anything faster than ~1 Hz.

## `login` / `register_agent` complain about signatures

Both tools carry a **wallet** signature the caller must produce — this server
never holds a wallet key and cannot sign for you:

- `login`: EIP-191 `personal_sign` over exactly `"Sign in to Nexus Exchange"`.
- `register_agent`: EIP-712 over `RegisterAgent{agent, expiresAt, nonce}`
  (domain `NexusExchange` v1), signed by the **owner wallet**, not the agent
  key.

Sign in the wallet (or an external script) and pass the hex signature as the
`signature` argument.

## `*_api_key` tools throw `requires a session token`

The `/keys` management endpoints authenticate with a Bearer session token, not
HMAC. Call `login` (24h token) and set it as `NEXUS_EXCHANGE_SESSION_TOKEN` in
the server's environment.

## WebSocket connects then immediately closes

WS tokens are **single-use** and expire in **60 seconds**. Mint with
`create_ws_token`, connect once, and mint a fresh token for every reconnect.
Also check you're using the right protocol for the endpoint: `/ws` speaks
`{op: "subscribe", channel: …}` envelopes; the legacy `/stream` takes a single
`{"subscribe": [...]}` message (tokens for it come from `create_ws_token_legacy`).

## `create_order` / the deposit tools say the target "has not declared whose money is behind it"

You set `NEXUS_EXCHANGE_API_URL` and nothing else. A URL says where to send
requests, not whether the balances there are real — so the tools that cannot be
undone refuse rather than assume play funds. Reads, `preview_order` and
`cancel_order` keep working throughout.

Name the network that URL belongs to:

```bash
NEXUS_EXCHANGE_NETWORK=local   # alongside e.g. http://localhost:9090
```

For a deployment that is not one of the named networks, describe it once with the
`custom` bundle — `NEXUS_EXCHANGE_NETWORK=custom` plus
`NEXUS_EXCHANGE_NETWORK_LABEL` and `NEXUS_EXCHANGE_FUNDS=real|play` (top-level
README, "A custom stage"). Declaring `real` is a valid answer: the guard asks
that somebody know, not that the money be play.

If instead the message names a faucet, `claim_faucet` / `claim_credit` also need
the stage to HAVE one — set `NEXUS_EXCHANGE_FAUCET=1`. "Not real money" does not
imply a faucet exists, so it is assumed absent.

## `cancel_order` / `cancel_all_orders` refuse to run

By design. `cancel_order` cancels exactly one order and needs both `order_id`
and `market_id`; it no longer has a `cancel_all` mode (ENG-17742). To
mass-cancel, call `cancel_all_orders` with `confirm: true` (optionally scoped by
`market_id`). The same `confirm: true` pattern guards `revoke_agent` /
`delete_api_key` / `delete_tier`.

## Admin tools are missing from `tools/list`

`fetch_tiers` / `set_tier` / `delete_tier` are registered only when
`NEXUS_EXCHANGE_ENABLE_ADMIN_TOOLS=1` (plus `NEXUS_EXCHANGE_ADMIN_SECRET`).
That's an opt-in, not a bug — never enable them on an agent surface you don't
fully trust.
