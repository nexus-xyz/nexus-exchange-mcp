/**
 * Paper mode (ENG-20366): order tools that simulate against the live public
 * order book instead of reaching the matching engine.
 *
 * At each `create_order` the market's book is fetched (`GET
 * /markets/{market_id}/orderbook`, public) and the order is walked against it:
 * a market order takes levels until it is filled or the book runs out, a limit
 * order takes only the levels its price crosses. What a limit order does not
 * fill rests in an in-memory paper book, one per server instance, which
 * `fetch_open_orders` lists and `cancel_order` / `cancel_all_orders` empty.
 *
 * Deliberately NOT simulated, and said so in every response: margin and
 * balance checks, fees, funding, liquidation, positions, and later fills of a
 * resting paper order (it never fills, even when the book moves through it).
 * Only `limit` and `market` orders are simulated; the trigger and trailing
 * types are refused.
 */

import { ExchangeClient } from "./client.js";
import { DEPRECATED_ALIASES, findTool, type ToolDef } from "./tools/index.js";

const NOTE =
  "Paper mode: simulated against a snapshot of the live public order book; " +
  "no order reached the exchange. Margin, fees, funding, liquidation and " +
  "positions are not simulated, and a resting paper order never fills later.";

type Level = [number, number];
interface Book {
  bids: Level[];
  asks: Level[];
}

export interface PaperOrderArgs {
  market_id: string;
  side: "buy" | "sell";
  type: string;
  size: string;
  price?: string;
  time_in_force?: "GTC" | "IOC" | "FOK" | "PostOnly";
}

/** Trim float noise (`0.30000000000000004`) from a reported number. */
const num = (x: number) => String(Number(x.toPrecision(12)));

/**
 * Walk one order against a book snapshot. Pure, so the matching rules are
 * tested without a network.
 */
export function simulate(book: Book, o: PaperOrderArgs) {
  const size = Number(o.size);
  const limit = o.price === undefined ? undefined : Number(o.price);
  const tif = o.time_in_force ?? "GTC";
  // Best level first, whatever order the snapshot came in.
  const levels = (o.side === "buy" ? book.asks : book.bids)
    .map(([p, q]) => [Number(p), Number(q)] as Level)
    .sort((a, b) => (o.side === "buy" ? a[0] - b[0] : b[0] - a[0]));
  const crosses = ([p]: Level) =>
    limit === undefined || (o.side === "buy" ? p <= limit : p >= limit);
  const takeable = levels.filter(crosses);
  const available = takeable.reduce((s, [, q]) => s + q, 0);

  const rejected = (reason: string) => ({
    status: "rejected",
    reason,
    filled_size: "0",
    remaining_size: num(size),
    average_price: null,
    fills: [],
    rests: false,
  });
  if (o.type === "limit" && tif === "PostOnly" && takeable.length > 0) {
    return rejected("PostOnly order would cross the book");
  }
  if (tif === "FOK" && available < size) {
    return rejected(`FOK: only ${num(available)} available at this price`);
  }

  const fills: { price: string; size: string }[] = [];
  let left = size;
  let notional = 0;
  for (const [p, q] of takeable) {
    if (left <= 0) break;
    const take = Math.min(q, left);
    fills.push({ price: num(p), size: num(take) });
    notional += take * p;
    left -= take;
  }
  const filled = size - left;
  const rests = o.type === "limit" && tif === "GTC" && left > 0;
  const status =
    left <= 0
      ? "filled"
      : rests
        ? filled > 0
          ? "partially_filled"
          : "open"
        : filled > 0
          ? "partially_filled_remainder_cancelled"
          : "cancelled";
  return {
    status,
    filled_size: num(filled),
    remaining_size: num(Math.max(left, 0)),
    average_price: filled > 0 ? num(notional / filled) : null,
    fills,
    rests,
  };
}

interface Resting extends PaperOrderArgs {
  order_id: string;
  remaining_size: string;
  created_at: string;
}

/**
 * Paper versions of the order tools, sharing one in-memory book. Built per
 * server, so each stdio process (and each hosted session) has its own.
 * Keyed by tool name; same names and schemas as the real tools, so an agent
 * tested in paper mode makes exactly the calls it would make for real.
 */
export function paperTools(): Map<string, ToolDef> {
  const resting = new Map<string, Resting>();
  let seq = 0;

  const place = async (client: ExchangeClient, a: PaperOrderArgs) => {
    if (a.type !== "limit" && a.type !== "market") {
      throw new Error(
        `Paper mode simulates limit and market orders only, not ${a.type}.`,
      );
    }
    const book = await client.request<Book>({
      path: `/markets/${encodeURIComponent(a.market_id)}/orderbook`,
    });
    const r = simulate(book, a);
    const order_id = `paper-${++seq}`;
    if (r.rests) {
      resting.set(order_id, {
        ...a,
        order_id,
        remaining_size: r.remaining_size,
        created_at: new Date().toISOString(),
      });
    }
    return { simulated: true, order_id, ...a, ...r, note: NOTE };
  };

  const defs: Record<string, ToolDef["handler"]> = {
    create_order: (client, args) => place(client, args as PaperOrderArgs),
    create_orders: async (client, args) => {
      const out = [];
      for (const o of (args as { orders: PaperOrderArgs[] }).orders) {
        out.push(await place(client, o));
      }
      return out;
    },
    fetch_open_orders: async () => ({
      simulated: true,
      orders: [...resting.values()],
      note: NOTE,
    }),
    cancel_order: async (_client, args) => {
      const { order_id } = args as { order_id: string };
      if (!resting.delete(order_id)) {
        throw new Error(`No resting paper order ${order_id}.`);
      }
      return { simulated: true, order_id, status: "cancelled", note: NOTE };
    },
    cancel_all_orders: async (_client, args) => {
      const a = args as { market_id?: string; confirm?: boolean };
      if (!a.confirm) {
        throw new Error("Refusing to cancel: pass `confirm: true`.");
      }
      const ids = [...resting.values()]
        .filter((o) => !a.market_id || o.market_id === a.market_id)
        .map((o) => o.order_id);
      ids.forEach((id) => resting.delete(id));
      return { simulated: true, cancelled: ids, note: NOTE };
    },
  };

  // The deprecated aliases (`place_order`, `get_open_orders`, …) too, or the
  // old name would still reach the real endpoint.
  const names = [
    ...Object.keys(defs).map((n) => [n, n]),
    ...Object.entries(DEPRECATED_ALIASES).filter(([, c]) => c in defs),
  ];
  const out = new Map<string, ToolDef>();
  for (const [name, canonical] of names) {
    const real = findTool(name)!;
    out.set(name, {
      ...real,
      description: `[PAPER MODE: simulated, nothing reaches the exchange] ${real.description}`,
      // Only the in-memory paper book changes, so nothing here is destructive.
      annotations:
        canonical === "fetch_open_orders"
          ? { readOnlyHint: true }
          : {
              readOnlyHint: false,
              destructiveHint: false,
              idempotentHint: canonical.startsWith("cancel"),
            },
      fundsGuard: undefined,
      handler: defs[canonical],
    });
  }
  return out;
}
