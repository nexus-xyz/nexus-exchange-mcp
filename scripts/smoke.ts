/**
 * Manual smoke check: spawn the MCP server over stdio (in-process via the
 * SDK's InMemory transport pair), call tools/list, then tools/call
 * list_markets against the configured exchange gateway (defaults to
 * production). Prints the market count or the error.
 *
 * Run: npm run smoke   (uses tsx, no build needed)
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";

async function main(): Promise<void> {
  const server = createServer();
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client(
    { name: "smoke", version: "0.0.0" },
    { capabilities: {} },
  );
  await client.connect(clientTransport);

  const list = await client.listTools();
  console.error(
    `tools/list -> ${list.tools.length} tools: ${list.tools.map((t) => t.name).join(", ")}`,
  );

  const res = await client.callTool({ name: "list_markets", arguments: {} });
  const content = res.content as Array<{ type: string; text?: string }>;
  const text = content[0]?.text ?? "";
  if (res.isError) {
    console.error("list_markets FAILED:");
    console.error(text);
    process.exitCode = 1;
  } else {
    let count = "?";
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) count = String(parsed.length);
    } catch {
      /* leave as ? */
    }
    console.error(`list_markets OK -> ${count} markets`);
    console.error(text.slice(0, 600));
  }

  await client.close();
  await server.close();
}

main().catch((err) => {
  console.error("smoke failed:", err);
  process.exit(1);
});
