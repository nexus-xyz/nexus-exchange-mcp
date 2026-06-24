# Examples

Runnable examples for the Nexus Exchange MCP server. They help you understand
the server without wiring it into Claude Desktop or Claude Code.

## `list-markets.mjs`

A minimal standalone MCP client. It spawns the built server over stdio — the
same way a real MCP client launches it — connects, lists the available tools,
and calls `list_markets`, printing the results.

Build the server first, then run the example:

```bash
npm run build
node examples/list-markets.mjs
```

It calls the configured exchange gateway (production by default), so it needs
network access. See [`.env.example`](../.env.example) for the gateway
configuration the server reads from the environment.

For an in-process check that doesn't spawn a subprocess or require a build, see
`npm run smoke` ([`scripts/smoke.ts`](../scripts/smoke.ts)).
