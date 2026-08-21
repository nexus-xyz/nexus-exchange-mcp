#!/usr/bin/env python3
"""Verify the MCP server's declared spec coverage against the pinned OpenAPI spec
AND against the tool handlers that actually issue the requests.

WHY THIS EXISTS (ENG-7964 / ENG-7788)
-------------------------------------
Every other client surface answers "which spec operations do you implement?" from
a machine-readable `endpoints.txt` validated in CI. MCP had neither the file nor
the checker, and — worse — no defined *unit*: its natural unit is a registered
tool, and a tool is not an operation. `cancel_order` calls two operations, and
`get_deposit_target` calls none, so the registered-tool count and the covered-
operation count are different numbers. They were being conflated: a status report
recorded "mcp coverage 63/65 spec ops" when 63 was exactly the tool count.

So this repo declares the mapping instead of counting by hand. Each `ToolDef` in
src/tools/index.ts carries an `ops` list naming the spec operations that tool
calls; `endpoints.txt` is GENERATED from the union of those lists; and the three
invariants below make the declarations answerable to the code and to the spec.
docs/coverage-unit.md records the unit decision and what may be compared with
what.

INVARIANTS
----------
1. manifest -> spec
   Every operation in endpoints.txt exists in the pinned spec (.api-version). A
   miss means the spec renamed/removed an operation the server calls, or the
   manifest has a typo — py's manifest carried five path-prefix typos for months
   because nothing checked this direction (ENG-7958).

2. manifest == declarations
   endpoints.txt equals the union of the per-tool `ops` declarations, minus the
   one documented allowlist. The file is regenerated and compared byte-for-byte,
   so the manifest cannot be edited into fiction and cannot fall behind a tool
   change: it is an emitted artifact, not a hand-maintained list. `--write`
   regenerates it.

3. declarations == code
   For each tool, the declared `ops` equal the operations that tool's handler
   actually requests, derived from the `client.request({...})` call sites inside
   it. Presence-only checking is what lets a manifest drift into fiction, so this
   direction is enforced too, and it is enforced PER TOOL rather than in
   aggregate: a set-level comparison would stay green if two tools swapped
   operations, which would silently break the mapping this file exists to
   establish.

   Undercounting is the failure mode to be paranoid about — a checker reporting
   green over a real gap is worse than no checker — so every parser here fails
   LOUDLY rather than skipping something it does not understand:

     * a `client.request` call whose `path:` is not an inline string/template
       literal aborts the run (the parser cannot see a path built into a local
       variable first, and would silently drop the operation);
     * a `client.request` call outside any tool object aborts the run (it would
       be invisible to the per-tool comparison);
     * parsing zero tools, or a tool whose `ops` field cannot be read, aborts.

4. network map -> spec `servers`
   Every reachable network in src/networks.ts derives a gateway base that is a
   root `servers` entry in the pinned spec. The root list is NOT uniform — the
   public host carries `/api/exchange` and local development is the bare origin —
   so a checker that assumed one suffix for all of them is exactly how
   `NEXUS_EXCHANGE_NETWORK=local` came to derive `localhost:9090/api/exchange`,
   404ing every legacy route and handing `get_ws_token` a `ws_endpoint` nothing
   listens on. The map is hand-copied from the spec extension by design
   (networks.ts explains why), so this is the direction that keeps the copy
   honest. It lives here rather than in the TS unit tests because
   openapi.pinned.json is gitignored and fetched by this job alone.

ALLOWLISTS
----------
ONE named set holds the deliberate operation exceptions — an operation is only
kept out of endpoints.txt if it is in it:

  * NON_SPEC_TARGETS — called by a tool but outside the OpenAPI contract.

Plus TOOLS_WITHOUT_OPS, naming the tools that legitimately call no operation at
all. Every entry in both carries a stale-entry check so the lists cannot rot into
permanent exemptions.

CODE_ONLY_OPS is NOT an allowlist. It is a tripwire that must stay empty: any
entry aborts the run, in verify AND in --write, because an operation the contract
does not define must not be implemented at all (ENG-8616 / ENG-8619). See its
comment for the policy.

Usage:
  check_spec_drift.py <openapi.json>            # verify (CI)
  check_spec_drift.py <openapi.json> --write     # regenerate endpoints.txt
"""
import argparse
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
TOOLS_TS = os.path.join(REPO, "src", "tools", "index.ts")
MANIFEST = os.path.join(REPO, "endpoints.txt")

HTTP_METHODS = ("GET", "POST", "PUT", "PATCH", "DELETE")

# The default method when a `client.request({...})` call omits `method:` — see
# `RequestOptions` in src/client.ts, where it defaults to GET. Hard-coded rather
# than parsed, and asserted against the client source by check_client_contract()
# so this cannot quietly disagree with the client.
DEFAULT_METHOD = "GET"

# Called by a tool but NOT part of the OpenAPI contract, so deliberately kept OUT
# of endpoints.txt (listing them would fail invariant 1, and counting them would
# inflate a coverage number with operations the spec does not define).
#
# The `/demo/*` routes are gateway-hosted sample data behind the three
# `get_demo_*` tools: fixed fixtures for agents to exercise the tool shapes with
# no account and no credentials. They have never appeared in a released spec
# (checked back to v0.6.2) and are not intended to — they are a demo affordance,
# not API surface. The analogue is rs's NON_REST_TARGETS: targeted, real, and
# correctly absent from the contract manifest.
NON_SPEC_TARGETS = {
    ("GET", "/demo/account"),
    ("GET", "/demo/positions"),
    ("GET", "/demo/orders"),
}

