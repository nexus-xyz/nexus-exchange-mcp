# Nexus Exchange MCP Server

An [MCP](https://modelcontextprotocol.io) server that exposes the Nexus
Exchange API as tools an AI agent (Claude Desktop / Claude Code) can call to
read market data and place trades.

It talks to the real, public exchange. Market-data and demo tools work with
zero configuration; account and trading tools use HMAC API credentials read
from environment variables.

## What works today

Most tools now hit the direct-indexer **`/api/v1`** surface (served at the host
root). The routes that were **not** migrated to `/api/v1` stay on the **legacy
`/api/exchange`** gateway, which remains live dual-stack (ENG-4751), so nothing
breaks.

| Tool                    | Status                                            | Endpoint (surface)                         |
| ----------------------- | ------------------------------------------------- | ------------------------------------------ |
| `list_markets`          | ✅ Live (public)                                  | `GET /api/v1/markets/summary`              |
| `list_market_specs`     | ✅ Live (public)                                  | `GET /markets` (legacy — no v1 route)      |
| `get_ticker`            | ✅ Live (public)                                  | `GET /api/v1/markets/{id}/ticker`          |
| `get_tickers`           | ✅ Live (public)                                  | `GET /api/v1/tickers`                      |
| `get_orderbook`         | ✅ Live (public)                                  | `GET /api/v1/markets/{id}/orderbook`       |
| `get_mark_price`        | ✅ Live (public)                                  | `GET /api/v1/markets/{id}/mark-price`      |
| `get_market_status`     | ✅ Live (public)                                  | `GET /api/v1/markets/{id}/status`          |
| `get_trades`            | ✅ Live (public)                                  | `GET /api/v1/markets/{id}/trades`          |
| `get_candles`           | ✅ Live (public)                                  | `GET /api/v1/markets/{id}/candles`         |
| `get_funding_history`   | ✅ Live (public)                                  | `GET /api/v1/markets/{id}/funding`         |
| `get_demo_account`      | ✅ Live (public)                                  | `GET /demo/account` (legacy — no v1)       |
| `get_demo_positions`    | ✅ Live (public)                                  | `GET /demo/positions` (legacy — no v1)     |
| `get_demo_orders`       | ✅ Live (public)                                  | `GET /demo/orders` (legacy — no v1)        |
| `get_balance`           | ✅ Live (needs key + direct gateway)              | `GET /api/v1/account`                      |
| `get_positions`         | ✅ Live (needs key + direct gateway)              | `GET /api/v1/positions`                    |
| `get_open_orders`       | ✅ Live (needs key + direct gateway)              | `GET /api/v1/orders`                       |
| `get_order`             | ✅ Live (needs key + direct gateway)              | `GET /orders/{id}` (legacy — no v1)        |
| `get_fills`             | ✅ Live (needs key + direct gateway)              | `GET /api/v1/fills`                        |
| `get_withdrawals`       | ✅ Live (needs key + direct gateway)              | `GET /withdrawals` (legacy — no v1)        |
| `get_rate_limit_status` | ✅ Live (needs key + direct gateway)              | `GET /api/v1/account/rate-limit`           |
| `get_adl_history`       | ✅ Live (needs key + direct gateway)              | `GET /account/{addr}/adl-history` (legacy) |
| `get_ws_token`          | ✅ Live (needs key + direct gateway)              | `POST /ws-tokens` (legacy — no v1)         |
| `place_order`           | ✅ Live (needs key + direct gateway)              | `POST /api/v1/orders`                      |
| `place_orders_batch`    | ✅ Live (needs key + direct gateway)              | `POST /api/v1/orders/batch`                |
| `cancel_order`          | ✅ Live (needs key + direct gateway)              | `DELETE /api/v1/orders[/{id}]`             |
| `get_deposit_target`    | 🚧 Pending — server-side endpoint not built yet   | none yet                                   |
| `register_agent`        | 🚧 Pending — server-side capability not built yet | none yet                                   |

The two pending tools are wired into the agent flow but return a clear
`not_yet_available` message rather than faking a result. They light up when the
server-side capability ships.

## Migration to `/api/v1`

Per **ENG-4740** the gateway REST proxy is being eliminated: each backend
service exposes its own REST API, and the indexer now serves the exchange
surface directly under `/api/v1` at the host root. This server was updated
(**ENG-4948**) to call those routes.

- **Base URL is now the host root** (`https://exchange.nexus.xyz`), not the
  `…/api/exchange` gateway path. `/api/v1/*` resolves at the root; the few
  legacy-only routes append `/api/exchange`. A legacy `NEXUS_EXCHANGE_API_URL`
  that still ends in `/api/exchange` is accepted and normalized.
- **HMAC signs the full path** the server verifies — e.g. `/api/v1/orders` for
  v1 routes, the bare route (e.g. `/orders`) for legacy ones.
- **`cancel_order` now requires `market_id`** when cancelling a single order
  (v1 marks it required); `market_id` is optional with `cancel_all` to scope a
  mass-cancel to one market.
- **Not migrated (stay legacy):** `list_market_specs`, `get_order` (v1 mounts
  only edit/cancel on `/orders/{id}`), `get_withdrawals`, `get_adl_history`,
  `get_ws_token`, and the `demo/*` reads — these have no `/api/v1` route and
  still hit the dual-stack gateway.

The spec pin (`.api-version`) tracks the Exchange API release the server targets
(`v0.6.2`); CI enforces that it matches the latest published release.

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

| Variable                    | Required                | Purpose                                                                 |
| --------------------------- | ----------------------- | ----------------------------------------------------------------------- |
| `NEXUS_EXCHANGE_API_URL`    | No                      | API base URL — the host root. Defaults to `https://exchange.nexus.xyz`. |
| `NEXUS_EXCHANGE_API_KEY`    | For account/trade tools | HMAC API key id (`x-api-key`).                                          |
| `NEXUS_EXCHANGE_API_SECRET` | For account/trade tools | HMAC secret (hex).                                                      |

## Authentication

Signed requests use the same canonical HMAC-SHA256 scheme the indexer verifies
(`backend/services/indexer/src/auth.rs`):

```text
<timestamp>\n<METHOD>\n<path>\n<query>\n<sha256hex(body)>
```

signed with the hex-decoded secret and sent as `x-signature` alongside
`x-api-key` and `x-timestamp`. The signature covers the **full path** the
server verifies — `/api/v1/orders` for the direct v1 surface, the bare route
(e.g. `/orders`) for legacy routes.

Important: the legacy `/api/exchange` gateway is a proxy that signs with the
site's own frontend key, so it does not honor per-caller HMAC headers —
authenticated tools that still resolve through it (see the legacy rows in the
table) act as the site account, not yours. The direct `/api/v1` surface
verifies client HMAC. To trade as a specific account, point
`NEXUS_EXCHANGE_API_URL` at a direct indexer gateway (for example a local
`http://localhost:9090` from the exchange `docker-compose`). Until credentials
are wired up, use the public `get_demo_*` tools to demo the account flow with
no secrets.

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
