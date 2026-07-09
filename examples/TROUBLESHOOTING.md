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

- It must be the API **host root** (e.g. `https://exchange.nexus.xyz` or
  `http://localhost:9090`) — not a path like `…/api/v1`. A legacy value ending
  in `/api/exchange` is accepted and normalized.
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
**direct** indexer gateway that verifies client HMAC (e.g. a local
`http://localhost:9090` from the exchange `docker-compose`). See
"Authentication" in the top-level README.

## `Exchange API 401` on signed calls

- Key id or secret is wrong (the secret must be the **hex** string, decoded
  server-side — not base64).
- Clock skew: the HMAC canonical string starts with a client timestamp; a
  machine clock minutes off will fail verification.
- The key was deleted (`delete_api_key`) or the agent registration expired
  (`list_agents` shows expiries).

## `Exchange API 429` / rate limits

The gateway enforces per-account request budgets. Agents should:

1. Call `get_rate_limit_status` and pace themselves against the remaining
   budget — it's cheap and HMAC-scoped to your key.
2. Back off on 429 (the response is machine-readable JSON).
3. Batch: one `place_orders_batch` call instead of N `place_order` calls;
   `get_tickers` instead of N `get_ticker` calls.
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
`get_ws_token`, connect once, and mint a fresh token for every reconnect.
Also check you're using the right protocol for the endpoint: `/ws` speaks
`{op: "subscribe", channel: …}` envelopes; the legacy `/stream` takes a single
`{"subscribe": [...]}` message (tokens for it come from `get_ws_token_legacy`).

## `cancel_order` refuses to run

By design. An argless call could mean "cancel everything", so the tool makes
destruction explicit: pass `order_id` + `market_id` to cancel one order, or
`cancel_all: true` (optionally scoped by `market_id`) to mass-cancel. The same
pattern guards `revoke_agent` / `delete_api_key` / `delete_tier`
(`confirm: true`).

## Admin tools are missing from `tools/list`

`list_tiers` / `set_tier` / `delete_tier` are registered only when
`NEXUS_EXCHANGE_ENABLE_ADMIN_TOOLS=1` (plus `NEXUS_EXCHANGE_ADMIN_SECRET`).
That's an opt-in, not a bug — never enable them on an agent surface you don't
fully trust.