# MUST STAY EMPTY. Any entry fails the run — see enforce_no_parked_ops().
#
# THE POLICY (ENG-8616, 2026-08-20; this surface is ENG-8619)
#   An endpoint the contract does not define must not be implemented. An
#   operation absent from the spec is DELETED from the tool, not parked here, and
#   it is implemented only once a PUBLISHED spec version defines it. There is no
#   attribution, no parking, and no release-lag exception: an SDK that wants an
#   operation waits for the tag that defines it. The cost is one release cycle.
#
# WHY THE MECHANISM ITSELF HAD TO GO, not just its entries
#   This set used to mean "implemented, but ahead of the pinned spec", and it
#   carried two rot checks: the operation stopped being called, or the pin caught
#   up. BOTH ONLY FIRE WHEN SOMETHING CHANGES. An operation that has never
#   appeared in any spec version — and never will — satisfies neither and sits
#   green forever. Across the fleet that is exactly what happened: four phantom
#   operations (`POST /account/margin-mode`, `POST /account/leverage`, transfers,
#   sub-accounts) survived several spec generations parked in the equivalent
#   lists, and the "move it out once the pin catches up" premise never once held
#   for any of them. Two softer proposals were rejected with them: attribution
#   (`op -> (caller, "ENG-XXXX")`), because a ticket reference beside a phantom
#   operation only makes it look sanctioned; and a carve-out for operations in
#   the monorepo spec but not yet in the pinned tag, because that IS the state
#   this rule exists to remove.
#
# WHY IT MATTERS HERE SPECIFICALLY
#   This package publishes to npm (ENG-6221), so a tool calling an uncontracted
#   route no longer just sits in a repo: it ships to real installs, where it
#   HMAC-signs a request at a path nothing serves and surfaces as an opaque 404
#   to an agent that has no way to tell "not built yet" from "your credentials
#   are wrong".
#
# WHAT TO DO INSTEAD, when the checker sends you here
#   Delete the operation from the tool. If the tool has no other operation it
#   becomes a TOOLS_WITHOUT_OPS entry or it goes too. If the route exists but is
#   undocumented, the fix is upstream — document it in nexus-exchange-api and
#   bump `.api-version` to the release that carries it (spec-autobump.yml opens
#   that PR). If it is genuinely outside the contract and always will be, it is a
#   NON_SPEC_TARGETS candidate: that set is for routes nobody intends to
#   document, like the `/demo/*` fixtures, and it is argued case by case — not a
#   second door into this one.
CODE_ONLY_OPS = set()

# Tools that call no spec operation at all. `ops: []` is a legitimate
# declaration, but an empty list is also what a forgotten declaration looks
# like, so each one must be named here with its reason.
#
#   get_deposit_target — describes a deposit-address capability that is not built
#     server-side yet. It is wired up so the agent flow is complete and returns an
#     honest "not_yet_available" payload from a local constant; it issues no
#     upstream request. When the endpoint ships, this tool gains a real `ops`
#     declaration and comes off this list.
TOOLS_WITHOUT_OPS = {
    "get_deposit_target",
}

# Spec operations this server deliberately does not target. They show up in the
# informational "genuinely not covered" list at the end of a run, and that is
# correct — documented here so the exclusion reads as a decision rather than an
# oversight. Unlike the allowlist above these need no entry in any set: nothing
# claims them, so nothing can go stale.
#
#   GET /stream — the deprecated SSE stream, superseded by the /ws upgrade.
#   GET /ws     — the WebSocket upgrade itself. This server has no WS client and
#     is not the right place for one: MCP tool calls are request/response, so a
#     long-lived subscription has nowhere to deliver to. It covers the adjacent
#     token operations instead (POST /ws/token, POST /ws-tokens) so an agent can
#     hand a token to something that *does* speak WS. Contrast rs, which lists
#     GET /ws in its manifest under NON_REST_TARGETS because it really does open
#     the socket.

# The v1 prefix of the dual-stack routing surface (ENG-4947 / gateway elimination
# ENG-4740). The pinned spec documents many operations TWICE — once on the legacy
# gateway route (`/orders`) and once on the direct-indexer route
# (`/api/v1/orders`) — so a raw "covered / total" ratio double-counts the
# denominator. The server calls whichever surface it is meant to; report_coverage()
# separates "uncovered because we use the other surface" from genuinely uncovered
# so the informational output cannot be misread as a gap.
V1_PREFIX = "/api/v1"


def fail(msg):
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def normalize_path(p):
    """Collapse every path placeholder to a bare `{}` so paths compare by shape,
    not by placeholder spelling: a handler's `${encodeURIComponent(market_id)}`,
    a declaration's `{market_id}` and a spec path's `{marketId}` are the same
    operation. Comparison is positional."""
    return re.sub(r"\$\{[^}]*\}|\{[^}]*\}", "{}", p)


def norm_op(op):
    method, path = op
    return (method, normalize_path(path))


def parse_op_string(text, where):
    """Parse a declared `"METHOD /path"` string into a (METHOD, path) tuple."""
    parts = text.split()
    if len(parts) != 2 or parts[0].upper() not in HTTP_METHODS:
        fail(
            f"{where}: expected an op declaration of the form "
            f"'METHOD /path' (METHOD one of {', '.join(HTTP_METHODS)}), "
            f"got {text!r}"
        )
    method, path = parts[0].upper(), parts[1]
    if not path.startswith("/"):
        fail(f"{where}: op path must start with '/', got {path!r}")
    return (method, path)


