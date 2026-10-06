# Claude Desktop setup

**Auth tier: public** (market-data tools) — add HMAC credentials to unlock the
account and trading tools.

[`claude_desktop_config.json`](./claude_desktop_config.json) is a ready-to-edit
config for running this server locally under Claude Desktop over stdio.

## Steps

1. Build the server so `dist/index.js` exists:

   ```bash
   npm install && npm run build
   ```

2. Merge the `mcpServers` block from
   [`claude_desktop_config.json`](./claude_desktop_config.json) into your
   Claude Desktop config, replacing `/ABSOLUTE/PATH/TO/nexus-exchange-mcp`
   with this repo's checkout path:

   - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - Windows: `%APPDATA%\Claude\claude_desktop_config.json`

3. Restart Claude Desktop. `nexus-exchange` appears in the tools list.

4. Try it: ask _"Show me the BTC market on Nexus"_ — Claude calls
   `fetch_markets_summary` / `fetch_ticker` and reports the live BTC-USDX-PERP price.
   Or _"What's in the demo account?"_ — Claude calls `get_demo_account`
   with no credentials at all.

## Enabling trading

Add your HMAC credentials to the `env` block (JSON has no comments, so this is
the full block you'd end up with):

```json
{
  "mcpServers": {
    "nexus-exchange": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/nexus-exchange-mcp/dist/index.js"],
      "env": {
        "NEXUS_EXCHANGE_NETWORK": "testnet",
        "NEXUS_EXCHANGE_API_KEY": "nx_your_key_id",
        "NEXUS_EXCHANGE_API_SECRET": "your_hex_secret"
      }
    }
  }
}
```

Things to know:

- The testnet host verifies your own key, so the block above trades as your
  account. No key yet? Ask Claude to make one: `create_wallet`, `login`,
  `create_api_key` (top-level README, "Full circle on testnet").
- For a local indexer, set `NEXUS_EXCHANGE_NETWORK` to `local` instead. Name the
  network rather than only setting `NEXUS_EXCHANGE_API_URL`: the network declares
  whose money is behind the host, and without it the tools that cannot be undone
  refuse to run (top-level README, "Undeclared funds").
- The key sits in a config file on disk. That is the normal Claude Desktop
  model (same as any other MCP server holding a secret), but use a scoped
  testnet key, not one that controls funds you care about.

Never commit a config containing real credentials.
