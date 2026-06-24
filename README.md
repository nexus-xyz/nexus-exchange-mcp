# Nexus Exchange MCP Server

[![License](https://img.shields.io/badge/license-MIT%2FApache--2.0-blue.svg)](#license)

An [MCP](https://modelcontextprotocol.io) server that exposes the Nexus
Exchange API as tools an AI agent (Claude Desktop / Claude Code) can call to
read market data and place trades.

It talks to the real, public exchange gateway. Market-data and demo tools work
with zero configuration; account and trading tools use HMAC API credentials
read from environment variables.

## What works today

| Tool                    | Status                                            | Endpoint                          |
| ----------------------- | ------------------------------------------------- | --------------------------------- |
| `list_markets`          | ✅ Live (public)                                  | `GET /markets/summary`            |
| `list_market_specs`     | ✅ Live (public)                                  | `GET /markets`                    |
| `get_ticker`            | ✅ Live (public)                                  | `GET /markets/{id}/ticker`        |
| `get_tickers`           | ✅ Live (public)                                  | `GET /tickers`                    |
| `get_orderbook`         | ✅ Live (public)                                  | `GET /markets/{id}/orderbook`     |
| `get_mark_price`        | ✅ Live (public)                                  | `GET /markets/{id}/mark-price`    |
| `get_market_status`     | ✅ Live (public)                                  | `GET /markets/{id}/status`        |
| `get_trades`            | ✅ Live (public)                                  | `GET /markets/{id}/trades`        |
| `get_candles`           | ✅ Live (public)                                  | `GET /markets/{id}/candles`       |
| `get_funding_history`   | ✅ Live (public)                                  | `GET /markets/{id}/funding`       |
| `get_demo_account`      | ✅ Live (public)                                  | `GET /demo/account`               |
| `get_demo_positions`    | ✅ Live (public)                                  | `GET /demo/positions`             |
| `get_demo_orders`       | ✅ Live (public)                                  | `GET /demo/orders`                |
| `get_balance`           | ✅ Live (needs key + direct gateway)              | `GET /account`                    |
| `get_positions`         | ✅ Live (needs key + direct gateway)              | `GET /positions`                  |
| `get_open_orders`       | ✅ Live (needs key + direct gateway)              | `GET /orders`                     |
| `get_order`             | ✅ Live (needs key + direct gateway)              | `GET /orders/{id}`                |
| `get_fills`             | ✅ Live (needs key + direct gateway)              | `GET /fills`                      |
| `get_withdrawals`       | ✅ Live (needs key + direct gateway)              | `GET /withdrawals`                |
| `get_rate_limit_status` | ✅ Live (needs key + direct gateway)              | `GET /account/rate-limit`         |
| `get_adl_history`       | ✅ Live (needs key + direct gateway)              | `GET /account/{addr}/adl-history` |
| `get_ws_token`          | ✅ Live (needs key + direct gateway)              | `POST /ws-tokens`                 |
| `place_order`           | ✅ Live (needs key + direct gateway)              | `POST /orders`                    |
| `place_orders_batch`    | ✅ Live (needs key + direct gateway)              | `POST /orders/batch`              |
| `cancel_order`          | ✅ Live (needs key + direct gateway)              | `DELETE /orders[/{id}]`           |
| `get_deposit_target`    | 🚧 Pending — server-side endpoint not built yet   | none yet                          |
| `register_agent`        | 🚧 Pending — server-side capability not built yet | none yet                          |

The two pending tools are wired into the agent flow but return a clear
`not_yet_available` message rather than faking a result. They light up when the
server-side capability ships.

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

| Variable                    | Required                | Purpose                                                              |
| --------------------------- | ----------------------- | -------------------------------------------------------------------- |
| `NEXUS_EXCHANGE_API_URL`    | No                      | API base URL. Defaults to `https://exchange.nexus.xyz/api/exchange`. |
| `NEXUS_EXCHANGE_API_KEY`    | For account/trade tools | HMAC API key id (`x-api-key`).                                       |
| `NEXUS_EXCHANGE_API_SECRET` | For account/trade tools | HMAC secret (hex).                                                   |

## API version

<!-- api-version-sync:start -->

Currently targets Exchange API spec **`v0.4.0`**.

<!-- api-version-sync:end -->

The pinned version lives in [`.api-version`](./.api-version); the spec itself is
published by
[`nexus-xyz/nexus-exchange-api`](https://github.com/nexus-xyz/nexus-exchange-api).
This repo does not vendor a copy — the `drift` CI job fetches the pinned release
to check for drift, and the scheduled `api-version-sync` workflow opens a PR when
a newer spec releases. The line above is bot-managed; everything around it is
human-owned.

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

## License

Dual-licensed under [MIT](./LICENSE-MIT) or [Apache-2.0](./LICENSE-APACHE), at
your option — same as the other Nexus Exchange SDKs.
