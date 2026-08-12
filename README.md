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
| `get_account_state`             | ✅ Live (needs key + direct gateway)            | `GET /api/v1/account/state`                |
| `get_account_fees`              | ✅ Live (needs key + direct gateway)            | `GET /api/v1/account/fees`                 |
| `get_portfolio_history`         | ✅ Live (needs key + direct gateway)            | `GET /api/v1/account/portfolio-history`    |
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
the v0.8.1 operations it exposes as tools (see
[API-surface coverage](#api-surface-coverage) below).

- **Base URL is the host root** (`https://exchange.nexus.xyz`), not the
  `…/api/exchange` gateway path. `/api/v1/*` resolves at the root; the
  legacy-only routes append `/api/exchange`. A `NEXUS_EXCHANGE_API_URL` that
  still ends in `/api/exchange` is accepted and normalized. Which host that is
  comes from the [network axis](#networks).
- **Two surfaces, one host — so "the base URL" differs per SDK by design.** The
  configured value here is the host **root**, from which both surfaces are
  derived: `<root>/api/v1` (direct indexer) and `<root>/api/exchange` (legacy
  gateway). A sibling SDK whose single base URL reads `…/api/v1` and one whose
  reads `…/api/exchange` are therefore not in conflict — they name different
  surfaces of the same deployment, and this server holds both at once. If you are
  comparing configs across the SDKs, compare the surface, not the string.
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

**66 registered tools** covering **63 spec operations** of Exchange API spec
**v0.8.1**. Those are two different numbers and neither substitutes for the
other: one tool can call several operations (`cancel_order` calls two) and one
calls none. The operation count is the figure comparable with the rs / py / cli
SDK manifests; the tool count is MCP's own axis and must never be reported as a
coverage figure. [`docs/coverage-unit.md`](./docs/coverage-unit.md) records that
decision and how it is enforced.

63 of the **68** distinct operations, or 63 of the **101** the spec literally
documents — the spec lists most operations twice, once on the legacy gateway
route and once on its `/api/v1` alias, and each aliased pair is one tool.

The operation list is not hand-counted: [`endpoints.txt`](./endpoints.txt) is
generated from the per-tool `ops` declarations in `src/tools/index.ts` and
verified against the pinned spec on every PR by `scripts/check_spec_drift.py`
(see [Spec drift](#spec-drift)).

The pin bump (ENG-6038) was pin-only — it advanced `.api-version` v0.6.2 →
v0.7.1 without mapping the surface those releases had added. ENG-6136 then
exposed those additions as tools, and ENG-6461 advanced the pin to v0.7.2
together with the portfolio-parity surface it added. ENG-9342 then advanced it
to v0.7.3, pin-only again — the surface that release added is the gap ENG-9636
tracks. Below, the spec version each addition shipped in is noted:

- **Portfolio parity** (v0.7.2) — `get_portfolio_history`
  (`GET /api/v1/account/portfolio-history`: equity + PnL + volume series over a
  `day`/`week`/`month`/`all` window), `get_account_state`
  (`GET /api/v1/account/state`: summary + open positions from one coherent
  read), and `get_account_fees` (`GET /api/v1/account/fees`: effective
  maker/taker bps, tier, rolling 30d volume, discounts). The same release
  enriched the `Position` schema — `notional_value`, `margin_used`, `roe`,
  `max_leverage`, and `leverage`, each nullable with a `<field>_error`
  companion, plus the always-present `funding_paid` (no `_error` companion:
  its `"0"` is a real zero, not unknown) — and added
  `withdrawable` to the portfolio summary; those are response-shape additions
  on already-mapped routes, so they change no route count — the tools that
  return them (`get_balance`, `get_positions`, `get_account_state`,
  `get_account_summary`) call them out in their descriptions instead.
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

The remaining 5-operation gap has two distinct causes, and they should not be
read as one number.

**Two are unmapped by design** — the WebSocket **upgrade** endpoints `GET /ws`
and `GET /stream`: a request/response MCP tool cannot hold a streaming socket
open, so the server instead mints the auth token (`get_ws_token` /
`get_ws_token_legacy`) the caller uses to connect to them directly.

**Three are not yet mapped** — the registered-withdrawal-wallet routes v0.7.3
added (ENG-8902): `POST /api/v1/bridge/wallets/challenge`,
`POST /api/v1/bridge/wallets`, and `GET /api/v1/bridge/wallets`. These are
`/api/v1`-native with no legacy alias, so unlike a schema-only addition they
raise the denominator — the v0.7.2 → v0.7.3 pin bump (ENG-9342) moved it from 65
distinct operations to 68 while coverage stayed at 63. This is not blocked —
the indexer serves these routes as of ENG-4624. Tracked as ENG-9636.

The v0.7.2 `cursor` query parameter (ENG-5506) is now exposed on the five
paginated list tools — see "Pagination" below. It adds no route, so the operation
count above is unaffected.

One schema-only addition is **not** exposed, and it does not affect the
operation count. v0.7.3 documents the optional `max_slippage_bps` field on
`place_order`, `place_orders_batch`, and `preview_order` (ENG-7550) — note the
engine has always accepted and enforced it (the fill VWAP is bounded against the
mid captured at submission, and the remainder cancels when the cap would be
crossed); v0.7.3 puts it on the public contract rather than introducing it, so
this is exposure work, not a new capability. Tracked with the bridge-wallet
routes as ENG-9636.

Reconciling the liveness surface: v0.7.0 removed the standalone `/health` and
`/ready` routes from the public contract (only `/status` remains), so the former
`get_health` / `get_readiness` tools — which called routes the pinned spec no
longer documents — were **dropped** in favour of the surviving
`get_service_status` (`/status`).

### Pagination

Five list tools are cursor-paginated (spec v0.7.2, ENG-5506):

| Tool                   | Endpoint                             | `limit` max |
| ---------------------- | ------------------------------------ | ----------- |
| `get_trades`           | `GET /api/v1/markets/{id}/trades`    | 1000        |
| `get_fills`            | `GET /api/v1/fills`                  | 1000        |
| `get_order_history`    | `GET /api/v1/orders/history`         | 500         |
| `get_closed_positions` | `GET /api/v1/positions/closed`       | 200         |
| `get_equity_history`   | `GET /api/v1/account/equity-history` | 720         |

Each returns an **envelope**, not a bare array:

```json
{ "items": [ … ], "next_cursor": "opaque-token" }
```

The agent drives the loop: call once with no `cursor`, then call again with
`cursor: <previous next_cursor>`, and **stop when `next_cursor` is null**. Server
state rides in the `X-Next-Cursor` response header, which the server sends only
while more results exist — its absence is the documented end-of-results signal,
not an error. An empty `items` array with a non-null `next_cursor` is _not_ the
end either: a sparse page still has pages behind it.

`limit` bounds **one page**, not the total, and is validated against that
endpoint's own maximum (table above) before the request, so an out-of-schema
value is never signed or forwarded. The maxima are not interchangeable — in
particular `get_portfolio_history`'s `limit` cap of 366 is that endpoint's alone
and it takes no `cursor` at all.

If the upstream ever returns the _same_ cursor it was given, paging cannot
advance. Handing that token back would put an agent in an unbounded tool-call
loop, so the tool forces `next_cursor` to null and adds a `pagination_error`
saying the results are incomplete — a stop, but explicitly not "end of history".

These parameters were in the spec ahead of the indexer, which may not yet emit
`X-Next-Cursor` (ENG-5506). That degrades safely: with no header every response
is `next_cursor: null`, i.e. exactly the pre-pagination single-page behaviour.

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
Claude rather than run by hand. To verify it works end-to-end against a live
API without a client, use the smoke check:

```bash
NEXUS_EXCHANGE_API_URL=http://localhost:9090 npm run smoke
```

Expected output ends with `list_markets OK -> N markets`.

The smoke check **requires an explicit `NEXUS_EXCHANGE_API_URL`** and has no
default (ENG-8092). It must be a host that serves the `/api/v1` surface — the
public site root (`https://exchange.nexus.xyz`) serves the marketing app there
and answers `/api/v1/markets/summary` with a 404 page of HTML, so a run against
it can only fail. If the target answers with HTML rather than JSON, on a 404 or
on a 200, the check says so by name and exits non-zero; it never reports a
passing run for a body it could not read as market-summary JSON.

## Environment variables

Copy `.env.example` and set as needed. Only trading/account tools need
credentials — never commit real secrets.

| Variable                            | Required                | Purpose                                                                                                                                                                                                                                                      |
| ----------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NEXUS_EXCHANGE_NETWORK`            | No                      | Network to target: `testnet` (default, play funds), `local`, or `mainnet`. See [Networks](#networks). An unrecognized value is an error, never a default.                                                                                                    |
| `NEXUS_EXCHANGE_API_URL`            | No                      | Explicit host-root override (serves `/api/v1`); wins over `NEXUS_EXCHANGE_NETWORK`. Use it for a staging/beta deployment or a private indexer. Defaults to the selected network's host. A legacy value ending in `/api/exchange` is accepted and normalized. |
| `NEXUS_EXCHANGE_API_KEY`            | For account/trade tools | HMAC API key id (`x-api-key`).                                                                                                                                                                                                                               |
| `NEXUS_EXCHANGE_API_SECRET`         | For account/trade tools | HMAC secret (hex).                                                                                                                                                                                                                                           |
| `NEXUS_EXCHANGE_SESSION_TOKEN`      | For `*_api_key` tools   | Bearer session token from `login` (`POST /auth/login`).                                                                                                                                                                                                      |
| `NEXUS_EXCHANGE_ADMIN_SECRET`       | For admin tools         | Operator admin secret (`ADMIN_SECRET`). Only with the flag below.                                                                                                                                                                                            |
| `NEXUS_EXCHANGE_ENABLE_ADMIN_TOOLS` | No                      | Set to `1` to register the admin tier tools. Off by default.                                                                                                                                                                                                 |

## Networks

The target is chosen on a **network** axis — whose money is behind it — not a
release channel. `NEXUS_EXCHANGE_NETWORK` takes `testnet`, `mainnet` or `local`;
the map lives in one place, [`src/networks.ts`](./src/networks.ts), copied from
the spec's `x-nexus-networks` extension.

| Network   | Funds                    | Faucet | Target today                                     |
| --------- | ------------------------ | ------ | ------------------------------------------------ |
| `testnet` | Play (synthetic USDX)    | Yes    | `https://exchange.nexus.xyz` — **the default**   |
| `local`   | Play (whatever you hold) | Yes    | `http://localhost:9090`                          |
| `mainnet` | **Real money**           | No     | No reachable host yet — selecting it is an error |

**Nothing changes if you set nothing.** The default resolves to exactly the host
this server has always used.

**`mainnet` deliberately does not work yet.** Its host `api.nexus.xyz` has no DNS
(ENG-8155) and the pinned spec maps no operation onto its `/v1` base, so any URL
built for it would be a guess — on the one network where a guess moves real
money. It fails with an explanation instead. To target it once it is live, set
`NEXUS_EXCHANGE_API_URL` explicitly.

Three rules this implements, all from the spec extension:

- **Hosts are never interpolated from the network name.** Mainnet is off-pattern
  on purpose — `api.nexus.xyz`, not `api.mainnet.nexus.xyz` — so
  `api.{network}.nexus.xyz` would resolve for every environment that can be
  tested and fail only on real funds. Every host is a named literal.
- **An unrecognized network is treated as real funds.** A typo is an error, never
  a fallback to play money. `local` is likewise never a fallback for a public
  host that fails to resolve — succeeding quietly against localhost would hide a
  misconfigured client.
- **Credentials never cross networks.** Session tokens, HMAC keys and agent
  registrations are minted per network and are invalid on any other. Switching
  network means switching credentials; never carry a signature or a nonce across.

### Release channels are a URL, not a network

`beta` / `staging` are deployments of testnet, not a third pool of money, so they
are no longer enum values. Point `NEXUS_EXCHANGE_API_URL` at them instead — it
overrides the network map and is validated (http(s) only, no embedded
`user:password@`, no query or fragment, since the base is concatenated with a
request path). Plaintext `http` to a non-loopback host warns on stderr: HMAC over
http exposes the key id and signature in transit.

### WebSocket targets

`get_ws_token` and `get_ws_token_legacy` now return `ws_endpoint` alongside the
token, so a caller is no longer handed a 60-second credential with no address to
spend it at. The endpoints derive from the gateway base (`/ws`, `/stream`,
`/ws/token`, `/ws-tokens` carry no per-path `servers` override in the spec):

```
wss://exchange.nexus.xyz/api/exchange/ws      # authenticated, connect with ?token=…
wss://exchange.nexus.xyz/api/exchange/stream  # legacy public market data
```

On `local` the gateway path is absent — `ws://localhost:9090/ws` — because the
indexer serves those routes at its root. That asymmetry is the spec's, not ours:
the root `servers` list carries `/api/exchange` on the public host and the bare
origin for local development, so the prefix is a per-network value
(`gatewayPath` in `src/networks.ts`), never appended unconditionally.

## API version

<!-- api-version-sync:start -->

Currently targets Exchange API spec **`v0.8.1`**.

<!-- api-version-sync:end -->

The pinned version lives in [`.api-version`](./.api-version); the spec itself is
published by
[`nexus-xyz/nexus-exchange-api`](https://github.com/nexus-xyz/nexus-exchange-api).
This repo does not vendor a copy — the checks below fetch the pinned release. The
line above is bot-managed; everything around it is human-owned.

Three separate things watch the pin, and they answer different questions:

| Check           | Question                                                | Where                                 |
| --------------- | ------------------------------------------------------- | ------------------------------------- |
| `spec-drift`    | Does the tool surface still match the spec it **pins**? | `.github/workflows/spec-drift.yml`    |
| `drift` (in CI) | Is the pin **behind** the latest release?               | `.github/workflows/ci.yml`            |
| `spec-autobump` | A newer spec released — is the delta breaking?          | `.github/workflows/spec-autobump.yml` |

`spec-autobump` (daily cron, `repository_dispatch` from the api repo, or manual
dispatch) classifies the pin advance with **oasdiff** and opens a PR touching only
`.api-version` and the managed line above, labelled `spec-autobump` or
`breaking · needs-SDK-update`. It never merges: `allow_auto_merge` is disabled on
this repo, so the workflow probes the setting and says so in the PR body rather
than calling `gh pr merge --auto` and reporting success over a no-op. It
supersedes the old poll-only `api-version-sync` workflow, which had no
classification step.

#### Spec drift

`spec-drift` is the verification half, and it runs on **every** PR — including the
autobump's own, where the pin _is_ the change. It enforces three invariants:

1. every operation in `endpoints.txt` exists in the pinned spec;
2. `endpoints.txt` matches the per-tool `ops` declarations byte-for-byte (it is a
   generated artifact, not a hand-maintained list);
3. each tool's declared `ops` match the operations its handler actually requests.

```bash
npm run spec:drift        # verify against the pinned spec
npm run spec:drift:write  # regenerate endpoints.txt after adding operations
npm run spec:drift:test   # self-test: prove the checker goes red when defeated
```

Adding a tool without declaring what it calls is a type error, so the mapping
cannot be skipped. See [`docs/coverage-unit.md`](./docs/coverage-unit.md).

Every upstream request also sends this pin as an `X-Nexus-Api-Version: <tag>`
header (e.g. `X-Nexus-Api-Version: v0.8.1`), alongside a normalized
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
npm run spec:drift # tool surface vs. the pinned spec (see "Spec drift" above)
```

## License

Dual-licensed under [MIT](./LICENSE-MIT) or [Apache-2.0](./LICENSE-APACHE), at
your option — same as the other Nexus Exchange SDKs.
