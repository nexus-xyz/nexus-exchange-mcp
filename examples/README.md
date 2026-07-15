# Examples

Runnable examples for the Nexus Exchange MCP server. They help you understand
the server without wiring it into Claude Desktop or Claude Code — and, once you
do wire it in, show what an agent can build on top of the tools.

Every script spawns the built server over stdio — the same way a real MCP
client launches it — so build first:

```bash
npm install
npm run build
```

All scripts talk to the configured exchange gateway (production by default),
so they need network access. Gateway and credential configuration is read from
the environment by the server itself; see [`.env.example`](../.env.example).

## Catalog

| Example                                                      | Auth tier                | What it shows                                                             |
| ------------------------------------------------------------ | ------------------------ | ------------------------------------------------------------------------- |
| [`claude-desktop/`](./claude-desktop/)                       | Public (creds optional)  | Claude Desktop config JSON + setup walkthrough                            |
| [`claude-code.md`](./claude-code.md)                         | Public (creds optional)  | `claude mcp add` — local stdio and hosted Streamable-HTTP variants        |
| [`list-markets.mjs`](./list-markets.mjs)                     | Public — no credentials  | Minimal MCP client: connect, list tools, call one tool                    |
| [`market-scan.mjs`](./market-scan.mjs)                       | Public — no credentials  | Market-data agent: tickers, order book, funding, risk params, venue stats |
| [`demo-account.mjs`](./demo-account.mjs)                     | Public — no credentials  | The account flow (balance/positions/orders) on the public demo account    |
| [`account-health.mjs`](./account-health.mjs)                 | HMAC key (read-only)     | Portfolio check: summary, equity history, closed positions, rate limits   |
| [`trading-walkthrough.mjs`](./trading-walkthrough.mjs)       | HMAC key (**trades**)    | Place → inspect → amend → cancel a resting limit order, safely            |
| [`ws-streaming.mjs`](./ws-streaming.mjs)                     | HMAC key (token minting) | Mint a WebSocket token and stream live trades over `/ws`                  |
| [`agent-funds-and-trades.mjs`](./agent-funds-and-trades.mjs) | HMAC key (**trades**)    | North star, end to end: fund via faucet → preview → trade → close → PnL   |
| [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md)                 | —                        | Common failures: 404s, auth errors, rate limits, WS token expiry          |

## Auth tiers

- **Public** — works with zero configuration. Point-and-run.
- **HMAC key** — set `NEXUS_EXCHANGE_API_KEY` / `NEXUS_EXCHANGE_API_SECRET`,
  and point `NEXUS_EXCHANGE_API_URL` at a **direct** indexer gateway that
  verifies client HMAC (e.g. a local `http://localhost:9090` from the exchange
  `docker-compose`). The public production host fronts authenticated requests
  with a proxy that signs with the site's own key, so per-caller credentials
  are not honored there — see the top-level README "Authentication" section.
- Examples marked **trades** submit real (testnet) orders with your key.
  They are written to be safe by default — resting far-from-market limit
  orders that are cancelled at the end, or tiny sizes — but read them before
  running.

## `list-markets.mjs`

A minimal standalone MCP client. It spawns the built server over stdio — the
same way a real MCP client launches it — connects, lists the available tools,
and calls `list_markets`, printing the results.

```bash
npm run build
node examples/list-markets.mjs
```

For an in-process check that doesn't spawn a subprocess or require a build, see
`npm run smoke` ([`scripts/smoke.ts`](../scripts/smoke.ts)).
