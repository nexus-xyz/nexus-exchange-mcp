# Claude Code setup (`claude mcp add`)

**Auth tier: public** (market-data tools) — add HMAC credentials to unlock the
account and trading tools.

Two ways to give Claude Code the Nexus Exchange tools: run the server locally
over **stdio**, or point at the **hosted Streamable HTTP** endpoint and run
nothing locally.

## Variant A — local stdio server

Build once, then register the built entry point:

```bash
npm install && npm run build

claude mcp add nexus-exchange \
  --env NEXUS_EXCHANGE_API_URL=https://exchange.nexus.xyz \
  -- node /ABSOLUTE/PATH/TO/nexus-exchange-mcp/dist/index.js
```

To enable the account/trading tools, pass credentials the same way (and point
at a direct HMAC-verifying gateway — see "Authentication" in the top-level
README; the public host's proxy does not honor per-caller HMAC):

```bash
claude mcp add nexus-exchange \
  --env NEXUS_EXCHANGE_NETWORK=local \
  --env NEXUS_EXCHANGE_API_URL=http://localhost:9090 \
  --env NEXUS_EXCHANGE_API_KEY=nx_your_key_id \
  --env NEXUS_EXCHANGE_API_SECRET=your_hex_secret \
  -- node /ABSOLUTE/PATH/TO/nexus-exchange-mcp/dist/index.js
```

`NEXUS_EXCHANGE_NETWORK` is what makes the fund-moving tools available: a URL on
its own does not say whose money is behind it, so those tools refuse rather than
assume play funds. Naming `local` also tells the server this host serves the
legacy routes at its root instead of under `/api/exchange`. For a stage that is
not one of the named networks, describe it with the `custom` bundle (top-level
README, "A custom stage").

The key stays on your machine: the server signs requests locally and only the
HMAC signature leaves the process.

## Variant B — hosted Streamable HTTP (no local process)

The hosted front door serves the identical tool surface (both transports
register the same `ToolDef[]` — see the top-level README, "Hosted HTTP
server"):

```bash
claude mcp add --transport http nexus https://mcp.exchange.nexus.xyz/mcp
```

Public market-data tools work immediately. For authenticated tools the hosted
server takes your existing HMAC credential as request headers, captured once
at session initialize (OAuth-minted scoped keys are the planned replacement —
ENG-3598 / ENG-3486):

```bash
claude mcp add --transport http nexus https://mcp.exchange.nexus.xyz/mcp \
  --header "X-Nexus-Api-Key: nx_your_key_id" \
  --header "X-Nexus-Api-Secret: your_hex_secret"
```

Note the trade-off: variant B hands the raw secret to the hosted server for
the session. Use a scoped testnet key, and prefer variant A when you want the
secret to never leave your machine.

## Verify

```bash
claude mcp list          # shows nexus-exchange / nexus as connected
```

Then in a Claude Code session: _"Using the Nexus tools, what's the BTC-USDX-PERP
mark price?"_ — Claude should call `get_mark_price`.