# --- TypeScript source scanning ----------------------------------------------
#
# A hand-rolled scanner rather than a regex sweep, for one reason: the failure
# mode that matters is *undercounting*. A regex that misses a call site reports
# green over a gap. The scanner below tracks string/template/comment state so it
# knows what it has and has not accounted for, and every branch it cannot account
# for exits non-zero.

_STRING_DELIMS = "\"'`"


def _spans_to_skip(src):
    """Yield (start, end) spans of src that are string literals or comments.

    Template literals are yielded as a single span even when they contain
    `${...}` interpolations: the paths in this file interpolate only encoded
    argument values, never structure, so the whole literal is opaque here and
    normalize_path() collapses the interpolations later."""
    i, n = 0, len(src)
    while i < n:
        c = src[i]
        if c == "/" and i + 1 < n and src[i + 1] == "/":
            j = src.find("\n", i)
            j = n if j < 0 else j
            yield (i, j)
            i = j
        elif c == "/" and i + 1 < n and src[i + 1] == "*":
            j = src.find("*/", i + 2)
            j = n if j < 0 else j + 2
            yield (i, j)
            i = j
        elif c in _STRING_DELIMS:
            j = i + 1
            while j < n:
                if src[j] == "\\":
                    j += 2
                    continue
                if src[j] == c:
                    j += 1
                    break
                j += 1
            else:
                fail(f"unterminated {c} literal at offset {i} in {TOOLS_TS}")
            yield (i, j)
            i = j
        else:
            i += 1


def _blank_out(src):
    """Return src with every string literal and comment replaced by spaces of the
    same length, so structural scanning (brace matching, key finding) can never be
    confused by a brace or a `path:` inside prose or inside a string. Offsets are
    preserved, so a match in the blanked copy indexes the real source."""
    out = list(src)
    for start, end in _spans_to_skip(src):
        for k in range(start, end):
            if out[k] != "\n":  # keep line structure for line numbers
                out[k] = " "
    return "".join(out)


def _match_bracket(src, start, open_ch, close_ch, blanked):
    """Return the index just past the bracket pair opening at `start`. `blanked`
    is the string-and-comment-blanked copy used for depth counting."""
    depth = 0
    for j in range(start, len(src)):
        c = blanked[j]
        if c == open_ch:
            depth += 1
        elif c == close_ch:
            depth -= 1
            if depth == 0:
                return j + 1
    fail(f"unterminated {open_ch}{close_ch} starting at offset {start} in {TOOLS_TS}")


def _lineno(src, offset):
    return src.count("\n", 0, offset) + 1


# The tools array. Anchored on the exported declaration so the scan cannot wander
# into an unrelated array literal, and a rename fails loudly instead of silently
# finding nothing.
_TOOLS_ARRAY_RE = re.compile(r"export\s+const\s+tools\s*:\s*ToolDef\[\]\s*=\s*\[")

# Object-literal keys the scanner reads. Every one of these is matched against the
# BLANKED copy (so a key name occurring inside prose or a string cannot match) and
# its value is then read from the real source.
_NAME_KEY_RE = re.compile(r"\bname\s*:")
_OPS_KEY_RE = re.compile(r"\bops\s*:\s*\[")
_PATH_KEY_RE = re.compile(r"\bpath\s*:")
_METHOD_KEY_RE = re.compile(r"\bmethod\s*:")
# The call shapes that issue an upstream request, and therefore attribute an
# operation to the tool they sit in.
#
#   1. `client.request(` with an optional type argument, e.g. `client.request<Foo>(`.
#   2. `fetchPage(client, <cursor>, {` — the paginating wrapper (ENG-7424).
#
# Why the wrapper is matched at its CALL SITES rather than at its delegate: the
# body of `fetchPage` calls `client.requestPage(opts)`, forwarding an options
# object it received as a parameter. Matching that would trip the
# "no inline options object" failure below every time, because the literal is at
# the call site, not in the wrapper. Matching `fetchPage(client,` puts the
# scanner where the `path:` literal actually is, so the existing `path:`/`method:`
# extraction works unchanged and the five paginated list tools attribute their
# operations again.
#
# `\s*,` after `client` is what keeps the wrapper's own DEFINITION from matching:
# there the first parameter reads `client: ExchangeClient,`, so the comma does not
# immediately follow. A definition counted as a call site would break the
# total-sites guard, since it sits outside every tool object.
#
# Note `client.requestPage(` does not match alternative 1 — `Page` intervenes
# before the paren — which is deliberate. The only recognised way to reach it is
# through the wrapper.
_REQUEST_RE = re.compile(
    r"\bclient\s*\.\s*request\s*(?:<[^()]*>)?\s*\(" r"|\bfetchPage\s*\(\s*client\s*,"
)


def _find_key_at_depth1(blanked, src, open_at, close_at, key_re):
    """Find `key_re` at depth 1 of the literal opening at `open_at` (i.e. a key of
    this object, not of a nested one). Returns the match, or None.

    Depth matters: `inputSchema` nests JSON-Schema objects that can carry a
    property literally called `name` or `path`, and a flat search could pick one of
    those up if the ToolDef keys were ever reordered. Restricting to depth 1 makes
    the scan independent of key order."""
    depth = 0
    j = open_at
    while j < close_at:
        c = blanked[j]
        if c in "{[":
            depth += 1
            if depth > 1:
                j = _match_bracket(src, j, c, "}" if c == "{" else "]", blanked)
                depth -= 1
                continue
        elif c in "}]":
            depth -= 1
        elif depth == 1:
            m = key_re.match(blanked, j)
            if m:
                return m
        j += 1
    return None


