# Nexus Exchange MCP Server

[![License](https://img.shields.io/badge/license-MIT%2FApache--2.0-blue.svg)](#license)

An [MCP](https://modelcontextprotocol.io) server that exposes the Nexus
Exchange API as tools an AI agent (Claude Desktop / Claude Code) can call to
read market data and place trades.

It talks to the real, public exchange gateway. Market-data and demo tools work
with zero configuration; account and trading tools use HMAC API credentials
read from environment variables.

## What works today

Most tools now target the direct-indexer **`/api/v1`** surface served at the
host root (ENG-4740 — the indexer serves its REST API directly instead of via
the gateway REST proxy). The routes that have no `/api/v1` equivalent stay on
the **legacy `/api/exchange`** gateway, which remains live dual-stack
(ENG-4751), so nothing breaks. See "Migration to `/api/v1`" below.

| Tool                            | Status                                          | Endpoint (surface)                         |
| ------------------------------- | ----------------------------------------------- | ------------------------------------------ |
| `list_markets`                  | ✅ Live (public)                                | `GET /api/v1/markets/summary`              |
| `list_market_specs`             | ✅ Live (public)                                | `GET /markets` (legacy)                    |
| `get_ticker`                    | ✅ Live (public)                                | `GET /api/v1/markets/{id}/ticker`          |
| `get_tickers`                   | ✅ Live (public)                                | `GET /api/v1/tickers`                      |
| `get_orderbook`                 | ✅ Live (public)                                | `GET /api/v1/markets/{id}/orderbook`       |
| `get_mark_price`                | ✅ Live (public)                                | `GET /api/v1/markets/{id}/mark-price`      |
| `get_market_status`             | ✅ Live (public)                                | `GET /api/v1/markets/{id}/status`          |
| `get_trades`                    | ✅ Live (public)                                | `GET /api/v1/markets/{id}/trades`          |
| `get_candles`                   | ✅ Live (public)                                | `GET /api/v1/markets/{id}/candles`         |
| `get_funding_history`           | ✅ Live (public)                                | `GET /api/v1/markets/{id}/funding`         |
| `get_funding_samples`           | ✅ Live (public)                                | `GET /api/v1/markets/{id}/funding-samples` |
| `get_market_risk_params`        | ✅ Live (public)                                | `GET /markets/{id}/risk-params` (legacy)   |
| `get_stats`                     | ✅ Live (public)                                | `GET /api/v1/stats`                        |
| `get_stats_history`             | ✅ Live (public)                                | `GET /api/v1/stats/history`                |
| `get_demo_account`              | ✅ Live (public)                                | `GET /demo/account` (legacy)               |
| `get_demo_positions`            | ✅ Live (public)                                | `GET /demo/positions` (legacy)             |
| `get_demo_orders`               | ✅ Live (public)                                | `GET /demo/orders` (legacy)                |
| `get_balance`                   | ✅ Live (needs key + direct gateway)            | `GET /api/v1/account`                      |
| `get_account_summary`           | ✅ Live (needs key + direct gateway)            | `GET /api/v1/account/summary`              |
| `get_equity_history`            | ✅ Live (needs key + direct gateway)            | `GET /api/v1/account/equity-history`       |
| `get_positions`                 | ✅ Live (needs key + direct gateway)            | `GET /api/v1/positions`                    |
| `get_closed_positions`          | ✅ Live (needs key + direct gateway)            | `GET /api/v1/positions/closed`             |
| `get_open_orders`               | ✅ Live (needs key + direct gateway)            | `GET /api/v1/orders`                       |
| `get_order`                     | ✅ Live (needs key + direct gateway)            | `GET /orders/{id}` (legacy)                |
| `get_order_history`             | ✅ Live (needs key + direct gateway)            | `GET /api/v1/orders/history`               |
| `get_fills`                     | ✅ Live (needs key + direct gateway)            | `GET /api/v1/fills`                        |
| `get_funding_payments`          | ✅ Live (needs key + direct gateway)            | `GET /funding` (legacy)                    |
| `get_withdrawals`               | ✅ Live (needs key + direct gateway)            | `GET /withdrawals` (legacy)                |
| `list_deposits`                 | ✅ Live (needs key + direct gateway)            | `GET /deposits` (legacy)                   |
| `get_rate_limit_status`         | ✅ Live (needs key + direct gateway)            | `GET /api/v1/account/rate-limit`           |
| `get_cancel_on_disconnect`      | ✅ Live (needs key + direct gateway)            | `GET /api/v1/account/cancel-on-disconnect` |
| `set_cancel_on_disconnect`      | ✅ Live (needs key + direct gateway)            | `PUT /api/v1/account/cancel-on-disconnect` |
| `get_adl_history`               | ✅ Live (needs key + direct gateway)            | `GET /account/{addr}/adl-history` (legacy) |
| `get_market_adl_events`         | ✅ Live (needs key + direct gateway)            | `GET /markets/{id}/adl-events` (legacy)    |
| `place_order`                   | ✅ Live (needs key + direct gateway)            | `POST /api/v1/orders`                      |
| `place_orders_batch`            | ✅ Live (needs key + direct gateway)            | `POST /api/v1/orders/batch`                |
| `amend_order`                   | ✅ Live (needs key + direct gateway)            | `PATCH /api/v1/orders/{id}`                |
| `preview_order`                 | ✅ Live (needs key + direct gateway)            | `POST /api/v1/orders/preview`              |
| `cancel_order`                  | ✅ Live (needs key + direct gateway)            | `DELETE /api/v1/orders[/{id}]`             |
| `deposit_collateral`            | ✅ Live (needs key + direct gateway)            | `POST /account/deposit` (legacy)           |
| `submit_deposit`                | ✅ Live (needs key + direct gateway)            | `POST /deposits` (legacy)                  |
| `claim_credit`                  | ✅ Live (needs key + direct gateway)            | `POST /api/v1/account/credit`              |
| `claim_faucet`                  | ✅ Live (needs key + direct gateway)            | `POST /faucet` (legacy)                    |
| `adjust_isolated_margin`        | ✅ Live (needs key + direct gateway)            | `POST /account/margin` (legacy)            |
| `get_bridge_assets`             | ✅ Live (public)                                | `GET /api/v1/bridge/assets`                |
| `create_bridge_deposit_address` | ✅ Live (needs key + direct gateway)            | `POST /api/v1/bridge/deposit-addresses`    |
| `list_bridge_deposit_addresses` | ✅ Live (needs key + direct gateway)            | `GET /api/v1/bridge/deposit-addresses`     |
| `list_bridge_deposits`          | ✅ Live (needs key + direct gateway)            | `GET /api/v1/bridge/deposits`              |
| `get_bridge_deposit`            | ✅ Live (needs key + direct gateway)            | `GET /api/v1/bridge/deposits/{id}`         |
| `list_agents`                   | ✅ Live (needs key + direct gateway)            | `GET /agents` (legacy)                     |
| `register_agent`                | ✅ Live (needs caller EIP-712 signature)        | `POST /agents/register` (legacy)           |
| `revoke_agent`                  | ✅ Live (needs key + direct gateway)            | `DELETE /agents/{addr}` (legacy)           |
| `login`                         | ✅ Live (needs caller EIP-191 signature)        | `POST /auth/login` (legacy)                |
| `list_api_keys`                 | ✅ Live (needs session token)                   | `GET /keys` (legacy)                       |
| `create_api_key`                | ✅ Live (needs session token)                   | `POST /keys` (legacy)                      |
| `delete_api_key`                | ✅ Live (needs session token)                   | `DELETE /keys/{key_id}` (legacy)           |
| `get_ws_token`                  | ✅ Live (needs key + direct gateway)            | `POST /ws/token` (legacy)                  |
| `get_ws_token_legacy`           | ✅ Live (needs key + direct gateway)            | `POST /ws-tokens` (legacy)                 |
| `get_service_status`            | ✅ Live (public)                                | `GET /status` (legacy)                     |
| `list_tiers`                    | 🔒 Admin (opt-in, see below)                    | `GET /admin/tiers` (legacy)                |
| `set_tier`                      | 🔒 Admin (opt-in, see below)                    | `PUT /admin/tiers` (legacy)                |
| `delete_tier`                   | 🔒 Admin (opt-in, see below)                    | `DELETE /admin/tiers/{addr}` (legacy)      |
| `get_deposit_target`            | 🚧 Pending — server-side endpoint not built yet | none yet                                   |

`get_deposit_target` is wired into the agent flow but returns a clear
`not_yet_available` message rather than faking a result. On the direct surface
it is superseded by the bridge deposit-address tools
(`create_bridge_deposit_address` / `list_bridge_deposit_addresses`), which
return real per-chain on-chain deposit addresses — prefer those; the legacy
single-target lookup is still unbuilt server-side.

### Migration to `/api/v1`

Per **ENG-4740** the gateway REST proxy is being eliminated: each backend
service exposes its own REST API and the indexer serves the exchange surface
directly under `/api/v1` at the host root. This server calls those routes for
the v0.7.1 operations it exposes as tools (see
[API-surface coverage](#api-surface-coverage) below).

- **Base URL is the host root** (`https://exchange.nexus.xyz`), not the
  `…/api/exchange` gateway path. `/api/v1/*` resolves at the root; the
  legacy-only routes append `/api/exchange`. A `NEXUS_EXCHANGE_API_URL` that
  still ends in `/api/exchange` is accepted and normalized.
- **HMAC signs the full path** the server verifies — e.g. `/api/v1/orders` for
  v1 routes, the bare route (`/orders`) for legacy ones.
- **`cancel_order` requires `market_id`** when cancelling a single order (the
  v1 route marks it required); `market_id` is optional with `cancel_all` to
  scope a mass-cancel to one market.
- **Stay on the legacy gateway** (no `/api/v1` route): `list_market_specs`,
  `get_market_risk_params`, `get_order` (v1 mounts only PATCH + DELETE on
  `/orders/{id}`), `get_withdrawals`, `list_deposits`, `get_funding_payments`,
  `get_adl_history`, `get_market_adl_events`, `deposit_collateral`,
  `submit_deposit`, `claim_faucet`, `adjust_isolated_margin`, the agent /
  api-key / admin-tier tools, `get_ws_token*`, `get_service_status`, and the
  `demo/*` reads. (The cancel-on-disconnect and bridge tools are v1-native.)

### API-surface coverage

The tool surface covers **60 of the 62** distinct operations in Exchange API
spec **v0.7.1** (92 spec operations counting the `/api/v1` aliases of the
legacy routes; each aliased pair is one tool).

The pin bump (ENG-6038) was pin-only — it advanced `.api-version` v0.6.2 →
v0.7.1 without mapping the surface those releases had added. ENG-6136 then
exposed those additions as tools (the spec version each shipped in is noted):

- **Account cancel-on-disconnect** (v0.7.1) — `get_cancel_on_disconnect` /
  `set_cancel_on_disconnect` (`GET` / `PUT /api/v1/account/cancel-on-disconnect`).
- **`/api/v1/bridge` Phase A** (v0.7.1) — `get_bridge_assets` (public catalog),
  `create_bridge_deposit_address`, `list_bridge_deposit_addresses`,
  `list_bridge_deposits`, and `get_bridge_deposit` (five operations).
- **Conditional order types** (v0.7.0) — `place_order` / `place_orders_batch` /
  `preview_order` now map all six conditional `order_type`s in addition to
  `limit` / `market`: stop-loss (`stop_limit` / `stop_market`), take-profit
  (`take_profit_limit` / `take_profit_market`), and trailing (`trailing_stop` /
  `trailing_limit`), via the `trigger_price`, `trailing_offset_bps`, and
  `limit_offset_bps` fields. These are a schema addition on the already-mapped
  order endpoint, so they change no route count — which is why the pin bump's
  operation-count metric never surfaced the gap.

The remaining 2-operation gap is the WebSocket **upgrade** endpoints `GET /ws`
and `GET /stream`, unmapped by design: a request/response MCP tool cannot hold a
streaming socket open, so the server instead mints the auth token
(`get_ws_token` / `get_ws_token_legacy`) the caller uses to connect to them
directly.

Reconciling the liveness surface: v0.7.0 removed the standalone `/health` and
`/ready` routes from the public contract (only `/status` remains), so the former
`get_health` / `get_readiness` tools — which called routes the pinned spec no
longer documents — were **dropped** in favour of the surviving
`get_service_status` (`/status`).

### Authorization tiers

- **Public** — no credentials.
- **HMAC (key + direct gateway)** — account reads, trading, agent/funding
  actions. Uses `NEXUS_EXCHANGE_API_KEY` / `NEXUS_EXCHANGE_API_SECRET`. See the
  "Authentication" note below about the public proxy.
- **Caller signature** — `login` (EIP-191) and `register_agent` (EIP-712) carry
  a wallet signature the caller produces externally; this server never holds a
  wallet key and cannot sign for you.
- **Session token** — the `*_api_key` tools authenticate with a Bearer session
  token from `login`, set as `NEXUS_EXCHANGE_SESSION_TOKEN`.
- **Admin (opt-in)** — `list_tiers` / `set_tier` / `delete_tier` use the
  operator admin secret and mutate other accounts' fee tiers. They are **not
  registered** unless `NEXUS_EXCHANGE_ENABLE_ADMIN_TOOLS=1` is set (and
  `NEXUS_EXCHANGE_ADMIN_SECRET` provided). Never enable these on an untrusted
  agent surface.

Destructive tools (`revoke_agent`, `delete_api_key`, `delete_tier`, and
`cancel_order`'s mass-cancel) require an explicit `confirm: true` /
`cancel_all: true` flag so a stray call can't do damage by accident.

## Quick start

```bash
npm install
npm run build
npm start          # runs the stdio MCP server
```

`npm start` waits on stdio for an MCP client; it is meant to be launched by
Claude rather than run by hand. To verify it works end-to-end against the live
API without a client, use the smoke check:

```bash
npm run smoke      # lists tools, calls list_markets against production
```

Expected output ends with `list_markets OK -> N markets`.

## Environment variables

Copy `.env.example` and set as needed. Only trading/account tools need
credentials — never commit real secrets.

| Variable                            | Required                | Purpose                                                                                                                                          |
| ----------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NEXUS_EXCHANGE_API_URL`            | No                      | API host root (serves `/api/v1`). Defaults to `https://exchange.nexus.xyz`. A legacy value ending in `/api/exchange` is accepted and normalized. |
| `NEXUS_EXCHANGE_API_KEY`            | For account/trade tools | HMAC API key id (`x-api-key`).                                                                                                                   |
| `NEXUS_EXCHANGE_API_SECRET`         | For account/trade tools | HMAC secret (hex).                                                                                                                               |
| `NEXUS_EXCHANGE_SESSION_TOKEN`      | For `*_api_key` tools   | Bearer session token from `login` (`POST /auth/login`).                                                                                          |
| `NEXUS_EXCHANGE_ADMIN_SECRET`       | For admin tools         | Operator admin secret (`ADMIN_SECRET`). Only with the flag below.                                                                                |
| `NEXUS_EXCHANGE_ENABLE_ADMIN_TOOLS` | No                      | Set to `1` to register the admin tier tools. Off by default.                                                                                     |

## API version

<!-- api-version-sync:start -->

Currently targets Exchange API spec **`v0.7.1`**.

<!-- api-version-sync:end -->

The pinned version lives in [`.api-version`](./.api-version); the spec itself is
published by
[`nexus-xyz/nexus-exchange-api`](https://github.com/nexus-xyz/nexus-exchange-api).
This repo does not vendor a copy — the `drift` CI job fetches the pinned release
to check for drift, and the scheduled `api-version-sync` workflow opens a PR when
a newer spec releases. The line above is bot-managed; everything around it is
human-owned.

Every upstream request also sends this pin as an `X-Nexus-Api-Version: <tag>`
header (e.g. `X-Nexus-Api-Version: v0.7.1`), alongside a normalized
`User-Agent: nexus-exchange-mcp/<version>`, so the exchange edge can attribute
and segment usage by client and by the contract version this server targets.
The header value is the server's own compiled-against tag — it is baked in at
build time (a test keeps it equal to [`.api-version`](./.api-version)), so it is
never taken from caller input.

## Authentication

Signed requests use the same canonical HMAC-SHA256 scheme the indexer verifies
(`backend/services/indexer/src/auth.rs`):

```text
<timestamp>\n<METHOD>\n<path>\n<query>\n<sha256hex(body)>
```

signed with the hex-decoded secret and sent as `x-signature` alongside
`x-api-key` and `x-timestamp`.

For `/api/v1` routes the signed path includes the prefix (e.g. `/api/v1/orders`);
for legacy gateway routes it is the bare path (e.g. `/orders`). The client signs
whatever path it sends, which is exactly what the indexer verifies over.

Important: the public production host still fronts authenticated requests with a
proxy that signs with the site's own frontend key, so per-caller HMAC headers
are not honored there — authenticated tools resolve to the site account, not
yours. To trade as a specific account, point `NEXUS_EXCHANGE_API_URL` at a
direct indexer gateway that verifies client HMAC (for example a local
`http://localhost:9090` from the exchange `docker-compose`). Until then, use the
public `get_demo_*` tools to demo the account flow with no secrets.

## Claude Desktop config

Add this to your Claude Desktop config
(`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS),
adjusting the absolute path to this package's `dist/index.js`:

```json
{
  "mcpServers": {
    "nexus-exchange": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/nexus-exchange-mcp/dist/index.js"],
      "env": {
        "NEXUS_EXCHANGE_API_URL": "https://exchange.nexus.xyz"
      }
    }
  }
}
```

To enable trading, add `NEXUS_EXCHANGE_API_KEY` / `NEXUS_EXCHANGE_API_SECRET`
to the `env` block and set `NEXUS_EXCHANGE_API_URL` to a direct gateway.

## Demo script

1. Add the config above, restart Claude Desktop, and confirm `nexus-exchange`
   appears in the tools list.
2. Ask: "Show me the BTC market on Nexus" — Claude calls `list_markets` /
   `get_ticker` and reports the live BTC-USDX-PERP price.
3. Ask: "What's in the demo account and its open positions?" — Claude calls
   `get_demo_account` and `get_demo_positions` against the live exchange.

## Hosted HTTP server (remote MCP)

The stdio server above runs locally and holds your API key on your machine. The
hosted **Streamable HTTP** server is the remote front door: it lets a trader
add Nexus as a remote MCP server without running any key-holding software
locally.

```bash
npm run build
npm run start:http   # listens on :8080, MCP endpoint at /mcp, probe at /healthz
```

Behind a TLS-terminating ingress this is the public endpoint
`https://mcp.exchange.nexus.xyz/mcp`. A client adds it with:

```bash
claude mcp add --transport http nexus https://mcp.exchange.nexus.xyz/mcp
```

It exposes the **same tool surface** as the stdio server — both transports
register the identical `ToolDef[]` from `src/tools/` via
`createServerForClient` in `src/server.ts`, so the tools never drift. The
transport is the SDK's `StreamableHTTPServerTransport` in stateful mode (one
MCP session per `mcp-session-id`), which also serves the SSE fallback stream
for server→client messages. Hosted traffic keeps the same
`nexus-exchange-mcp/<version>` `User-Agent` as the stdio CLI but appends a
` (http)` comment (`nexus-exchange-mcp/<version> (http)`) so usage attributes
to the hosted MCP in the dashboard while still segmenting under one product and
version.

### Authentication (MVP — no OAuth yet)

> **OAuth 2.1 is out of scope for this MVP** (tracked under the hardening work,
> ENG-3598, and scoped-key minting, ENG-3486). Until that lands, the hosted
> server takes the caller's existing Exchange HMAC credential as request
> headers, captured once at session initialize and reused for the session:
>
> ```text
> X-Nexus-Api-Key:    <hmac key id>
> X-Nexus-Api-Secret: <hmac secret, hex>
> ```
>
> These are deliberately **not** named `x-api-key` / `x-signature` (the
> upstream gateway's own headers) to avoid confusion. With no credential
> headers a session still serves public market-data tools and falls back to any
> server-env credentials. **Open question for review:** header passthrough is
> the simplest defensible MVP, but the long-term answer is OAuth-minted scoped
> (trade-not-withdraw) keys so the caller never hands us a raw secret — see
> ENG-3598 / ENG-3486.

## Development

```bash
npm run format     # prettier --write
npm run lint       # eslint
npm run typecheck  # tsc --noEmit
npm test           # unit tests (HMAC scheme, arg mapping, schemas)
npm run test:coverage # unit tests + coverage (text/lcov/json-summary); CI emits the %
npm run smoke      # live end-to-end check against the gateway
```

## License

Dual-licensed under [MIT](./LICENSE-MIT) or [Apache-2.0](./LICENSE-APACHE), at
your option — same as the other Nexus Exchange SDKs.
