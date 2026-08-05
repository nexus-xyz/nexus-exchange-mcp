# MCP's coverage unit

**Status:** decided, implemented. ENG-7788 (the unit) / ENG-7964 (the lifecycle).

## The decision

This server reports **two** numbers, and they are not interchangeable:

| Figure                      | What it counts                                                     | Comparable with the SDK rows?        |
| --------------------------- | ------------------------------------------------------------------ | ------------------------------------ |
| **Registered tools**        | Entries in the `tools` array — the agent-facing surface            | **No.** MCP-only axis.               |
| **Spec operations covered** | Distinct OpenAPI operations those tools call, from `endpoints.txt` | **Yes.** Same unit as rs / py / cli. |

The tool count is the headline, because a tool is what MCP actually ships and what
an agent actually sees. The operation count is the comparable figure, and it is
the only one that may appear in a cross-surface coverage table.

Today: **66 tools**, **63 spec operations** of the 98 the pinned spec documents.

## Why it needed deciding

Every other client surface has one obvious unit: a method wraps an operation, so
counting either gives the same answer. MCP does not.

- `cancel_order` calls **two** operations — `DELETE /api/v1/orders` (cancel-all)
  and `DELETE /api/v1/orders/{order_id}` — behind one tool, because an agent
  should not have to pick.
- `get_deposit_target` calls **none**. The endpoint does not exist server-side
  yet; the tool is registered so the agent flow is complete and returns an honest
  `not_yet_available` payload.
- Three `get_demo_*` tools call gateway sample routes that are not in the
  OpenAPI contract at all.

So "how many spec operations does MCP cover" had no answer until the mapping was
declared, and in the absence of one the tool count was being used as a stand-in:
a status report recorded _"mcp coverage 63/65 spec ops"_ where 63 was exactly the
number of registered tools. That is the failure this decision exists to stop —
not because 63 was wildly wrong, but because nothing connected it to the spec, so
nobody could tell.

## How it is enforced

The mapping is declared, not counted. Each `ToolDef` in `src/tools/index.ts`
carries an `ops` field naming the spec operations that tool calls:

```ts
{
  name: "cancel_order",
  ops: ["DELETE /api/v1/orders", "DELETE /api/v1/orders/{order_id}"],
  ...
}
```

The field is required by the type, so a new tool cannot be added without stating
what it calls. `scripts/check_spec_drift.py` then enforces three invariants on
every PR — including a spec-pin bump PR, which is the one that most needs them:

1. **manifest → spec** — every operation in `endpoints.txt` exists in the pinned
   spec. This is the direction `nexus-exchange-py` lacked, which is how five
   path-prefix typos survived in its manifest and understated its coverage by
   five operations for months.
2. **manifest == declarations** — `endpoints.txt` is regenerated from the `ops`
   declarations and compared byte-for-byte. It is an emitted artifact carrying a
   "generated, do not edit" header, so the number cannot be hand-adjusted and
   cannot fall behind a tool change.
3. **declarations == code** — each tool's declared `ops` equal what its handler
   actually requests, derived from its `client.request({...})` call sites.
   Checked **per tool**, not in aggregate: swapping two tools' operations leaves
   the aggregate set identical, so an aggregate check would stay green while the
   mapping — the whole point — was wrong.

Deliberate exceptions live in three named allowlists in that script
(`NON_SPEC_TARGETS`, `CODE_ONLY_OPS`, `TOOLS_WITHOUT_OPS`), each with a
stale-entry check so an exemption cannot quietly become permanent.
`scripts/test_check_spec_drift.py` defeats each invariant in turn and asserts the
checker goes red, so its green run means something.

## Reading the number honestly

**Never rank the tool count against the SDK rows.** 66 tools is not "more
coverage" than rs's 55 operations; they are different quantities. If a table has
one column, it is the operation count.

**The denominator double-counts.** The spec documents many operations twice —
once on the legacy gateway route (`/orders`) and once on the direct-indexer route
(`/api/v1/orders`, ENG-4947 / ENG-4740). This server calls whichever surface it
is meant to, so of the 35 operations it does not cover, **33 are the same route
reached through its counterpart** and only 2 are genuinely uncovered:

- `GET /stream` — deprecated SSE stream, superseded by the `/ws` upgrade.
- `GET /ws` — the WebSocket upgrade. MCP tool calls are request/response, so a
  long-lived subscription has nowhere to deliver to. The server covers the token
  operations instead (`POST /ws/token`, `POST /ws-tokens`) so an agent can hand a
  token to something that does speak WebSocket. Contrast rs, which lists
  `GET /ws` in its manifest because it really does open the socket.

That inflation applies equally to every surface measured this way, so the
cross-surface _comparison_ is sound even though each absolute percentage is
pessimistic. The checker prints the split on every run rather than leaving the
raw ratio to be misread.

## Where the number is published

`endpoints.txt` is in the standard `METHOD /path` format the monorepo collector
(`.github/scripts/collect-interfaces-metrics.py`) already parses for rs, py and
cli, so no format work is needed downstream. Moving MCP from that collector's
`API_COVERAGE_UNMEASURED` map into `API_COVERAGE_SURFACES` — and dropping the now
false `"no endpoints.txt / spec-drift tooling in nexus-exchange-mcp yet"` reason
string — is a one-line monorepo change, tracked with the dashboard prose that
spells out the tool-vs-operation distinction (ENG-7762 owns which dashboard is
current). Anywhere the figure renders must state its unit; that is the whole
reason this file exists.

## Adding a tool

1. Write the tool with its `ops` declaration. The type will not let you omit it.
2. Run the checks:
   ```sh
   npm run spec:drift          # fetches the pinned spec, verifies all invariants
   npm run spec:drift:write    # regenerate endpoints.txt after adding operations
   ```
3. Commit the regenerated `endpoints.txt` alongside the tool.

If the operation is not in the pinned spec yet, add it to `CODE_ONLY_OPS` with a
comment; the stale-entry check will tell you to remove it the moment the pin
catches up.
