# Nexus Exchange MCP Server

An [MCP](https://modelcontextprotocol.io) server that exposes the Nexus
Exchange API as tools an AI agent (Claude Desktop / Claude Code) can call to
read market data and place trades.

It talks to the real, public exchange gateway. Market-data and demo tools work
with zero configuration; account and trading tools use HMAC API credentials
read from environment variables.

## What works today

| Tool                    | Status                                          | Endpoint                          |
| ----------------------- | ----------------------------------------------- | --------------------------------- |
| `list_markets`          | ✅ Live (public)                                | `GET /markets/summary`            |
| `list_market_specs`     | ✅ Live (public)                                | `GET /markets`                    |
| `get_ticker`            | ✅ Live (public)                                | `GET /markets/{id}/ticker`        |
| `get_tickers`           | ✅ Live (public)                                | `GET /tickers`                    |
| `get_orderbook`         | ✅ Live (public)                                | `GET /markets/{id}/orderbook`     |
| `get_mark_price`        | ✅ Live (public)                                | `GET /markets/{id}/mark-price`    |
| `get_market_status`     | ✅ Live (public)                                | `GET /markets/{id}/status`        |
| `get_trades`            | ✅ Live (public)                                | `GET /markets/{id}/trades`        |
| `get_candles`           | ✅ Live (public)                                | `GET /markets/{id}/candles`       |
| `get_funding_history`   | ✅ Live (public)                                | `GET /markets/{id}/funding`       |
| `get_demo_account`      | ✅ Live (public)                                | `GET /demo/account`               |
| `get_demo_positions`    | ✅ Live (public)                                | `GET /demo/positions`             |
| `get_demo_orders`       | ✅ Live (public)                                | `GET /demo/orders`                |
| `get_balance`           | ✅ Live (needs key + direct gateway)            | `GET /account`                    |
| `get_positions`         | ✅ Live (needs key + direct gateway)            | `GET /positions`                  |
| `get_open_orders`       | ✅ Live (needs key + direct gateway)            | `GET /orders`                     |
| `get_order`             | ✅ Live (needs key + direct gateway)            | `GET /orders/{id}`                |
| `get_fills`             | ✅ Live (needs key + direct gateway)            | `GET /fills`                      |
| `get_withdrawals`       | ✅ Live (needs key + direct gateway)            | `GET /withdrawals`                |
| `get_rate_limit_status` | ✅ Live (needs key + direct gateway)            | `GET /account/rate-limit`         |
| `get_adl_history`       | ✅ Live (needs key + direct gateway)            | `GET /account/{addr}/adl-history` |
| `get_market_adl_events` | ✅ Live (needs key + direct gateway)            | `GET /markets/{id}/adl-events`    |
| `place_order`           | ✅ Live (needs key + direct gateway)            | `POST /orders`                    |
| `place_orders_batch`    | ✅ Live (needs key + direct gateway)            | `POST /orders/batch`              |
| `cancel_order`          | ✅ Live (needs key + direct gateway)            | `DELETE /orders[/{id}]`           |
| `deposit_collateral`    | ✅ Live (needs key + direct gateway)            | `POST /account/deposit`           |
| `claim_credit`          | ✅ Live (needs key + direct gateway)            | `POST /account/credit`            |
| `list_agents`           | ✅ Live (needs key + direct gateway)            | `GET /agents`                     |
| `register_agent`        | ✅ Live (needs caller EIP-712 signature)        | `POST /agents/register`           |
| `revoke_agent`          | ✅ Live (needs key + direct gateway)            | `DELETE /agents/{addr}`           |
| `login`                 | ✅ Live (needs caller EIP-191 signature)        | `POST /auth/login`                |
| `list_api_keys`         | ✅ Live (needs session token)                   | `GET /keys`                       |
| `create_api_key`        | ✅ Live (needs session token)                   | `POST /keys`                      |
| `delete_api_key`        | ✅ Live (needs session token)                   | `DELETE /keys/{key_id}`           |
| `get_ws_token`          | ✅ Live (needs key + direct gateway)            | `POST /ws/token`                  |
| `get_ws_token_legacy`   | ✅ Live (needs key + direct gateway)            | `POST /ws-tokens`                 |
| `get_health`            | ✅ Live (public)                                | `GET /health`                     |
| `list_tiers`            | 🔒 Admin (opt-in, see below)                    | `GET /admin/tiers`                |
| `set_tier`              | 🔒 Admin (opt-in, see below)                    | `PUT /admin/tiers`                |
| `delete_tier`           | 🔒 Admin (opt-in, see below)                    | `DELETE /admin/tiers/{addr}`      |
| `get_deposit_target`    | 🚧 Pending — server-side endpoint not built yet | none yet                          |

`get_deposit_target` is wired into the agent flow but returns a clear
`not_yet_available` message rather than faking a result; it lights up when the
server-side capability ships.

### API-surface coverage

These tools map to **38 of the 40** operations in the v0.4.0 OpenAPI spec
(`.api-version`). The two intentionally unmapped operations are the WebSocket
**upgrade** endpoints `GET /ws` and `GET /stream` — a request/response MCP tool
cannot hold a streaming socket open, so the server instead mints the auth token
(`get_ws_token` / `get_ws_token_legacy`) the caller uses to connect to them
directly.

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

| Variable                            | Required                | Purpose                                                              |
| ----------------------------------- | ----------------------- | -------------------------------------------------------------------- |
| `NEXUS_EXCHANGE_API_URL`            | No                      | API base URL. Defaults to `https://exchange.nexus.xyz/api/exchange`. |
| `NEXUS_EXCHANGE_API_KEY`            | For account/trade tools | HMAC API key id (`x-api-key`).                                       |
| `NEXUS_EXCHANGE_API_SECRET`         | For account/trade tools | HMAC secret (hex).                                                   |
| `NEXUS_EXCHANGE_SESSION_TOKEN`      | For `*_api_key` tools   | Bearer session token from `login` (`POST /auth/login`).              |
| `NEXUS_EXCHANGE_ADMIN_SECRET`       | For admin tools         | Operator admin secret (`ADMIN_SECRET`). Only with the flag below.    |
| `NEXUS_EXCHANGE_ENABLE_ADMIN_TOOLS` | No                      | Set to `1` to register the admin tier tools. Off by default.         |

## Authentication

Signed requests use the same canonical HMAC-SHA256 scheme the indexer verifies
(`backend/services/indexer/src/auth.rs`):

```text
<timestamp>\n<METHOD>\n<path>\n<query>\n<sha256hex(body)>
```

signed with the hex-decoded secret and sent as `x-signature` alongside
`x-api-key` and `x-timestamp`.

Important: the default public base URL (`/api/exchange`) is a proxy that signs
with the site's own frontend key, so it does not honor per-caller HMAC headers —
authenticated tools through it resolve to the site account, not yours. To trade
as a specific account, point `NEXUS_EXCHANGE_API_URL` at a direct indexer
gateway that verifies client HMAC (for example a local `http://localhost:9090`
from the exchange `docker-compose`). Until then, use the public `get_demo_*`
tools to demo the account flow with no secrets.

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
        "NEXUS_EXCHANGE_API_URL": "https://exchange.nexus.xyz/api/exchange"
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

## Productionization path

stdio is used here because it is the simplest transport to demo. The
production target is a hosted Streamable HTTP MCP server with OAuth, so each
agent authenticates per-user instead of sharing one API key from env.

## Development

```bash
npm run format     # prettier --write
npm run lint       # eslint
npm run typecheck  # tsc --noEmit
npm test           # unit tests (HMAC scheme, arg mapping, schemas)
npm run smoke      # live end-to-end check against the gateway
```
