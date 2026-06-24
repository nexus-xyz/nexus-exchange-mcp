/**
 * Tool definitions for the Nexus Exchange MCP server.
 *
 * Each tool maps to a real indexer gateway endpoint. One tool
 * (`get_deposit_target`) describes a capability that is not yet built
 * server-side; it returns an honest "pending" message rather than faking a
 * result. Operator-only admin tools (`adminOnly`) are registered only when
 * `NEXUS_EXCHANGE_ENABLE_ADMIN_TOOLS` is set — see `visibleTools`.
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
  /**
   * Operator-only admin tool (uses the admin secret, mutates other accounts).
   * Not registered unless `NEXUS_EXCHANGE_ENABLE_ADMIN_TOOLS` is set. See
   * `visibleTools` / config `enableAdminTools`.
   */
  adminOnly?: boolean;
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
    handler: (client) => client.request({ path: "/markets/summary" }),
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
        path: `/markets/${encodeURIComponent(market_id)}/ticker`,
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
        path: `/markets/${encodeURIComponent(market_id)}/orderbook`,
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
    handler: (client) => client.request({ path: "/markets" }),
  },
  {
    name: "get_tickers",
    description:
      "Get tickers (last price, bid/ask, 24h stats) for ALL markets in one " +
      "call. Public — no credentials needed.",
    inputSchema: jsonSchema({}),
    zod: z.object({}).strict(),
    requiresAuth: false,
    handler: (client) => client.request({ path: "/tickers" }),
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
        path: `/markets/${encodeURIComponent(market_id)}/mark-price`,
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
        path: `/markets/${encodeURIComponent(market_id)}/status`,
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
        path: `/markets/${encodeURIComponent(a.market_id)}/trades`,
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
        path: `/markets/${encodeURIComponent(a.market_id)}/candles`,
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
        path: `/markets/${encodeURIComponent(a.market_id)}/funding`,
        query,
      });
    },
  },

  // ── Public demo account (no credentials) ──────────────────────────────────
  // The indexer exposes a read-only demo namespace bound to a live bot
  // account (api.ts: indexer.demoAccount/demoPositions/demoOrders). Lets the
  // demo show real balances/positions/orders with zero secrets.
  {
    name: "get_demo_account",
    description:
      "Get a live, public demo account snapshot (balance, equity, positions). " +
      "No credentials needed — useful to show the account flow before API keys " +
      "are wired up.",
    inputSchema: jsonSchema({}),
    zod: z.object({}).strict(),
    requiresAuth: false,
    handler: (client) => client.request({ path: "/demo/account" }),
  },
  {
    name: "get_demo_positions",
    description:
      "Get the public demo account's open positions. No credentials needed.",
    inputSchema: jsonSchema({}),
    zod: z.object({}).strict(),
    requiresAuth: false,
    handler: (client) => client.request({ path: "/demo/positions" }),
  },
  {
    name: "get_demo_orders",
    description:
      "Get the public demo account's open orders. No credentials needed.",
    inputSchema: jsonSchema({}),
    zod: z.object({}).strict(),
    requiresAuth: false,
    handler: (client) => client.request({ path: "/demo/orders" }),
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
    handler: (client) => client.request({ path: "/account", signed: true }),
  },
  {
    name: "get_positions",
    description:
      "Get the authenticated account's open positions. Requires API credentials.",
    inputSchema: jsonSchema({}),
    zod: z.object({}).strict(),
    requiresAuth: true,
    handler: (client) => client.request({ path: "/positions", signed: true }),
  },
  {
    name: "get_open_orders",
    description:
      "Get the authenticated account's resting (open) orders. Requires API credentials.",
    inputSchema: jsonSchema({}),
    zod: z.object({}).strict(),
    requiresAuth: true,
    handler: (client) => client.request({ path: "/orders", signed: true }),
  },
  {
    name: "get_order",
    description:
      "Get a single order by its id (status, fills, remaining size). Requires " +
      "API credentials.",
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
    handler: (client, args) => {
      const { order_id } = args as { order_id: string };
      return client.request({
        path: `/orders/${encodeURIComponent(order_id)}`,
        signed: true,
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
      return client.request({ path: "/fills", query, signed: true });
    },
  },
  {
    name: "get_funding_payments",
    description:
      "Get the authenticated account's funding-payment history, optionally " +
      "filtered to a single market. Requires API credentials.",
    inputSchema: jsonSchema({
      market_id: {
        type: "string",
        description: 'Market id to filter to, e.g. "BTC-USDX-PERP". Optional.',
      },
    }),
    zod: z.object({ market_id: z.string().min(1).optional() }).strict(),
    requiresAuth: true,
    handler: (client, args) => {
      const a = args as { market_id?: string };
      const query = a.market_id
        ? `market_id=${encodeURIComponent(a.market_id)}`
        : "";
      return client.request({ path: "/funding-payments", query, signed: true });
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
    handler: (client, args) => {
      const a = args as { limit?: number };
      const query =
        a.limit !== undefined ? `limit=${encodeURIComponent(a.limit)}` : "";
      return client.request({ path: "/withdrawals", query, signed: true });
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
      client.request({ path: "/account/rate-limit", signed: true }),
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
    handler: (client, args) => {
      const a = args as { address: string; limit?: number };
      const query =
        a.limit !== undefined ? `limit=${encodeURIComponent(a.limit)}` : "";
      return client.request({
        path: `/account/${encodeURIComponent(a.address)}/adl-history`,
        query,
        signed: true,
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
        path: "/orders",
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
        path: "/orders/batch",
        body,
        signed: true,
      });
    },
  },
  {
    name: "cancel_order",
    description:
      "Cancel a resting order. Pass `order_id` to cancel one order. To cancel " +
      "ALL open orders you must explicitly pass `cancel_all: true` — an empty " +
      "or argless call is rejected so a stray call can't mass-cancel by " +
      "accident. Requires API credentials.",
    inputSchema: jsonSchema({
      order_id: {
        type: "string",
        description: "Order id to cancel a single order.",
      },
      market_id: {
        type: "string",
        description: "Market id (recommended when cancelling a single order).",
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
            "Refusing to cancel: pass `order_id` to cancel one order, or " +
              "`cancel_all: true` to explicitly cancel ALL open orders.",
          );
        }
        return client.request({
          method: "DELETE",
          path: "/orders",
          signed: true,
        });
      }
      const query = a.market_id
        ? `market_id=${encodeURIComponent(a.market_id)}`
        : "";
      return client.request({
        method: "DELETE",
        path: `/orders/${encodeURIComponent(a.order_id)}`,
        query,
        signed: true,
      });
    },
  },

  // ── Auto-deleveraging (per-market, requires credentials) ──────────────────
  {
    name: "get_market_adl_events",
    description:
      "Get the auto-deleveraging (ADL) settlement history for one market — the " +
      "events where the engine force-closed positions to cover a shortfall. " +
      "Requires API credentials.",
    inputSchema: jsonSchema(
      {
        market_id: {
          type: "string",
          description: 'Market id, e.g. "BTC-USDX-PERP".',
        },
        limit: {
          type: "integer",
          description: "Maximum number of events to return (max 1000).",
        },
      },
      ["market_id"],
    ),
    zod: z
      .object({
        market_id: z.string().min(1),
        limit: z.number().int().positive().max(1000).optional(),
      })
      .strict(),
    requiresAuth: true,
    handler: (client, args) => {
      const a = args as { market_id: string; limit?: number };
      const query =
        a.limit !== undefined ? `limit=${encodeURIComponent(a.limit)}` : "";
      return client.request({
        path: `/markets/${encodeURIComponent(a.market_id)}/adl-events`,
        query,
        signed: true,
      });
    },
  },

  // ── Funding actions (require credentials) ─────────────────────────────────
  {
    name: "deposit_collateral",
    description:
      "Deposit USDX collateral into the authenticated account. `amount` is a " +
      "positive decimal string. Requires API credentials. This moves REAL " +
      "collateral on the account.",
    inputSchema: jsonSchema(
      {
        amount: {
          type: "string",
          description:
            "USDX amount to deposit, as a positive decimal string (> 0).",
        },
      },
      ["amount"],
    ),
    zod: z.object({ amount: positiveDecimal("amount") }).strict(),
    requiresAuth: true,
    handler: (client, args) => {
      const { amount } = args as { amount: string };
      return client.request({
        method: "POST",
        path: "/account/deposit",
        body: { amount },
        signed: true,
      });
    },
  },
  {
    name: "claim_credit",
    description:
      "Claim synthetic USDX credit from the testnet faucet, up to a per-key " +
      "daily allowance (default 500 USDX, resets midnight UTC). Pass `amount` " +
      "(positive decimal string) to claim a specific amount, or omit it to " +
      "claim the full remaining allowance. The credited USDX is synthetic " +
      "testnet value. Requires API credentials.",
    inputSchema: jsonSchema({
      amount: {
        type: "string",
        description:
          "USDX to credit, as a positive decimal string (> 0). Omit to claim " +
          "the full remaining daily allowance.",
      },
    }),
    zod: z.object({ amount: positiveDecimal("amount").optional() }).strict(),
    requiresAuth: true,
    handler: (client, args) => {
      const a = args as { amount?: string };
      // `amount` is optional; send an empty body when omitted so the gateway
      // claims the full remaining allowance.
      const body = a.amount !== undefined ? { amount: a.amount } : {};
      return client.request({
        method: "POST",
        path: "/account/credit",
        body,
        signed: true,
      });
    },
  },

  // ── Agent-key management (requires credentials) ───────────────────────────
  {
    name: "list_agents",
    description:
      "List the delegated agent keys registered for the authenticated wallet " +
      "(address, label, expiry). Requires API credentials.",
    inputSchema: jsonSchema({}),
    zod: z.object({}).strict(),
    requiresAuth: true,
    handler: (client) => client.request({ path: "/agents", signed: true }),
  },
  {
    name: "register_agent",
    description:
      "Register a delegated agent key so an AI agent can trade on a wallet's " +
      "behalf without holding the wallet key. Authorized by an EIP-712 " +
      "signature from the OWNER WALLET over `RegisterAgent{agent, expiresAt, " +
      "nonce}` (domain `NexusExchange` v1). This server cannot produce that " +
      "wallet signature — sign it externally (e.g. in the wallet) and pass it " +
      "as `signature`. No API credentials are needed; the signature is the " +
      "authorization.",
    inputSchema: jsonSchema(
      {
        wallet: {
          type: "string",
          description: "Owner wallet address (0x-prefixed, 20 bytes).",
        },
        agent: {
          type: "string",
          description:
            "Agent Ethereum address (0x-prefixed, 20 bytes) to delegate to.",
        },
        nonce: {
          type: "integer",
          description:
            "Monotonic nonce. Use the current Unix time in ms as a safe start.",
        },
        signature: {
          type: "string",
          description:
            "EIP-712 signature over RegisterAgent{agent, expiresAt, nonce} from " +
            "the wallet private key (0x-prefixed).",
        },
        expires_at: {
          type: "integer",
          description:
            "Expiry as Unix ms. Optional — defaults to now+30d. Must be in " +
            "[now+1d, now+90d].",
        },
        label: {
          type: "string",
          description: "Optional human-readable label for the agent.",
        },
      },
      ["wallet", "agent", "nonce", "signature"],
    ),
    zod: z
      .object({
        wallet: z.string().min(1),
        agent: z.string().min(1),
        nonce: z.number().int().nonnegative(),
        signature: z.string().min(1),
        expires_at: z.number().int().positive().optional(),
        label: z.string().optional(),
      })
      .strict(),
    requiresAuth: false,
    handler: (client, args) => {
      const a = args as {
        wallet: string;
        agent: string;
        nonce: number;
        signature: string;
        expires_at?: number;
        label?: string;
      };
      const body: Record<string, unknown> = {
        wallet: a.wallet,
        agent: a.agent,
        nonce: a.nonce,
        signature: a.signature,
      };
      if (a.expires_at !== undefined) body.expires_at = a.expires_at;
      if (a.label !== undefined) body.label = a.label;
      return client.request({
        method: "POST",
        path: "/agents/register",
        body,
      });
    },
  },
  {
    name: "revoke_agent",
    description:
      "Revoke a previously registered delegated agent key by its address. " +
      "Destructive: the agent can no longer trade on the wallet's behalf. To " +
      "avoid an accidental revoke you must pass `confirm: true`. Requires API " +
      "credentials.",
    inputSchema: jsonSchema(
      {
        address: {
          type: "string",
          description: "Agent address to revoke (0x-prefixed).",
        },
        confirm: {
          type: "boolean",
          description:
            "Must be true to actually revoke (guards against typos).",
        },
      },
      ["address"],
    ),
    zod: z
      .object({ address: z.string().min(1), confirm: z.boolean().optional() })
      .strict(),
    requiresAuth: true,
    handler: (client, args) => {
      const a = args as { address: string; confirm?: boolean };
      if (!a.confirm) {
        throw new Error(
          "Refusing to revoke: pass `confirm: true` to revoke agent " +
            `${a.address}.`,
        );
      }
      return client.request({
        method: "DELETE",
        path: `/agents/${encodeURIComponent(a.address)}`,
        signed: true,
      });
    },
  },

  // ── Session + API-key management (Bearer session token) ───────────────────
  {
    name: "login",
    description:
      "Sign in with an EVM wallet to get a 24h session token. Submit an " +
      'EIP-191 personal_sign signature over the exact message "Sign in to ' +
      'Nexus Exchange". This server cannot sign for you — produce the ' +
      "signature in the wallet and pass it as `signature`. The returned token " +
      "is used as the Bearer credential for the `*_api_key` tools (set it as " +
      "NEXUS_EXCHANGE_SESSION_TOKEN). No credentials needed to call this.",
    inputSchema: jsonSchema(
      {
        signature: {
          type: "string",
          description:
            "EIP-191 personal_sign hex (0x-prefixed, 65 bytes) over the login " +
            "message.",
        },
        message: {
          type: "string",
          description:
            'Signed message. Must be exactly "Sign in to Nexus Exchange" ' +
            "(the default if omitted).",
        },
      },
      ["signature"],
    ),
    zod: z
      .object({ signature: z.string().min(1), message: z.string().optional() })
      .strict(),
    requiresAuth: false,
    handler: (client, args) => {
      const a = args as { signature: string; message?: string };
      return client.request({
        method: "POST",
        path: "/auth/login",
        body: {
          message: a.message ?? "Sign in to Nexus Exchange",
          signature: a.signature,
        },
      });
    },
  },
  {
    name: "list_api_keys",
    description:
      "List the HMAC API keys for the authenticated wallet (key ids and " +
      "metadata; never the secrets). Authenticates with a session token from " +
      "`login` — set NEXUS_EXCHANGE_SESSION_TOKEN.",
    inputSchema: jsonSchema({}),
    zod: z.object({}).strict(),
    requiresAuth: true,
    handler: (client) => client.request({ path: "/keys", auth: "bearer" }),
  },
  {
    name: "create_api_key",
    description:
      "Create a new HMAC API key for the authenticated wallet. The secret is " +
      "returned ONCE and never shown again — store it immediately. " +
      "Authenticates with a session token from `login` — set " +
      "NEXUS_EXCHANGE_SESSION_TOKEN.",
    inputSchema: jsonSchema({}),
    zod: z.object({}).strict(),
    requiresAuth: true,
    handler: (client) =>
      client.request({ method: "POST", path: "/keys", auth: "bearer" }),
  },
  {
    name: "delete_api_key",
    description:
      "Delete (revoke) an HMAC API key by its key id. Destructive: any caller " +
      "using that key stops working. You must pass `confirm: true`. " +
      "Authenticates with a session token from `login` — set " +
      "NEXUS_EXCHANGE_SESSION_TOKEN.",
    inputSchema: jsonSchema(
      {
        key_id: {
          type: "string",
          description: 'API key id to delete, e.g. "nx_a1b2c3d4e5f67890".',
        },
        confirm: {
          type: "boolean",
          description:
            "Must be true to actually delete (guards against typos).",
        },
      },
      ["key_id"],
    ),
    zod: z
      .object({ key_id: z.string().min(1), confirm: z.boolean().optional() })
      .strict(),
    requiresAuth: true,
    handler: (client, args) => {
      const a = args as { key_id: string; confirm?: boolean };
      if (!a.confirm) {
        throw new Error(
          "Refusing to delete: pass `confirm: true` to delete API key " +
            `${a.key_id}.`,
        );
      }
      return client.request({
        method: "DELETE",
        path: `/keys/${encodeURIComponent(a.key_id)}`,
        auth: "bearer",
      });
    },
  },

  // ── WebSocket access (requires credentials) ───────────────────────────────
  {
    name: "get_ws_token",
    description:
      "Mint a short-lived (60s, single-use) token for an authenticated " +
      "per-account WebSocket stream (order/fill/position updates). Uses the " +
      "current `/ws/token` endpoint, which supports HMAC keys and registered " +
      "agents. The caller connects to `GET /ws?token=…` with the token. " +
      "Requires API credentials.",
    inputSchema: jsonSchema({}),
    zod: z.object({}).strict(),
    requiresAuth: true,
    handler: (client) =>
      client.request({ method: "POST", path: "/ws/token", signed: true }),
  },
  {
    name: "get_ws_token_legacy",
    description:
      "Mint a short-lived (60s, single-use) token for the legacy public " +
      "`/stream` endpoint via `POST /ws-tokens`. Prefer `get_ws_token` " +
      "(`/ws/token`) for new code; this is kept for `/stream` compatibility. " +
      "Requires API credentials.",
    inputSchema: jsonSchema({}),
    zod: z.object({}).strict(),
    requiresAuth: true,
    handler: (client) =>
      client.request({ method: "POST", path: "/ws-tokens", signed: true }),
  },

  // ── Service health (public) ───────────────────────────────────────────────
  {
    name: "get_health",
    description:
      "Health check for the exchange gateway (liveness/readiness). Public — no " +
      "credentials needed.",
    inputSchema: jsonSchema({}),
    zod: z.object({}).strict(),
    requiresAuth: false,
    handler: (client) => client.request({ path: "/health" }),
  },

  // ── Admin tier management (operator-only; gated off by default) ────────────
  // These use the operator admin secret and mutate OTHER accounts' fee tiers,
  // so they are registered only when NEXUS_EXCHANGE_ENABLE_ADMIN_TOOLS is set.
  {
    name: "list_tiers",
    description:
      "ADMIN: list the configured account fee-tier overrides. Operator-only — " +
      "uses the admin secret (NEXUS_EXCHANGE_ADMIN_SECRET) and is registered " +
      "only when NEXUS_EXCHANGE_ENABLE_ADMIN_TOOLS is set.",
    inputSchema: jsonSchema({}),
    zod: z.object({}).strict(),
    requiresAuth: true,
    adminOnly: true,
    handler: (client) =>
      client.request({ path: "/admin/tiers", auth: "admin" }),
  },
  {
    name: "set_tier",
    description:
      "ADMIN: set an account's fee tier override. Operator-only and mutates " +
      "ANOTHER account — uses the admin secret and is registered only when " +
      "NEXUS_EXCHANGE_ENABLE_ADMIN_TOOLS is set.",
    inputSchema: jsonSchema(
      {
        address: {
          type: "string",
          description: "Account address to set the tier for (0x-prefixed).",
        },
        tier: {
          type: "string",
          description: 'Tier name, e.g. "MarketMaker".',
        },
      },
      ["address", "tier"],
    ),
    zod: z
      .object({ address: z.string().min(1), tier: z.string().min(1) })
      .strict(),
    requiresAuth: true,
    adminOnly: true,
    handler: (client, args) => {
      const a = args as { address: string; tier: string };
      return client.request({
        method: "PUT",
        path: "/admin/tiers",
        body: { address: a.address, tier: a.tier },
        auth: "admin",
      });
    },
  },
  {
    name: "delete_tier",
    description:
      "ADMIN: reset an account's fee tier override back to default. " +
      "Operator-only, destructive on another account — uses the admin secret " +
      "and is registered only when NEXUS_EXCHANGE_ENABLE_ADMIN_TOOLS is set. " +
      "Requires `confirm: true`.",
    inputSchema: jsonSchema(
      {
        address: {
          type: "string",
          description: "Account address whose tier override to reset.",
        },
        confirm: {
          type: "boolean",
          description: "Must be true to actually reset (guards against typos).",
        },
      },
      ["address"],
    ),
    zod: z
      .object({ address: z.string().min(1), confirm: z.boolean().optional() })
      .strict(),
    requiresAuth: true,
    adminOnly: true,
    handler: (client, args) => {
      const a = args as { address: string; confirm?: boolean };
      if (!a.confirm) {
        throw new Error(
          "Refusing to reset tier: pass `confirm: true` to reset the tier for " +
            `${a.address}.`,
        );
      }
      return client.request({
        method: "DELETE",
        path: `/admin/tiers/${encodeURIComponent(a.address)}`,
        auth: "admin",
      });
    },
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
];

export function findTool(name: string): ToolDef | undefined {
  return tools.find((t) => t.name === name);
}

/**
 * Tools that should be advertised/callable for a given config. Admin tools are
 * hidden unless `enableAdminTools` is set, so a general trading agent never
 * sees operator-only, cross-account mutations.
 */
export function visibleTools(opts: { enableAdminTools: boolean }): ToolDef[] {
  return tools.filter((t) => !t.adminOnly || opts.enableAdminTools);
}
