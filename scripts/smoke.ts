/**
 * Manual smoke check: spawn the MCP server over stdio (in-process via the
 * SDK's InMemory transport pair), call tools/list, then tools/call
 * list_markets against the exchange target named by NEXUS_EXCHANGE_API_URL.
 * Prints the market count or the error.
 *
 * Run: NEXUS_EXCHANGE_API_URL=… npm run smoke   (uses tsx, no build needed)
 *
 * There is deliberately NO default target (ENG-8092). This script used to fall
 * back to the public site root, which serves the Next.js marketing app and not
 * the `/api/v1` surface, so every run reported a 404 whose body was a page of
 * script tags. Worse, a wrong-but-reachable target answering HTML with a 2xx
 * would have been reported as a PASS, because the check only tried to count
 * array entries and shrugged off a parse failure. A smoke check that cannot
 * tell the API from a web page is worse than one that refuses to run, so this
 * one refuses: it demands an explicit target and validates that what came back
 * is really market-summary JSON.
 */

import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";

/** Environment variable naming the exchange target to smoke against. */
export const BASE_URL_ENV = "NEXUS_EXCHANGE_API_URL";

/** The target is missing or unusable — nothing was called upstream. */
export class SmokeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmokeConfigError";
  }
}

/** The target answered, but with something that is not the API's payload. */
export class SmokeResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmokeResponseError";
  }
}

/**
 * Resolve the target to smoke against. Unset, blank, or non-HTTP(S) values are
 * a hard stop naming the variable — never a silent fallback to a host that may
 * not serve the API.
 */
export function resolveTarget(env: NodeJS.ProcessEnv): string {
  const raw = (env[BASE_URL_ENV] ?? "").trim();
  if (!raw) {
    throw new SmokeConfigError(
      `${BASE_URL_ENV} is not set. The smoke check has no default target: the ` +
        `public site root serves the marketing app, not the /api/v1 surface, ` +
        `so defaulting to it produced a run that could only fail (ENG-8092). ` +
        `Point it at a host that serves the Exchange API, e.g.\n` +
        `  ${BASE_URL_ENV}=http://localhost:9090 npm run smoke`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new SmokeConfigError(
      `${BASE_URL_ENV} is not a valid URL: ${JSON.stringify(raw)}. Expected an ` +
        `origin such as http://localhost:9090.`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SmokeConfigError(
      `${BASE_URL_ENV} must be an http(s) URL, got ${JSON.stringify(raw)}.`,
    );
  }
  return raw;
}

/**
 * Whether a response body is markup rather than JSON. A wrong-but-reachable
 * target — a web front-end, a proxy error page, a login redirect — answers
 * with HTML, which must never be mistaken for API data.
 */
export function looksLikeMarkup(body: string): boolean {
  return /^\s*(?:<!doctype\b|<\?xml|<html\b|<)/i.test(body);
}

/**
 * Whether an error *message* has a markup document embedded in it. The client
 * wraps a failing upstream body in `Exchange API <status>: <body>`, so the
 * markup is no longer at offset zero and {@link looksLikeMarkup} cannot see it.
 * Unanchored on purpose, and limited to unambiguous document markers so a JSON
 * error body that merely mentions a tag is not misreported.
 */
export function containsMarkup(message: string): boolean {
  return /<!doctype\s+html\b|<html[\s>]/i.test(message);
}

/**
 * Validate that a `list_markets` result really is the API's market-summary
 * JSON: an array whose entries carry a `market_id` string.
 *
 * `list_markets` is not one of the cursor-paginated tools, so a bare array is
 * the expected shape. Anything else throws, including the empty string an
 * unexpected 204 would produce — a check that reports "OK" for a body it could
 * not parse is exactly the defect this replaces.
 */
export function assertMarketPayload(body: string): unknown[] {
  if (looksLikeMarkup(body)) {
    throw new SmokeResponseError(
      `${BASE_URL_ENV} target answered with HTML, not JSON — it is a web ` +
        `front-end or an error page, not the Exchange API. First 120 bytes: ` +
        `${JSON.stringify(body.slice(0, 120))}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new SmokeResponseError(
      `list_markets body is not JSON. First 120 bytes: ` +
        `${JSON.stringify(body.slice(0, 120))}`,
    );
  }
  // A 2xx HTML body reaches us JSON-quoted: the client cannot parse it, hands
  // the raw text back as the tool's result, and the server serializes that
  // string. So the markup lands one JSON-string layer down, where the raw-body
  // check above cannot see it. This is the case the old script reported as a
  // pass, so it gets the same explicit diagnostic as a markup body.
  if (typeof parsed === "string" && looksLikeMarkup(parsed)) {
    throw new SmokeResponseError(
      `${BASE_URL_ENV} target answered 2xx with HTML, not JSON — it is a web ` +
        `front-end or an error page, not the Exchange API. First 120 bytes: ` +
        `${JSON.stringify(parsed.slice(0, 120))}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new SmokeResponseError(
      `list_markets returned ${describe(parsed)}, expected an array of market ` +
        `summaries.`,
    );
  }
  // An empty array is a legitimate answer from an indexer with no markets, so
  // it passes; only a populated array's shape can be checked further.
  if (parsed.length > 0 && !isMarketSummary(parsed[0])) {
    throw new SmokeResponseError(
      `list_markets returned an array whose first entry is not a market ` +
        `summary (no string \`market_id\`): ` +
        `${JSON.stringify(parsed[0]).slice(0, 160)}`,
    );
  }
  return parsed;
}

function isMarketSummary(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { market_id?: unknown }).market_id === "string"
  );
}

function describe(value: unknown): string {
  if (value === null) return "null";
  return Array.isArray(value) ? "an array" : `a ${typeof value}`;
}

async function main(): Promise<void> {
  const target = resolveTarget(process.env);
  console.error(`target: ${target} (${BASE_URL_ENV})`);

  const server = createServer();
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client(
    { name: "smoke", version: "0.0.0" },
    { capabilities: {} },
  );
  await client.connect(clientTransport);

  try {
    const list = await client.listTools();
    console.error(
      `tools/list -> ${list.tools.length} tools: ${list.tools.map((t) => t.name).join(", ")}`,
    );

    const res = await client.callTool({ name: "list_markets", arguments: {} });
    const content = res.content as Array<{ type: string; text?: string }>;
    const text = content[0]?.text ?? "";

    if (res.isError) {
      console.error("list_markets FAILED:");
      if (looksLikeMarkup(text) || containsMarkup(text)) {
        console.error(
          `  the target answered with HTML, not JSON — ${BASE_URL_ENV} points ` +
            `at a web front-end or an error page, not the Exchange API.`,
        );
      }
      console.error(text);
      process.exitCode = 1;
      return;
    }

    let markets: unknown[];
    try {
      markets = assertMarketPayload(text);
    } catch (err) {
      console.error("list_markets FAILED:");
      console.error(`  ${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }

    console.error(`list_markets OK -> ${markets.length} markets`);
    console.error(text.slice(0, 600));
  } finally {
    await client.close();
    await server.close();
  }
}

const entrypoint = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;
if (entrypoint === import.meta.url) {
  main().catch((err) => {
    console.error(`smoke failed: ${(err as Error).message}`);
    process.exit(1);
  });
}