def _read_string_literal(src, pos):
    """Read the string or template literal starting at the first non-space
    character at/after `pos`. Returns (contents, end_offset), or (None, pos) if
    what is there is not a literal — the caller turns that into a loud failure."""
    while pos < len(src) and src[pos] in " \t\n\r":
        pos += 1
    if pos >= len(src) or src[pos] not in "\"'`":
        return None, pos
    delim = src[pos]
    j = pos + 1
    buf = []
    while j < len(src):
        if src[j] == "\\":
            buf.append(src[j : j + 2])
            j += 2
            continue
        if src[j] == delim:
            return "".join(buf), j + 1
        buf.append(src[j])
        j += 1
    fail(f"unterminated {delim} literal at offset {pos} in {TOOLS_TS}")


def _request_ops(src, blanked, start, end, tool):
    """Derive the operations a tool's handler requests, from the
    `client.request({...})` call sites between `start` and `end`.

    Every call site must pass `path:` as an inline string or template literal. A
    path assembled into a variable first is invisible to this scanner and would
    silently drop the operation, so it aborts the run rather than undercounting.
    Returns (ops, n_call_sites)."""
    ops = []
    sites = 0
    for m in _REQUEST_RE.finditer(blanked, start, end):
        sites += 1
        open_brace = blanked.find("{", m.end())
        if open_brace < 0 or open_brace > end:
            fail(
                f"{TOOLS_TS}:{_lineno(src, m.start())}: tool {tool!r} calls "
                f"client.request() with no inline options object; the drift "
                f"scanner reads `path:` out of that literal, so an options object "
                f"built elsewhere would drop the operation silently. Inline it."
            )
        close = _match_bracket(src, open_brace, "{", "}", blanked)

        # Keys are located in the blanked copy so a `path:` inside the nested body
        # object, or inside prose, cannot be mistaken for the request path.
        pm = _find_key_at_depth1(blanked, src, open_brace, close, _PATH_KEY_RE)
        path_at = pm.end() if pm else None
        mm = _find_key_at_depth1(blanked, src, open_brace, close, _METHOD_KEY_RE)
        method = None
        if mm:
            method, _ = _read_string_literal(src, mm.end())
            if method is None:
                fail(
                    f"{TOOLS_TS}:{_lineno(src, mm.end())}: tool {tool!r} passes a "
                    f"non-literal `method:` to client.request(); the scanner "
                    f"cannot attribute the operation. Inline the method literal."
                )

        if path_at is None:
            fail(
                f"{TOOLS_TS}:{_lineno(src, m.start())}: tool {tool!r} calls "
                f"client.request() with no `path:` key in its options object. "
                f"Every request must name its path inline — update the tool or "
                f"the scanner."
            )
        literal, _ = _read_string_literal(src, path_at)
        if literal is None:
            fail(
                f"{TOOLS_TS}:{_lineno(src, path_at)}: tool {tool!r} passes a "
                f"non-literal `path:` to client.request(). The drift scanner only "
                f"sees inline \"...\" / `...` paths; a path built into a variable "
                f"first would be silently uncounted, undercounting the operations "
                f"this tool covers. Inline the path literal at the call site."
            )
        if not literal.startswith("/"):
            fail(
                f"{TOOLS_TS}:{_lineno(src, path_at)}: tool {tool!r} has a `path:` "
                f"that does not start with '/': {literal!r}"
            )
        if method is not None and method not in HTTP_METHODS:
            fail(
                f"{TOOLS_TS}:{_lineno(src, m.start())}: tool {tool!r} uses an "
                f"unrecognized method {method!r}; extend HTTP_METHODS."
            )
        ops.append((method or DEFAULT_METHOD, literal))
    return ops, sites


def parse_tools(path=TOOLS_TS):
    """Return [{name, declared, requested, lineno}] for every tool in the
    `tools` array of src/tools/index.ts.

    Fails closed on anything it cannot account for: a missing/renamed array, zero
    tools, a tool without a readable `ops` declaration, or a `client.request` call
    site outside any tool object (which the per-tool comparison would never see).
    """
    try:
        with open(path) as f:
            src = f.read()
    except OSError as e:
        fail(f"cannot read tool source {path!r}: {e}")

    blanked = _blank_out(src)

    am = _TOOLS_ARRAY_RE.search(blanked)
    if not am:
        fail(
            f"could not find `export const tools: ToolDef[] = [` in {path}; the "
            f"tool registry moved or was renamed — update _TOOLS_ARRAY_RE."
        )
    # The regex ends on the array's own `[`, so take it from the match end — the
    # first `[` after the match START is the one in `ToolDef[]`.
    arr_open = am.end() - 1
    arr_end = _match_bracket(src, arr_open, "[", "]", blanked)

    # Object literals at depth 1 of the array are the tool definitions.
    tools = []
    j = arr_open + 1
    while j < arr_end - 1:
        if blanked[j] == "{":
            obj_end = _match_bracket(src, j, "{", "}", blanked)
            nm = _find_key_at_depth1(blanked, src, j, obj_end, _NAME_KEY_RE)
            if not nm:
                fail(
                    f"{path}:{_lineno(src, j)}: a tool object has no `name:` key; "
                    f"the ToolDef shape changed — update the scanner."
                )
            name, _ = _read_string_literal(src, nm.end())
            if name is None:
                fail(
                    f"{path}:{_lineno(src, nm.end())}: a tool's `name:` is not a "
                    f"string literal; the ToolDef shape changed."
                )

            om = _find_key_at_depth1(blanked, src, j, obj_end, _OPS_KEY_RE)
            if not om:
                fail(
                    f"{path}:{_lineno(src, j)}: tool {name!r} has no `ops:` "
                    f"declaration. Every tool must declare the spec operations it "
                    f"calls (`ops: []` if none, and then list the tool in "
                    f"TOOLS_WITHOUT_OPS) — see docs/coverage-unit.md."
                )
            ops_open = om.end() - 1  # the `[` the key regex ends on
            ops_end = _match_bracket(src, ops_open, "[", "]", blanked)
            declared = []
            k = ops_open + 1
            while k < ops_end - 1:
                if src[k] in "\"'`":
                    text, k2 = _read_string_literal(src, k)
                    declared.append(
                        parse_op_string(
                            text, f"{path}:{_lineno(src, k)} (tool {name!r})"
                        )
                    )
                    k = k2
                    continue
                k += 1

            requested, sites = _request_ops(src, blanked, j, obj_end, name)
            tools.append(
                {
                    "name": name,
                    "declared": declared,
                    "requested": requested,
                    "sites": sites,
                    "lineno": _lineno(src, j),
                }
            )
            j = obj_end
            continue
        j += 1

    if not tools:
        fail(
            f"parsed zero tools from {path}; the ToolDef object shape changed — "
            f"update the scanner rather than trusting an empty result."
        )

    names = [t["name"] for t in tools]
    dupes = sorted({n for n in names if names.count(n) > 1})
    if dupes:
        fail(f"{path}: duplicate tool name(s): {', '.join(dupes)}")

    # Nothing may issue an upstream request outside a tool object: such a call
    # would be invisible to the per-tool comparison, which is exactly the
    # undercount this checker exists to prevent.
    total_sites = sum(1 for _ in _REQUEST_RE.finditer(blanked))
    counted = sum(t["sites"] for t in tools)
    if total_sites != counted:
        fail(
            f"{path}: {total_sites} client.request() call site(s) but only "
            f"{counted} inside a tool object. A request issued from a helper "
            f"outside the `tools` array is invisible to the per-tool check — move "
            f"it into a tool handler, or extend the scanner to attribute it."
        )
    return tools


