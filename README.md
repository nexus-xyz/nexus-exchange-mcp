# Nexus Exchange MCP Server

An [MCP](https://modelcontextprotocol.io) server that exposes the Nexus
Exchange API as tools an AI agent (Claude Desktop / Claude Code) can call to
read market data and place trades.

It talks to the real, public exchange gateway. Market-data and demo tools work
with zero configuration; account and trading tools use HMAC API credentials
read from environment variables.

## What works today

| Tool | Status | Endpoint |
| --- | --- | --- |
| `list_markets` | Live (public) | `GET /markets/summary` |
| `get_ticker` | Live (public) | `GET /markets/{id}/ticker` |
| `get_orderbook` | Live (public) | `GET /markets/{id}/orderbook` |
| `get_demo_account` | Live (public) | `GET /demo/account` |
| `get_demo_positions` | Live (public) | `GET /demo/positions` |
| `get_demo_orders` | Live (public) | `GET /demo/orders` |
| `get_balance` | Live (needs key + direct gateway) | `GET /account` |
| `get_positions` | Live (needs key + direct gateway) | `GET /positions` |
| `get_open_orders` | Live (needs key + direct gateway) | `GET /orders` |
| `place_order` | Live (needs key + direct gateway) | `POST /orders` |
| `cancel_order` | Live (needs key + direct gateway) | `DELETE /orders[/{id}]` |
| `get_deposit_target` | Honest pending — `ENG-3487` | none yet |
| `register_agent` | Honest pending — `ENG-3486` | none yet |

The two pending tools are wired into the agent flow but return a clear
`not_yet_available` message naming the tracking issue, rather than faking a
result. They light up when the server-side capability ships.

This server is `ENG-3485`, part of epic `ENG-3484`.

## Quick start

```bash
cd eng/apps/exchange/mcp
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

| Variable | Required | Purpose |
| --- | --- | --- |
| `NEXUS_EXCHANGE_API_URL` | No | API base URL. Defaults to `https://exchange.nexus.xyz/api/exchange`. |
| `NEXUS_EXCHANGE_API_KEY` | For account/trade tools | HMAC API key id (`x-api-key`). |
| `NEXUS_EXCHANGE_API_SECRET` | For account/trade tools | HMAC secret (hex). |

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
      "args": ["/ABSOLUTE/PATH/TO/eng/apps/exchange/mcp/dist/index.js"],
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
npm run lint       # tsc --noEmit
npm test           # unit tests (HMAC scheme, arg mapping, schemas)
npm run smoke      # live end-to-end check against the gateway
```
