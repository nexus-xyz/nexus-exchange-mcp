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
    name: "get_recent_trades",
    description:
      "Get recent public trades for one market (newest first), optionally " +
      "limited. Public — no credentials needed.",
    inputSchema: jsonSchema(
      {
        market_id: {
          type: "string",
          description: 'Market id, e.g. "BTC-USDX-PERP".',
        },
        limit: {
          type: "number",
          description: "Max number of trades to return. Optional.",
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
      const query = a.limit !== undefined ? `limit=${a.limit}` : "";
      return client.request({
        path: `/markets/${encodeURIComponent(a.market_id)}/trades`,
        query,
      });
    },
  },
  {
    name: "get_candles",
    description:
      "Get OHLCV candles for one market, with an optional interval " +
      '(e.g. "1m", "1h", "1d") and limit. Public — no credentials needed.',
    inputSchema: jsonSchema(
      {
        market_id: {
          type: "string",
          description: 'Market id, e.g. "BTC-USDX-PERP".',
        },
        interval: {
          type: "string",
          description:
            'Candle interval/timeframe, e.g. "1m", "1h", "1d". Optional.',
        },
        limit: {
          type: "number",
          description: "Max number of candles to return. Optional.",
        },
      },
      ["market_id"],
    ),
    zod: z
      .object({
        market_id: z.string().min(1),
        interval: z.string().min(1).optional(),
        limit: z.number().int().positive().optional(),
      })
      .strict(),
    requiresAuth: false,
    handler: (client, args) => {
      const a = args as {
        market_id: string;
        interval?: string;
        limit?: number;
      };
      // Gateway query param is `timeframe` (rest.rs::fetch_ohlcv).
      const params: string[] = [];
      if (a.interval !== undefined)
        params.push(`timeframe=${encodeURIComponent(a.interval)}`);
      if (a.limit !== undefined) params.push(`limit=${a.limit}`);
      return client.request({
        path: `/markets/${encodeURIComponent(a.market_id)}/candles`,
        query: params.join("&"),
      });
    },
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
      "Get the lifecycle / halt status for one market. Public — no credentials needed.",
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
    name: "get_funding",
    description:
      "Get the funding-rate history for one market, optionally limited. " +
      "Public — no credentials needed.",
    inputSchema: jsonSchema(
      {
        market_id: {
          type: "string",
          description: 'Market id, e.g. "BTC-USDX-PERP".',
        },
        limit: {
          type: "number",
          description: "Max number of samples to return. Optional.",
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
      const query = a.limit !== undefined ? `limit=${a.limit}` : "";
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
    name: "get_fills",
    description:
      "Get the authenticated account's recent fills (private trade executions). " +
      "Requires API credentials.",
    inputSchema: jsonSchema({}),
    zod: z.object({}).strict(),
    requiresAuth: true,
    handler: (client) => client.request({ path: "/fills", signed: true }),
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

  // ── Trade actions (require credentials) ───────────────────────────────────
  {
    name: "place_order",
    description:
      "Place an order on a market. Supports limit and market orders, buy/sell. " +
      "For limit orders a `price` is required. Requires API credentials. This " +
      "submits a REAL order to the matching engine.",
    inputSchema: jsonSchema(
      {
        market_id: {
          type: "string",
          description: 'Market id, e.g. "BTC-USDX-PERP".',
        },
        side: {
          type: "string",
          enum: ["buy", "sell"],
          description: "Order side.",
        },
        type: {
          type: "string",
          enum: ["limit", "market"],
          description: "Order type.",
        },
        size: {
          type: "string",
          description: "Order quantity in base units, as a string.",
        },
        price: {
          type: "string",
          description:
            "Limit price as a string. Required for limit orders, ignored for market.",
        },
        time_in_force: {
          type: "string",
          enum: ["GTC", "IOC", "FOK"],
          description:
            "Time in force. Defaults to GTC for limit, IOC for market.",
        },
        reduce_only: {
          type: "boolean",
          description: "If true, only reduces an existing position.",
        },
      },
      ["market_id", "side", "type", "size"],
    ),
    zod: z
      .object({
        market_id: z.string().min(1),
        side: z.enum(["buy", "sell"]),
        type: z.enum(["limit", "market"]),
        size: z.string().min(1),
        price: z.string().optional(),
        time_in_force: z.enum(["GTC", "IOC", "FOK"]).optional(),
        reduce_only: z.boolean().optional(),
      })
      .strict()
      .refine((v) => v.type !== "limit" || (v.price && v.price.length > 0), {
        message: "price is required for limit orders",
        path: ["price"],
      }),
    requiresAuth: true,
    handler: (client, args) => {
      const a = args as {
        market_id: string;
        side: "buy" | "sell";
        type: "limit" | "market";
        size: string;
        price?: string;
        time_in_force?: "GTC" | "IOC" | "FOK";
        reduce_only?: boolean;
      };
      // Engine wire shape (bots/src/client.rs OrderRequest): capitalized side,
      // order_type, quantity, optional price, time_in_force.
      const body: Record<string, unknown> = {
        market_id: a.market_id,
        side: a.side === "buy" ? "Buy" : "Sell",
        order_type: a.type === "limit" ? "Limit" : "Market",
        quantity: a.size,
        time_in_force: a.time_in_force ?? (a.type === "limit" ? "GTC" : "IOC"),
      };
      if (a.type === "limit") body.price = a.price;
      if (a.reduce_only) body.reduce_only = true;
      return client.request({
        method: "POST",
        path: "/orders",
        body,
        signed: true,
      });
    },
  },
  {
    name: "cancel_order",
    description:
      "Cancel one resting order by id, or all open orders if `order_id` is " +
      "omitted. Requires API credentials.",
    inputSchema: jsonSchema({
      order_id: {
        type: "string",
        description: "Order id to cancel. Omit to cancel ALL open orders.",
      },
      market_id: {
        type: "string",
        description: "Market id (recommended when cancelling a single order).",
      },
    }),
    zod: z
      .object({
        order_id: z.string().optional(),
        market_id: z.string().optional(),
      })
      .strict(),
    requiresAuth: true,
    handler: (client, args) => {
      const a = args as { order_id?: string; market_id?: string };
      if (!a.order_id) {
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