def check_client_contract():
    """Assert the client still defaults an omitted `method:` to DEFAULT_METHOD.

    Invariant 3 attributes a method to every call site, and most call sites omit
    `method:` because they are reads. If the client's default ever changed, every
    one of those would be attributed to the wrong operation while this checker
    reported green — so the assumption is verified against the source instead of
    being trusted."""
    client_ts = os.path.join(REPO, "src", "client.ts")
    try:
        with open(client_ts) as f:
            src = f.read()
    except OSError as e:
        fail(f"cannot read client source {client_ts!r}: {e}")
    m = re.search(r"opts\.method\s*\?\?\s*\"([A-Z]+)\"", src)
    if not m:
        fail(
            f"could not find the `opts.method ?? \"...\"` default in {client_ts}; "
            f"the drift check attributes a method to every request call site and "
            f"relies on that default — re-derive DEFAULT_METHOD and update this "
            f"guard."
        )
    if m.group(1) != DEFAULT_METHOD:
        fail(
            f"{client_ts} defaults an omitted request method to {m.group(1)!r}, "
            f"but this checker assumes {DEFAULT_METHOD!r}. Every call site that "
            f"omits `method:` is being attributed to the wrong operation — update "
            f"DEFAULT_METHOD."
        )


NETWORKS_TS = os.path.join(REPO, "src", "networks.ts")

# `<id>: Object.freeze({ … }),` inside the NETWORKS map, at prettier's indent.
_NETWORK_BLOCK_RE = re.compile(
    r"\n {4}(?P<id>\w+): Object\.freeze\(\{(?P<body>.*?)\n {4}\}\),", re.S
)
_BASE_URL_RE = re.compile(r"\n\s*baseUrl:\s*(?:null|\"(?P<url>[^\"]*)\")\s*,")
_GATEWAY_PATH_RE = re.compile(r"\n\s*gatewayPath:\s*\"(?P<path>[^\"]*)\"\s*,")
_NETWORK_IDS_RE = re.compile(r"NETWORK_IDS = \[(?P<body>[^\]]*)\] as const")


def parse_networks():
    """Read the network -> target map out of src/networks.ts.

    Fails loudly rather than skipping anything it cannot parse: a network this
    function silently dropped would be a network the spec never checked, which is
    the failure mode this whole file is written against."""
    try:
        with open(NETWORKS_TS) as f:
            src = f.read()
    except OSError as e:
        fail(f"cannot read network map {NETWORKS_TS!r}: {e}")

    m = _NETWORK_IDS_RE.search(src)
    if not m:
        fail(
            f"could not find `NETWORK_IDS = [...] as const` in {NETWORKS_TS}; the "
            f"network axis check cannot confirm it saw every network."
        )
    declared = set(re.findall(r"\"([^\"]+)\"", m.group("body")))
    if not declared:
        fail(f"NETWORK_IDS in {NETWORKS_TS} parsed as empty.")

    found = {}
    for block in _NETWORK_BLOCK_RE.finditer(src):
        nid, body = block.group("id"), block.group("body")
        if nid not in declared:
            continue  # not a network entry (NETWORKS is the only such map today)
        base = _BASE_URL_RE.search(body)
        if not base:
            fail(
                f"network {nid!r} in {NETWORKS_TS} has no parseable `baseUrl:` "
                f"(expected a string literal or null)."
            )
        gateway = _GATEWAY_PATH_RE.search(body)
        if not gateway:
            fail(
                f"network {nid!r} in {NETWORKS_TS} has no parseable "
                f"`gatewayPath:` string literal; it must say explicitly whether "
                f"the legacy surface hangs off `/api/exchange` or the bare origin."
            )
        found[nid] = (base.group("url"), gateway.group("path"))

    missing = declared - set(found)
    if missing:
        fail(
            f"{NETWORKS_TS} declares {sorted(declared)} in NETWORK_IDS but no "
            f"descriptor could be parsed for {sorted(missing)} — the parser is out "
            f"of step with the source, so an unchecked network could slip through."
        )
    return found


