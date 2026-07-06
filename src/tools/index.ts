/**
 * Tool definitions for the Nexus Exchange MCP server.
 *
 * Each tool maps to a real indexer gateway endpoint. Two tools
 * (`register_agent`, `get_deposit_target`) describe capabilities that are not
 * yet built server-side; they return an honest "pending" message that names
 * the tracking Linear issue rather than faking a result.
 */

import { z } from "zod";
import { ExchangeClient } from "../client.js";

export interface ToolDef {
  name: string;
  description: string;
  /** Raw JSON Schema (draft-07-ish) advertised over `tools/list`. */
  inputSchema: Record<string, unknown>;
  /** Zod schema used to validate/parse arguments before the handler runs. */
  zod: z.ZodType;
  /** Whether the tool needs API credentials. Informational for docs/listing. */
  requiresAuth: boolean;
  handler: (client: ExchangeClient, args: unknown) => Promise<unknown>;
}

function jsonSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
) {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

/**
 * Maximum number of orders accepted in a single `place_orders_batch` call.
 * The gateway does not document a batch cap in this repo, so this is a
 * defensive client-side bound to prevent accidental flood submissions
 * (e.g. an agent looping). 100 is a generous ceiling for interactive use;
 * raise it to match the API's documented limit once that is published.
 */
const MAX_BATCH_ORDERS = 100;

/**
 * Positive-decimal string: one or more digits, optional fractional part, and
 * strictly greater than zero. Rejects `"0"`, `"0.0"`, negatives, and anything
 * non-numeric. Used for order `size`/`price`, which are carried as strings to
 * preserve precision.
 */
const positiveDecimal = (field: string) =>
  z
    .string()
    .regex(/^\d+(\.\d+)?$/, `${field} must be a positive decimal string`)
    .refine((v) => Number(v) > 0, {
      message: `${field} must be greater than 0`,
    });

/** Friendly order args accepted by `place_order` / `place_orders_batch`. */
interface FriendlyOrder {
  market_id: string;
  side: "buy" | "sell";
  type: "limit" | "market";
  size: string;
  price?: string;
  time_in_force?: "GTC" | "IOC" | "FOK";
  reduce_only?: boolean;
}

/** Zod schema for one friendly order (shared by single + batch tools). */
const friendlyOrderSchema = z
  .object({
    market_id: z.string().min(1),
    side: z.enum(["buy", "sell"]),
    type: z.enum(["limit", "market"]),
    size: positiveDecimal("size"),
    price: positiveDecimal("price").optional(),
    time_in_force: z.enum(["GTC", "IOC", "FOK"]).optional(),
    reduce_only: z.boolean().optional(),
  })
  .strict()
  .refine((v) => v.type !== "limit" || v.price !== undefined, {
    message: "price is required for limit orders",
    path: ["price"],
  });

/** JSON Schema properties for one friendly order (shared by single + batch). */
const orderProps: Record<string, unknown> = {
  market_id: {
    type: "string",
    description: 'Market id, e.g. "BTC-USDX-PERP".',
  },
  side: { type: "string", enum: ["buy", "sell"], description: "Order side." },
  type: {
    type: "string",
    enum: ["limit", "market"],
    description: "Order type.",
  },
  size: {
    type: "string",
    description:
      "Order quantity in base units, as a positive decimal string (> 0).",
  },
  price: {
    type: "string",
    description:
      "Limit price as a positive decimal string (> 0). Required for limit " +
      "orders, ignored for market.",
  },
  time_in_force: {
    type: "string",
    enum: ["GTC", "IOC", "FOK"],
    description: "Time in force. Defaults to GTC for limit, IOC for market.",
  },
  reduce_only: {
    type: "boolean",
    description: "If true, only reduces an existing position.",
  },
};

/**
 * Map one friendly order to the engine wire shape (bots/src/client.rs
 * OrderRequest): capitalized side, order_type, quantity, optional price,
 * time_in_force.
 */
function toWireOrder(a: FriendlyOrder): Record<string, unknown> {
  const body: Record<string, unknown> = {
    market_id: a.market_id,
    side: a.side === "buy" ? "Buy" : "Sell",
    order_type: a.type === "limit" ? "Limit" : "Market",
    quantity: a.size,
    time_in_force: a.time_in_force ?? (a.type === "limit" ? "GTC" : "IOC"),
  };
  if (a.type === "limit") body.price = a.price;
  if (a.reduce_only) body.reduce_only = true;
  return body;
}

const PENDING = (capability: string) => ({
  status: "not_yet_available",
  capability,
  message:
    `${capability} is not yet available server-side. This MCP tool is wired up ` +
    `so the agent flow is complete, but the endpoint is pending.`,
});

export const tools: ToolDef[] = [
  // ── Public market data (no credentials) ──────────────────────────────────
  {
    name: "list_markets",
    description:
      "List all tradable markets with their current summary (mark price, 24h " +
      "change, volume, open interest, funding). Public — no credentials needed.",
    inputSchema: jsonSchema({}),
    zod: z.object({}).strict(),
    requiresAuth: false,
    handler: (client) => client.request({ path: "/api/v1/markets/summary" }),
  },
  {
    name: "get_ticker",
    description:
      "Get the ticker (last price, bid/ask, 24h stats) for one market, e.g. " +
      '"BTC-USDX-PERP". Public — no credentials needed.',
    inputSchema: jsonSchema(
      {
        market_id: {
          type: "string",
          description: 'Market id, e.g. "BTC-USDX-PERP".',
        },
      },
      ["market_id"],
    ),
    zod: z.object({ market_id: z.string().min(1) }).strict(),
    requiresAuth: false,
    handler: (client, args) => {
      const { market_id } = args as { market_id: string };
      return client.request({
        path: `/api/v1/markets/${encodeURIComponent(market_id)}/ticker`,
      });
    },
  },
  {
    name: "get_orderbook",
    description:
      "Get the current order book (bids/asks with price + size) for one market. " +
      "Public — no credentials needed.",
    inputSchema: jsonSchema(
      {
        market_id: {
          type: "string",
          description: 'Market id, e.g. "BTC-USDX-PERP".',
        },
      },
      ["market_id"],
    ),
    zod: z.object({ market_id: z.string().min(1) }).strict(),
    requiresAuth: false,
    handler: (client, args) => {
      const { market_id } = args as { market_id: string };
      return client.request({
        path: `/api/v1/markets/${encodeURIComponent(market_id)}/orderbook`,
      });
    },
  },

  {
    name: "list_market_specs",
    description:
      "List all markets with their static specs (tick size, lot size, leverage, " +
      "contract details) — the raw market definitions without live summary " +
      "stats. Public — no credentials needed. (Use `list_markets` for live " +
      "mark price / volume / funding.)",
    inputSchema: jsonSchema({}),
    zod: z.object({}).strict(),
    requiresAuth: false,
    // No /api/v1 equivalent (nexus-exchange-api#41 migrated /markets/summary
    // but not the bare /markets spec list); served by the legacy gateway.
    handler: (client) =>
      client.request({ path: "/markets", surface: "gateway" }),
  },
  {
    name: "get_tickers",
    description:
      "Get tickers (last price, bid/ask, 24h stats) for ALL markets in one " +
      "call. Public — no credentials needed.",
    inputSchema: jsonSchema({}),
    zod: z.object({}).strict(),
    requiresAuth: false,
    handler: (client) => client.request({ path: "/api/v1/tickers" }),
  },
  {
    name: "get_mark_price",
    description:
      "Get the current mark price for one market. Public — no credentials needed.",
    inputSchema: jsonSchema(
      {
        market_id: {
          type: "string",
          description: 'Market id, e.g. "BTC-USDX-PERP".',
        },
      },
      ["market_id"],
    ),
    zod: z.object({ market_id: z.string().min(1) }).strict(),
    requiresAuth: false,
    handler: (client, args) => {
      const { market_id } = args as { market_id: string };
      return client.request({
        path: `/api/v1/markets/${encodeURIComponent(market_id)}/mark-price`,
      });
    },
  },
  {
    name: "get_market_status",
    description:
      "Get a market's trading status and halt info (whether trading is open, " +
      "halted, or in auction). Public — no credentials needed.",
    inputSchema: jsonSchema(
      {
        market_id: {
          type: "string",
          description: 'Market id, e.g. "BTC-USDX-PERP".',
        },
      },
      ["market_id"],
    ),
    zod: z.object({ market_id: z.string().min(1) }).strict(),
    requiresAuth: false,
    handler: (client, args) => {
      const { market_id } = args as { market_id: string };
      return client.request({
        path: `/api/v1/markets/${encodeURIComponent(market_id)}/status`,
      });
    },
  },
  {
    name: "get_trades",
    description:
      "Get recent public trades (prints) for one market. Public — no " +
      "credentials needed.",
    inputSchema: jsonSchema(
      {
        market_id: {
          type: "string",
          description: 'Market id, e.g. "BTC-USDX-PERP".',
        },
        limit: {
          type: "integer",
          description: "Maximum number of trades to return.",
        },
      },
      ["market_id"],
    ),
    zod: z
      .object({
        market_id: z.string().min(1),
        limit: z.number().int().positive().optional(),
      })
      .strict(),
    requiresAuth: false,
    handler: (client, args) => {
      const a = args as { market_id: string; limit?: number };
      const query =
        a.limit !== undefined ? `limit=${encodeURIComponent(a.limit)}` : "";
      return client.request({
        path: `/api/v1/markets/${encodeURIComponent(a.market_id)}/trades`,
        query,
      });
    },
  },
  {
    name: "get_candles",
    description:
      "Get OHLCV candles for one market. Public — no credentials needed. " +
      "Timeframe is one of 1s, 1m, 5m, 1h (default 1m).",
    inputSchema: jsonSchema(
      {
        market_id: {
          type: "string",
          description: 'Market id, e.g. "BTC-USDX-PERP".',
        },
        timeframe: {
          type: "string",
          enum: ["1s", "1m", "5m", "1h"],
          description: "Candle interval. Defaults to 1m.",
        },
        limit: {
          type: "integer",
          description: "Maximum number of candles to return (max 1000).",
        },
      },
      ["market_id"],
    ),
    zod: z
      .object({
        market_id: z.string().min(1),
        timeframe: z.enum(["1s", "1m", "5m", "1h"]).optional(),
        limit: z.number().int().positive().max(1000).optional(),
      })
      .strict(),
    requiresAuth: false,
    handler: (client, args) => {
      const a = args as {
        market_id: string;
        timeframe?: string;
        limit?: number;
      };
      const params = new URLSearchParams();
      if (a.timeframe) params.set("timeframe", a.timeframe);
      if (a.limit !== undefined) params.set("limit", String(a.limit));
      return client.request({
        path: `/api/v1/markets/${encodeURIComponent(a.market_id)}/candles`,
        query: params.toString(),
      });
    },
  },
  {
    name: "get_funding_history",
    description:
      "Get the funding-rate history for one perpetual market. Public — no " +
      "credentials needed.",
    inputSchema: jsonSchema(
      {
        market_id: {
          type: "string",
          description: 'Market id, e.g. "BTC-USDX-PERP".',
        },
        limit: {
          type: "integer",
          description: "Maximum number of funding records to return.",
        },
      },
      ["market_id"],
    ),
    zod: z
      .object({
        market_id: z.string().min(1),
        limit: z.number().int().positive().optional(),
      })
      .strict(),
    requiresAuth: false,
    handler: (client, args) => {
      const a = args as { market_id: string; limit?: number };
      const query =
        a.limit !== undefined ? `limit=${encodeURIComponent(a.limit)}` : "";
      return client.request({
        path: `/api/v1/markets/${encodeURIComponent(a.market_id)}/funding`,
        query,
      });
    },
  },

  // ── Public demo account (no credentials) ──────────────────────────────────
  // The indexer exposes a read-only demo namespace bound to a live bot
  // account (api.ts: indexer.demoAccount/demoPositions/demoOrders). Lets the
  // demo show real balances/positions/orders with zero secrets.
  // No /api/v1 equivalent (the demo namespace was not migrated in
  // nexus-exchange-api#41); served by the legacy gateway.
  {
    name: "get_demo_account",
    description:
      "Get a live, public demo account snapshot (balance, equity, positions). " +
      "No credentials needed — useful to show the account flow before API keys " +
      "are wired up.",
    inputSchema: jsonSchema({}),
    zod: z.object({}).strict(),
    requiresAuth: false,
    handler: (client) =>
      client.request({ path: "/demo/account", surface: "gateway" }),
  },
  {
    name: "get_demo_positions",
    description:
      "Get the public demo account's open positions. No credentials needed.",
    inputSchema: jsonSchema({}),
    zod: z.object({}).strict(),
    requiresAuth: false,
    handler: (client) =>
      client.request({ path: "/demo/positions", surface: "gateway" }),
  },
  {
    name: "get_demo_orders",
    description:
      "Get the public demo account's open orders. No credentials needed.",
    inputSchema: jsonSchema({}),
    zod: z.object({}).strict(),
    requiresAuth: false,
    handler: (client) =>
      client.request({ path: "/demo/orders", surface: "gateway" }),
  },

  // ── Account reads (require credentials) ───────────────────────────────────
  {
    name: "get_balance",
    description:
      "Get the authenticated account snapshot: collateral balance, equity, and " +
      "positions. Requires API credentials.",
    inputSchema: jsonSchema({}),
    zod: z.object({}).strict(),
    requiresAuth: true,
    handler: (client) =>
      client.request({ path: "/api/v1/account", signed: true }),
  },
  {
    name: "get_positions",
    description:
      "Get the authenticated account's open positions. Requires API credentials.",
    inputSchema: jsonSchema({}),
    zod: z.object({}).strict(),
    requiresAuth: true,
    handler: (client) =>
      client.request({ path: "/api/v1/positions", signed: true }),
  },
  {
    name: "get_open_orders",
    description:
      "Get the authenticated account's resting (open) orders. Requires API credentials.",
    inputSchema: jsonSchema({}),
    zod: z.object({}).strict(),
    requiresAuth: true,
    handler: (client) =>
      client.request({ path: "/api/v1/orders", signed: true }),
  },
  {
    name: "get_order",
    description:
      "Get a single order by its id (status, fills, remaining size). Requires " +
      "API credentials. Note: GET-by-id is not on /api/v1 yet (only edit/" +
      "cancel are) — use `get_open_orders` for resting orders.",
    inputSchema: jsonSchema(
      {
        order_id: {
          type: "string",
          description: "Order id to look up.",
        },
      },
      ["order_id"],
    ),
    zod: z.object({ order_id: z.string().min(1) }).strict(),
    requiresAuth: true,
    // No /api/v1 equivalent: nexus-exchange-api#41 mounts only PATCH + DELETE
    // on /api/v1/orders/{order_id}; GET-by-id stays on the legacy gateway.
    handler: (client, args) => {
      const { order_id } = args as { order_id: string };
      return client.request({
        path: `/orders/${encodeURIComponent(order_id)}`,
        signed: true,
        surface: "gateway",
      });
    },
  },
  {
    name: "get_fills",
    description:
      "List the authenticated account's recent fills (executed trades). " +
      "Requires API credentials.",
    inputSchema: jsonSchema({
      limit: {
        type: "integer",
        description: "Maximum number of fills to return.",
      },
    }),
    zod: z.object({ limit: z.number().int().positive().optional() }).strict(),
    requiresAuth: true,
    handler: (client, args) => {
      const a = args as { limit?: number };
      const query =
        a.limit !== undefined ? `limit=${encodeURIComponent(a.limit)}` : "";
      return client.request({ path: "/api/v1/fills", query, signed: true });
    },
  },
  {
    name: "get_withdrawals",
    description:
      "List the authenticated account's withdrawal history. Requires API " +
      "credentials.",
    inputSchema: jsonSchema({
      limit: {
        type: "integer",
        description: "Maximum number of records to return.",
      },
    }),
    zod: z.object({ limit: z.number().int().positive().optional() }).strict(),
    requiresAuth: true,
    // No /api/v1 equivalent (not in nexus-exchange-api#41); legacy gateway.
    handler: (client, args) => {
      const a = args as { limit?: number };
      const query =
        a.limit !== undefined ? `limit=${encodeURIComponent(a.limit)}` : "";
      return client.request({
        path: "/withdrawals",
        query,
        signed: true,
        surface: "gateway",
      });
    },
  },
  {
    name: "get_rate_limit_status",
    description:
      "Get the authenticated account's current rate-limit status (remaining " +
      "request budget). Useful for an agent to pace itself. Requires API " +
      "credentials.",
    inputSchema: jsonSchema({}),
    zod: z.object({}).strict(),
    requiresAuth: true,
    handler: (client) =>
      client.request({ path: "/api/v1/account/rate-limit", signed: true }),
  },
  {
    name: "get_adl_history",
    description:
      "Get the auto-deleveraging (ADL) events that touched a given account. " +
      "Requires API credentials.",
    inputSchema: jsonSchema(
      {
        address: {
          type: "string",
          description: "Account address (0x-prefixed hex).",
        },
        limit: {
          type: "integer",
          description: "Maximum number of records to return.",
        },
      },
      ["address"],
    ),
    zod: z
      .object({
        address: z.string().min(1),
        limit: z.number().int().positive().optional(),
      })
      .strict(),
    requiresAuth: true,
    // No /api/v1 equivalent (not in nexus-exchange-api#41); legacy gateway.
    handler: (client, args) => {
      const a = args as { address: string; limit?: number };
      const query =
        a.limit !== undefined ? `limit=${encodeURIComponent(a.limit)}` : "";
      return client.request({
        path: `/account/${encodeURIComponent(a.address)}/adl-history`,
        query,
        signed: true,
        surface: "gateway",
      });
    },
  },

  // ── Trade actions (require credentials) ───────────────────────────────────
  {
    name: "place_order",
    description:
      "Place an order on a market. Supports limit and market orders, buy/sell. " +
      "For limit orders a `price` is required. Requires API credentials. This " +
      "submits a REAL order to the matching engine.",
    inputSchema: jsonSchema(orderProps, ["market_id", "side", "type", "size"]),
    zod: friendlyOrderSchema,
    requiresAuth: true,
    handler: (client, args) => {
      const body = toWireOrder(args as FriendlyOrder);
      return client.request({
        method: "POST",
        path: "/api/v1/orders",
        body,
        signed: true,
      });
    },
  },
  {
    name: "place_orders_batch",
    description:
      "Submit multiple orders in one request. Each order has the same shape as " +
      "`place_order` (market_id, side, type, size, optional price/" +
      "time_in_force/reduce_only). Requires API credentials. This submits REAL " +
      "orders to the matching engine.",
    inputSchema: jsonSchema(
      {
        orders: {
          type: "array",
          minItems: 1,
          maxItems: MAX_BATCH_ORDERS,
          description: `Orders to submit (1–${MAX_BATCH_ORDERS}). Each uses the place_order arg shape.`,
          items: jsonSchema(orderProps, ["market_id", "side", "type", "size"]),
        },
      },
      ["orders"],
    ),
    zod: z
      .object({
        orders: z.array(friendlyOrderSchema).min(1).max(MAX_BATCH_ORDERS),
      })
      .strict(),
    requiresAuth: true,
    handler: (client, args) => {
      const a = args as { orders: FriendlyOrder[] };
      // Spec /orders/batch takes a bare JSON array of OrderRequest.
      const body = a.orders.map(toWireOrder);
      return client.request({
        method: "POST",
        path: "/api/v1/orders/batch",
        body,
        signed: true,
      });
    },
  },
  {
    name: "cancel_order",
    description:
      "Cancel a resting order. Pass `order_id` AND `market_id` to cancel one " +
      "order (both are required by /api/v1). To cancel ALL open orders you " +
      "must explicitly pass `cancel_all: true` — an empty or argless call is " +
      "rejected so a stray call can't mass-cancel by accident; optionally pass " +
      "`market_id` alongside `cancel_all` to scope the mass-cancel to one " +
      "market. Requires API credentials.",
    inputSchema: jsonSchema({
      order_id: {
        type: "string",
        description: "Order id to cancel a single order.",
      },
      market_id: {
        type: "string",
        description:
          "Market id. REQUIRED when cancelling a single order (order_id); " +
          "optional with cancel_all to scope the mass-cancel to one market.",
      },
      cancel_all: {
        type: "boolean",
        description:
          "Set true to cancel ALL open orders. Required (and the only way) to " +
          "trigger a mass-cancel; ignored when `order_id` is given.",
      },
    }),
    zod: z
      .object({
        order_id: z.string().optional(),
        market_id: z.string().optional(),
        cancel_all: z.boolean().optional(),
      })
      .strict(),
    requiresAuth: true,
    handler: (client, args) => {
      const a = args as {
        order_id?: string;
        market_id?: string;
        cancel_all?: boolean;
      };
      if (!a.order_id) {
        // Mass-cancel is destructive; require an explicit opt-in flag so an
        // empty/argless call errors instead of silently cancelling everything.
        if (!a.cancel_all) {
          throw new Error(
            "Refusing to cancel: pass `order_id` (with `market_id`) to cancel " +
              "one order, or `cancel_all: true` to explicitly cancel ALL open " +
              "orders.",
          );
        }
        // /api/v1 cancel-all accepts an optional market_id to scope the sweep.
        const query = a.market_id
          ? `market_id=${encodeURIComponent(a.market_id)}`
          : "";
        return client.request({
          method: "DELETE",
          path: "/api/v1/orders",
          query,
          signed: true,
        });
      }
      // /api/v1 cancel-by-id REQUIRES market_id (path param order_id + required
      // market_id query). Fail fast with a clear message rather than sending a
      // request the gateway will reject.
      if (!a.market_id) {
        throw new Error(
          "cancel_order requires `market_id` when cancelling a single order " +
            "(order_id). Pass the market the order belongs to.",
        );
      }
      const query = `market_id=${encodeURIComponent(a.market_id)}`;
      return client.request({
        method: "DELETE",
        path: `/api/v1/orders/${encodeURIComponent(a.order_id)}`,
        query,
        signed: true,
      });
    },
  },

  // ── WebSocket access (requires credentials) ───────────────────────────────
  {
    name: "get_ws_token",
    description:
      "Mint a short-lived token for opening an authenticated per-account " +
      "WebSocket stream (order/fill/position updates). Returns the token; the " +
      "caller connects to the exchange WS endpoint with it. Requires API " +
      "credentials.",
    inputSchema: jsonSchema({}),
    zod: z.object({}).strict(),
    requiresAuth: true,
    // No /api/v1 equivalent (not in nexus-exchange-api#41); legacy gateway.
    handler: (client) =>
      client.request({
        method: "POST",
        path: "/ws-tokens",
        signed: true,
        surface: "gateway",
      }),
  },

  // ── Capabilities pending sibling issues (honest, not faked) ───────────────
  {
    name: "get_deposit_target",
    description:
      "Get the on-chain deposit target (address/memo) to fund the account. " +
      "Not yet available — the gateway exposes deposit submission but no " +
      "deposit-address endpoint yet.",
    inputSchema: jsonSchema({
      asset: {
        type: "string",
        description: 'Asset to deposit, e.g. "USDX". Optional.',
      },
    }),
    zod: z.object({ asset: z.string().optional() }).strict(),
    requiresAuth: false,
    handler: async () =>
      PENDING("Deposit-target (on-chain deposit address) lookup"),
  },
  {
    name: "register_agent",
    description:
      "Register a delegated agent key so an AI agent can trade on a wallet's " +
      "behalf without holding the wallet key. Not yet available — delegated " +
      "agent-key registration is still scaffolding server-side and requires a " +
      "wallet EIP-712 signature this server cannot produce.",
    inputSchema: jsonSchema({
      wallet: {
        type: "string",
        description: "Owner wallet address (0x...). Optional.",
      },
      agent: {
        type: "string",
        description: "Agent public key/address to delegate to. Optional.",
      },
    }),
    zod: z
      .object({ wallet: z.string().optional(), agent: z.string().optional() })
      .strict(),
    requiresAuth: false,
    handler: async () => PENDING("Delegated agent-key registration"),
  },
];

export function findTool(name: string): ToolDef | undefined {
  return tools.find((t) => t.name === name);
}
