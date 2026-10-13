// Public-surface listing (ENG-18798), run by scripts/release_gate/public_api.sh
// inside a throwaway consumer that installed the packed tarball. It imports the
// built dist/ from that install, not src/ through tsx, so it lists the package
// exactly as npm hands it to a user.
//
// CONTRIBUTING.md ("Two public surfaces break independently") names two: the
// TypeScript API and the MCP tools. The package has no `exports` and its `main`
// is the server binary, so the only TypeScript a user can import is a deep
// `dist/` path, which this leaves out. It lists what an agent and a shell call:
//
//   - the MCP tools, as tools/list advertises them: one line per tool name, and
//     one per input-schema property path with its type, whether it is required,
//     its enum and the constraints that narrow it. A renamed or removed tool, a
//     dropped argument, a narrowed enum or a newly required field each change a
//     line. Descriptions are left out, so rewording one is not an API change.
//   - the `bin` entries of the packed package.json, with a note when the target
//     is missing from the tarball or has no shebang, since either breaks `npx`
//     for every user.
//
// tools/list advertises each tool's `inputSchema`, but the server validates a
// call with the tool's zod schema (src/server.ts), a second definition. Where
// the two disagree on a tool's properties, required properties or top-level
// enums, an agent following the listing gets "Invalid arguments" back, and the
// listing alone would not show it. So this fails, with no listing written,
// until they agree (ENG-18798 review).
//
// Admin tools are hidden unless NEXUS_EXCHANGE_ENABLE_ADMIN_TOOLS is set, so
// the server is listed both ways and those tools are marked `admin-only`. Both
// configs are built from an explicit env, never process.env, so the listing
// does not depend on who runs it. Lines are sorted by code unit, not by locale,
// so the output is the same on every machine.
//
// The schema-to-lines rules and the advertised-vs-zod comparison live in
// surface-lib.mjs, tested by surface.test.mjs, which public_api.sh runs first.
// A schema feature the walk does not follow ($ref, $defs) fails loudly instead
// of being skipped.
//
//   node surface.mjs <package name>

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  UnsupportedSchema,
  describe,
  findMismatches,
  walk,
} from "./surface-lib.mjs";

const pkg = process.argv[2];
if (!pkg) {
  console.error("usage: node surface.mjs <package name>");
  process.exit(64);
}
const { loadConfig } = await import(`${pkg}/dist/config.js`);
const { createServer } = await import(`${pkg}/dist/server.js`);
const { tools: registry } = await import(`${pkg}/dist/tools/index.js`);

/** tools/list over the SDK's in-memory transport, as scripts/smoke.ts does. */
async function listTools(env) {
  const server = createServer(loadConfig(env));
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client(
    { name: "prepublish-surface", version: "0.0.0" },
    { capabilities: {} },
  );
  await client.connect(clientTransport);
  try {
    const tools = [];
    let cursor;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  } finally {
    await client.close();
    await server.close();
  }
}

const lines = [];

const visible = await listTools({});
const all = await listTools({ NEXUS_EXCHANGE_ENABLE_ADMIN_TOOLS: "1" });
const visibleNames = new Set(visible.map((tool) => tool.name));
for (const tool of all) {
  const admin = visibleNames.has(tool.name) ? "" : " admin-only";
  lines.push(`tool ${tool.name} ${describe(tool.inputSchema)}${admin}`);
  try {
    walk(tool.inputSchema, `tool ${tool.name}`, lines);
  } catch (err) {
    if (!(err instanceof UnsupportedSchema)) throw err;
    console.error(
      `::error title=prepublish-surface (unsupported schema)::${err.message}. A field changed behind it would not move a line of public-api.txt, so teach scripts/release_gate/surface-lib.mjs to follow it before shipping one.`,
    );
    process.exit(1);
  }
}

// This file sits in the consumer's root, so this finds the installed package.
const root = dirname(
  createRequire(import.meta.url).resolve(`${pkg}/package.json`),
);

// The zod the package itself resolves, so the comparison uses the version its
// validators were built with.
const { z } = await import(
  pathToFileURL(createRequire(join(root, "package.json")).resolve("zod")).href
);
const mismatches = findMismatches(registry, z);
if (mismatches.length) {
  for (const line of mismatches) {
    console.error(
      `::error title=prepublish-surface (schema mismatch)::${line}. Make the tool's inputSchema and its zod schema in src/tools/index.ts agree.`,
    );
  }
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const bins =
  typeof manifest.bin === "string"
    ? { [manifest.name.split("/").pop()]: manifest.bin }
    : (manifest.bin ?? {});
for (const [name, target] of Object.entries(bins)) {
  let note = "";
  try {
    const head = readFileSync(join(root, target), "utf8").slice(0, 2);
    if (head !== "#!") note = " no-shebang";
  } catch {
    note = " missing";
  }
  lines.push(`bin ${name} ${target.replace(/^\.\//, "")}${note}`);
}

lines.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
process.stdout.write(`${lines.join("\n")}\n`);