def check_network_gateway_bases(spec):
    """Invariant 4: each reachable network's gateway base is a spec root server."""
    servers = spec.get("servers") or []
    roots = {
        s["url"].rstrip("/")
        for s in servers
        if isinstance(s, dict) and "url" in s
    }
    if not roots:
        fail(
            "the pinned spec declares no root `servers`; the network axis check "
            "cannot verify any gateway base against it."
        )

    failures = 0
    for nid, (base, gateway_path) in sorted(parse_networks().items()):
        if base is None:
            continue  # no reachable host yet (mainnet) — nothing is built for it
        derived = re.sub(r"/api/exchange$", "", base.rstrip("/")) + gateway_path
        if derived not in roots:
            failures += 1
            print(
                f"FAIL invariant 4: network {nid!r} derives gateway base "
                f"{derived!r}, which is not a root server in the pinned spec.\n"
                f"  spec root servers: {', '.join(sorted(roots))}\n"
                f"  Fix `gatewayPath` for {nid} in src/networks.ts (the public "
                f"host carries /api/exchange; local development is the bare "
                f"origin), or update the map if the spec moved the host.",
                file=sys.stderr,
            )
    if not failures:
        print(
            "OK: every reachable network derives a gateway base that is a root "
            "server in the pinned spec."
        )
    return failures


def spec_ops(spec):
    ops = set()
    for path, methods in spec.get("paths", {}).items():
        for m in methods:
            if m.upper() in HTTP_METHODS:
                ops.add((m.upper(), path))
    if not ops:
        fail("the pinned spec declares zero operations; is this an OpenAPI document?")
    return ops


# --- endpoints.txt ------------------------------------------------------------

MANIFEST_HEADER = """\
# GENERATED FILE — do not edit by hand.
#
# Regenerate with:  python3 scripts/check_spec_drift.py openapi.pinned.json --write
#
# The Exchange API spec operations this MCP server covers, emitted from the
# per-tool `ops` declarations in src/tools/index.ts and verified against the
# pinned spec (.api-version) by scripts/check_spec_drift.py on every PR.
#
# THE UNIT (read this before comparing the number to anything)
#   MCP's own unit of work is a registered TOOL; this file counts spec
#   OPERATIONS. They are different numbers and neither substitutes for the other:
#   one tool can call several operations (`cancel_order` calls two), and one calls
#   none. The operation count below is the figure that is comparable with the
#   rs / py / cli manifests. The tool count is not, and must never be reported as
#   a coverage figure. See docs/coverage-unit.md.
#
#   Denominator caveat: the spec documents many operations twice — once on the
#   legacy gateway route (`/orders`) and once on the direct-indexer route
#   (`/api/v1/orders`, ENG-4947). This server targets whichever surface it is
#   meant to, so a raw covered/total ratio understates coverage for every surface
#   equally. The checker prints the split.
#
# One documented allowlist in scripts/check_spec_drift.py holds operations a tool
# calls that are deliberately absent here — NON_SPEC_TARGETS, for routes outside
# the OpenAPI contract that nobody intends to document (the `/demo/*` fixtures).
# Adding one to this file would fail the manifest -> spec check.
#
# There is no "ahead of the pinned spec" exception: an operation the contract does
# not define is not implemented at all, so it never reaches this file
# (ENG-8616/ENG-8619).
#
# Format: METHOD /path, one per line, path spelled exactly as the spec spells it.
"""


def render_manifest(ops):
    lines = [MANIFEST_HEADER]
    for method, path in sorted(ops, key=lambda o: (o[1], o[0])):
        lines.append(f"{method} {path}")
    return "\n".join(lines).rstrip("\n") + "\n"


def load_manifest(path=MANIFEST):
    try:
        with open(path) as f:
            text = f.read()
    except OSError as e:
        fail(
            f"cannot read {path!r}: {e}. It is generated — run "
            f"`python3 scripts/check_spec_drift.py <spec> --write`."
        )
    return parse_manifest_text(text, path), text


def parse_manifest_text(text, path=MANIFEST):
    """Parse manifest lines out of `text`. Separate from load_manifest so a caller
    holding the text can report on exactly that text rather than re-reading the
    file — which would describe a different document than the one it checked."""
    ops = []
    seen = {}
    for lineno, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        op = parse_op_string(line, f"{path}:{lineno}")
        if op in seen:
            fail(
                f"{path}:{lineno}: duplicate operation {op[0]} {op[1]} "
                f"(first seen on line {seen[op]})"
            )
        seen[op] = lineno
        ops.append(op)
    if not ops:
        fail(f"{path} lists zero operations; regenerate it with --write.")
    return ops


# --- invariants ---------------------------------------------------------------


def declared_manifest_ops(tools):
    """The operation set endpoints.txt should contain: every declared op, minus
    the one documented allowlist.

    CODE_ONLY_OPS is deliberately NOT subtracted here, even though it is empty
    and subtracting an empty set would be a no-op. Subtracting it is what
    *implemented* parking: it is the step that hid an uncontracted operation from
    the manifest and let invariant 1 pass over it. With the subtraction gone
    there is no code path by which an entry can launder an operation out of
    endpoints.txt — so if enforce_no_parked_ops() were ever deleted, an entry
    would still land the operation in the manifest and fail invariant 1 against
    the spec, loudly, instead of going quiet."""
    declared = set()
    for t in tools:
        declared |= set(t["declared"])
    return declared - NON_SPEC_TARGETS


def check_declarations_vs_code(tools):
    """Invariant 3: per tool, declared ops == ops the handler requests. Returns
    the number of errors printed."""
    errors = 0
    for t in tools:
        declared = {norm_op(o) for o in t["declared"]}
        requested = {norm_op(o) for o in t["requested"]}
        undeclared = sorted(requested - declared)
        unrequested = sorted(declared - requested)
        if undeclared:
            errors += len(undeclared)
            print(
                f"\nERROR: tool {t['name']!r} "
                f"({os.path.relpath(TOOLS_TS, REPO)}:{t['lineno']}) requests "
                f"{len(undeclared)} operation(s) it does not declare in `ops` "
                f"(add them, spelled as the spec spells the path):"
            )
            for m, p in undeclared:
                print(f"  - {m} {p}")
        if unrequested:
            errors += len(unrequested)
            print(
                f"\nERROR: tool {t['name']!r} "
                f"({os.path.relpath(TOOLS_TS, REPO)}:{t['lineno']}) declares "
                f"{len(unrequested)} operation(s) its handler never requests "
                f"(remove them, or fix the handler):"
            )
            for m, p in unrequested:
                print(f"  - {m} {p}")

        if not t["declared"] and t["name"] not in TOOLS_WITHOUT_OPS:
            errors += 1
            print(
                f"\nERROR: tool {t['name']!r} declares no operations "
                f"(`ops: []`) but is not listed in TOOLS_WITHOUT_OPS. Either "
                f"declare what it calls, or add it to that allowlist with the "
                f"reason it calls nothing."
            )

    by_name = {t["name"]: t for t in tools}
    for name in sorted(TOOLS_WITHOUT_OPS):
        t = by_name.get(name)
        if t is None:
            errors += 1
            print(
                f"\nERROR: TOOLS_WITHOUT_OPS names {name!r}, which is not a "
                f"registered tool (renamed or removed?); update the allowlist."
            )
        elif t["declared"]:
            errors += 1
            print(
                f"\nERROR: TOOLS_WITHOUT_OPS names {name!r}, but it now declares "
                f"{len(t['declared'])} operation(s); remove it from the allowlist."
            )

    if not errors:
        n_ops = sum(len(t["declared"]) for t in tools)
        print(
            f"\nOK: all {len(tools)} tool(s) declare exactly the operations their "
            f"handlers request ({n_ops} declaration(s) across "
            f"{len({norm_op(o) for t in tools for o in t['declared']})} distinct "
            f"operation(s))."
        )
    return errors


def enforce_no_parked_ops():
    """CODE_ONLY_OPS must be empty. Any entry aborts the run.

    An abort rather than an error count, and it runs BEFORE the --write branch,
    for two reasons:

      * `--write` would otherwise be the dangerous mode. It emits endpoints.txt
        from the declarations and never consults the spec, so with a parked
        operation it would write a manifest that silently omits it — a lie
        committed to disk before anyone runs the verify pass that would object.
      * This is a policy violation, not a drift measurement. Every number a run
        prints is downstream of "which operations may exist at all", so there is
        nothing useful to report alongside it; deciding the entry is the only
        next step.
    """
    if CODE_ONLY_OPS:
        listed = "\n".join(f"  - {m} {p}" for m, p in sorted(CODE_ONLY_OPS))
        fail(
            f"CODE_ONLY_OPS has {len(CODE_ONLY_OPS)} entr(ies), and it must be "
            f"empty:\n{listed}\n"
            f"An operation the contract does not define must not be implemented "
            f"(ENG-8616/ENG-8619). Operations are not parked here — they are "
            f"deleted from the tool, and implemented once a PUBLISHED spec "
            f"version defines them. If the route exists but is undocumented, "
            f"document it in nexus-exchange-api and bump .api-version to the "
            f"release that carries it. If it is outside the contract for good, "
            f"argue it into NON_SPEC_TARGETS instead. See the policy comment on "
            f"CODE_ONLY_OPS in this file."
        )
    print(
        "\nOK: no operations parked ahead of the spec (CODE_ONLY_OPS is empty, "
        "as the policy requires)."
    )


def check_allowlists(tools, available):
    """Stale-entry checks for the operation allowlist: an entry no tool calls any
    more, or one the pinned spec now defines, is a lie the manifest is built on.
    Returns the number of errors printed.

    NON_SPEC_TARGETS only. CODE_ONLY_OPS is not checked for staleness because it
    cannot hold an entry to go stale (enforce_no_parked_ops), and because
    staleness was never the failure mode that mattered: the operation that has
    never been in any spec and never will be is stale by no definition these
    checks can express, which is precisely how the fleet's phantoms survived."""
    requested = {norm_op(o) for t in tools for o in t["requested"]}
    available_norm = {norm_op(o) for o in available}
    errors = 0

    # One entry since CODE_ONLY_OPS stopped being an allowlist. Kept as a loop
    # rather than inlined: the per-allowlist message is the part that differs,
    # and the next allowlist — if one is ever argued for — should have to supply
    # one rather than inherit NON_SPEC_TARGETS' wording.
    for label, entries, now_in_spec_msg in (
        (
            "NON_SPEC_TARGETS",
            NON_SPEC_TARGETS,
            "the pinned spec now defines it — move it into the manifest by "
            "removing it from the allowlist",
        ),
    ):
        stale = sorted(e for e in entries if norm_op(e) not in requested)
        if stale:
            errors += len(stale)
            print(
                f"\nERROR: {len(stale)} {label} entr(ies) are no longer requested "
                f"by any tool (remove them from the allowlist):"
            )
            for m, p in stale:
                print(f"  - {m} {p}")
        landed = sorted(e for e in entries if norm_op(e) in available_norm)
        if landed:
            errors += len(landed)
            print(
                f"\nERROR: {len(landed)} {label} entr(ies) are in the pinned spec; "
                f"{now_in_spec_msg}:"
            )
            for m, p in landed:
                print(f"  - {m} {p}")

    if not errors:
        print(
            f"\nOK: the operation allowlist is current "
            f"({len(NON_SPEC_TARGETS)} NON_SPEC_TARGETS)."
        )
    return errors


def check_manifest_vs_spec(manifest, available):
    """Invariant 1: every manifest operation exists in the pinned spec."""
    missing = [op for op in manifest if op not in available]
    if missing:
        print(
            f"\nERROR: {len(missing)} operation(s) in endpoints.txt are NOT in the "
            f"pinned spec (removed, renamed, or a path typo — check the prefix):"
        )
        for m, p in missing:
            print(f"  - {m} {p}")
        return len(missing)
    print(
        f"\nOK: all {len(manifest)} operation(s) in endpoints.txt exist in the "
        f"pinned spec."
    )
    return 0


def check_manifest_is_generated(tools, text):
    """Invariant 2: endpoints.txt is byte-identical to what the declarations
    generate, so it is an emitted artifact rather than a hand-maintained list."""
    expected = render_manifest(declared_manifest_ops(tools))
    if text == expected:
        print(
            "\nOK: endpoints.txt matches the per-tool `ops` declarations exactly "
            "(generated, not hand-maintained)."
        )
        return 0
    have = set(parse_manifest_text(text))
    want = declared_manifest_ops(tools)
    print(
        "\nERROR: endpoints.txt does not match the per-tool `ops` declarations. "
        "It is a generated file — run:\n"
        "  python3 scripts/check_spec_drift.py openapi.pinned.json --write"
    )
    for label, delta in (
        ("declared but missing from endpoints.txt", sorted(want - have)),
        ("in endpoints.txt but declared by no tool", sorted(have - want)),
    ):
        if delta:
            print(f"\n  {len(delta)} {label}:")
            for m, p in delta:
                print(f"    - {m} {p}")
    if not (want - have) and not (have - want):
        print(
            "\n  The operation sets agree, so only the file's formatting or "
            "header text differs — regenerating fixes it."
        )
    return 1


def report_coverage(tools, manifest, available, version):
    """Print the coverage figures, always labelled with their unit, and split the
    uncovered operations so the informational list cannot be misread."""
    covered = set(manifest)
    uncovered = available - covered
    # An operation is "the other surface" when this server covers the same route
    # on the dual-stack v1 prefix instead (or vice versa).
    twins, real = set(), set()
    for method, path in uncovered:
        if path.startswith(V1_PREFIX + "/"):
            other = (method, path[len(V1_PREFIX) :])
        else:
            other = (method, V1_PREFIX + path)
        (twins if other in covered else real).add((method, path))

    n_tools = len(tools)
    print(f"\nSpec version: {version}")
    print(f"Registered tools: {n_tools}  (MCP's own unit — NOT an operation count)")
    print(
        f"Spec operations covered: {len(covered)} of {len(available)} documented "
        f"({100.0 * len(covered) / len(available):.1f}%) — the figure comparable "
        f"with the rs / py / cli manifests"
    )
    print(
        f"  of the {len(uncovered)} not covered, {len(twins)} are the same route "
        f"on the other dual-stack surface (covered via its counterpart) and "
        f"{len(real)} are genuinely uncovered"
    )
    if real:
        print(f"\nGenuinely not covered by this server ({len(real)}):")
        for m, p in sorted(real):
            print(f"  - {m} {p}")
    if twins:
        print(
            f"\nCovered on the other dual-stack surface ({len(twins)}, "
            f"informational):"
        )
        for m, p in sorted(twins):
            print(f"  - {m} {p}")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("spec", metavar="openapi.json", help="the pinned OpenAPI spec")
    ap.add_argument(
        "--write",
        action="store_true",
        help="regenerate endpoints.txt from the per-tool declarations",
    )
    args = ap.parse_args()

    try:
        with open(args.spec) as f:
            spec = json.load(f)
    except OSError as e:
        fail(f"cannot read spec {args.spec!r}: {e}")
    except json.JSONDecodeError as e:
        fail(f"{args.spec} is not valid JSON: {e}")

    version = spec.get("info", {}).get("version", "?")
    available = spec_ops(spec)

    # Before anything is emitted or measured: an operation the contract does not
    # define must not exist in the first place, and --write must not be able to
    # emit a manifest that omits one.
    enforce_no_parked_ops()

    check_client_contract()
    tools = parse_tools()

    if args.write:
        ops = declared_manifest_ops(tools)
        with open(MANIFEST, "w") as f:
            f.write(render_manifest(ops))
        print(f"Wrote {os.path.relpath(MANIFEST, REPO)}: {len(ops)} operation(s).")
        return

    with open(MANIFEST) as f:
        text = f.read()
    manifest = parse_manifest_text(text)

    failures = 0
    failures += check_manifest_vs_spec(manifest, available)
    failures += check_manifest_is_generated(tools, text)
    failures += check_declarations_vs_code(tools)
    failures += check_allowlists(tools, available)
    failures += check_network_gateway_bases(spec)

    report_coverage(tools, manifest, available, version)

    if failures:
        print(f"\n{failures} spec-drift failure(s).")
        sys.exit(1)


if __name__ == "__main__":
    main()
