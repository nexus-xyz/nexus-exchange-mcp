#!/usr/bin/env python3
"""Self-test for the spec-drift checker (ENG-7964).

A verification tool is only worth its green run if something proves it can go
red. This suite defeats each invariant in turn and asserts the checker notices —
the parent ticket's "add a self-test that proves the checker goes red when
defeated", and the gap rs's own test suite exists to close.

Three groups:

* **The invariants.** For each of the three (manifest -> spec, manifest ==
  declarations, declarations == code) a synthetic tool source or spec is built
  that breaks exactly that one, and the check must report a non-zero error count.
  Passing cases are asserted too, so a checker that simply always fails would not
  satisfy this file either.

* **The parsers, fail-closed.** The scanner's whole job is to not undercount, so
  every construct it cannot account for must abort: a path built into a variable,
  a request issued outside a tool object, a tool with no `ops` declaration, a
  renamed tools array, zero tools parsed. Each of these, left silent, is a
  checker reporting green over a real gap.

* **The real source.** The synthetic fixtures pin the contract independently of
  today's tool list, but they could all pass while src/tools/index.ts drifted out
  from under them — so the parsers also run over the real file and assert the
  shape they depend on still holds.

Hermetic: no network, no pinned-spec download. The spec side is synthetic
throughout; the real-source group reads only local files.

Run: python3 scripts/test_check_spec_drift.py   (stdlib unittest; no pytest)
"""
import contextlib
import io
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import check_spec_drift as csd  # noqa: E402


def _quiet(fn, *args, **kwargs):
    """Run a check fn, swallowing its stdout; return its error count."""
    with contextlib.redirect_stdout(io.StringIO()):
        return fn(*args, **kwargs)


def spec_with(*ops):
    """A minimal OpenAPI document declaring exactly `ops` ("METHOD /path")."""
    paths = {}
    for op in ops:
        method, path = op.split()
        paths.setdefault(path, {})[method.lower()] = {"responses": {}}
    return {"info": {"version": "0.0.0-test"}, "paths": paths}


def tool_source(*tools):
    """Build a synthetic src/tools/index.ts body from (name, ops, calls) triples.

    `ops` is a list of declaration strings; `calls` a list of raw
    `client.request({...})` argument bodies, so a fixture can express a handler
    that disagrees with its declaration — the thing invariant 3 has to catch."""
    parts = ["export const tools: ToolDef[] = ["]
    for name, ops, calls in tools:
        decls = ", ".join(f'"{o}"' for o in ops)
        body = "\n".join(f"      client.request({{{c}}});" for c in calls)
        parts.append(
            f"  {{\n"
            f'    name: "{name}",\n'
            f"    ops: [{decls}],\n"
            f'    description: "synthetic",\n'
            f"    handler: (client, args) => {{\n{body}\n    }},\n"
            f"  }},"
        )
    parts.append("];")
    return "\n".join(parts)


@contextlib.contextmanager
def as_tool_source(text):
    """Point the checker's parsers at a synthetic tool source for one block."""
    with tempfile.NamedTemporaryFile("w", suffix=".ts", delete=False) as fh:
        fh.write(text)
        name = fh.name
    original = csd.TOOLS_TS
    csd.TOOLS_TS = name
    try:
        yield name
    finally:
        csd.TOOLS_TS = original
        os.unlink(name)


@contextlib.contextmanager
def patched(name, value):
    """Temporarily replace a module-level constant (an allowlist, usually)."""
    original = getattr(csd, name)
    setattr(csd, name, value)
    try:
        yield
    finally:
        setattr(csd, name, original)


def parse(text):
    """Parse a synthetic tool source, quietly."""
    with as_tool_source(text) as path:
        with contextlib.redirect_stdout(io.StringIO()):
            return csd.parse_tools(path)


@contextlib.contextmanager
def expect_abort(case):
    """Assert the block aborts the run, swallowing the diagnostic it prints.

    The abort message goes to stderr by design — it is what a maintainer reads
    when the checker refuses to guess. Here it is expected, so it is suppressed to
    keep the CI log for a passing self-test clean."""
    with contextlib.redirect_stderr(io.StringIO()):
        with case.assertRaises(SystemExit):
            yield


def check_decl(tools, without_ops=frozenset()):
    """Run invariant 3 over synthetic tools, quietly, with TOOLS_WITHOUT_OPS
    scoped to `without_ops`.

    The real allowlist names a real tool, and its own staleness check (correctly)
    fires when that tool is absent — which it always is from a synthetic fixture.
    Scoping it keeps each test measuring the one thing it is about; the real
    allowlist is exercised against the real source in TestAgainstRealSource."""
    with patched("TOOLS_WITHOUT_OPS", set(without_ops)):
        return _quiet(csd.check_declarations_vs_code, tools)


# A well-formed pair of tools: one plain read, one tool calling TWO operations —
# the shape that makes a tool count and an operation count different numbers, and
# so the shape any aggregate-only check would get wrong.
GOOD = tool_source(
    ("get_thing", ["GET /api/v1/things/{thing_id}"], ['path: `/api/v1/things/${id}`']),
    (
        "cancel_thing",
        ["DELETE /api/v1/things", "DELETE /api/v1/things/{thing_id}"],
        [
            'method: "DELETE", path: "/api/v1/things"',
            'method: "DELETE", path: `/api/v1/things/${id}`',
        ],
    ),
)
GOOD_SPEC_OPS = (
    "GET /api/v1/things/{thing_id}",
    "DELETE /api/v1/things",
    "DELETE /api/v1/things/{thing_id}",
)


class TestInvariant1ManifestVsSpec(unittest.TestCase):
    """manifest -> spec: every listed operation must exist in the pinned spec."""

    def test_all_present_passes(self):
        manifest = [("GET", "/api/v1/things")]
        spec = csd.spec_ops(spec_with("GET /api/v1/things"))
        self.assertEqual(_quiet(csd.check_manifest_vs_spec, manifest, spec), 0)

    def test_operation_absent_from_spec_fails(self):
        # The py regression class (ENG-7958): a manifest entry with the wrong
        # path prefix. It looks plausible and nothing else in the repo objects.
        manifest = [("GET", "/bridge/assets")]
        spec = csd.spec_ops(spec_with("GET /api/v1/bridge/assets"))
        self.assertGreater(_quiet(csd.check_manifest_vs_spec, manifest, spec), 0)

    def test_renamed_operation_fails(self):
        manifest = [("GET", "/api/v1/things")]
        spec = csd.spec_ops(spec_with("GET /api/v1/widgets"))
        self.assertGreater(_quiet(csd.check_manifest_vs_spec, manifest, spec), 0)

    def test_method_change_fails(self):
        # Same path, different verb: still a removed operation.
        manifest = [("PUT", "/api/v1/things")]
        spec = csd.spec_ops(spec_with("POST /api/v1/things"))
        self.assertGreater(_quiet(csd.check_manifest_vs_spec, manifest, spec), 0)


class TestInvariant2ManifestIsGenerated(unittest.TestCase):
    """manifest == declarations: endpoints.txt is an emitted artifact."""

    def setUp(self):
        self.tools = parse(GOOD)
        self.expected = csd.render_manifest(csd.declared_manifest_ops(self.tools))

    def test_generated_text_passes(self):
        self.assertEqual(
            _quiet(csd.check_manifest_is_generated, self.tools, self.expected), 0
        )

    def test_extra_line_fails(self):
        # Hand-adding an operation no tool declares — inventing coverage.
        tampered = self.expected + "GET /api/v1/invented\n"
        self.assertGreater(
            _quiet(csd.check_manifest_is_generated, self.tools, tampered), 0
        )

    def test_dropped_line_fails(self):
        kept = [
            ln
            for ln in self.expected.splitlines()
            if ln != "DELETE /api/v1/things"
        ]
        self.assertGreater(
            _quiet(csd.check_manifest_is_generated, self.tools, "\n".join(kept) + "\n"),
            0,
        )

    def test_stale_after_a_tool_gains_an_operation_fails(self):
        """The drift this invariant is really for: the tools change and the
        manifest is left behind. Generated text from BEFORE the change must fail
        against the tools AFTER it."""
        grown = parse(
            tool_source(
                (
                    "get_thing",
                    ["GET /api/v1/things/{thing_id}", "GET /api/v1/things"],
                    [
                        'path: `/api/v1/things/${id}`',
                        'path: "/api/v1/things"',
                    ],
                ),
            )
        )
        self.assertGreater(
            _quiet(csd.check_manifest_is_generated, grown, self.expected), 0
        )

    def test_header_edit_alone_fails(self):
        """Byte-for-byte, not set-for-set: editing the prose that states the unit
        must not pass silently, since that prose is the thing stopping the number
        from being read as a tool count."""
        tampered = self.expected.replace(
            "# GENERATED FILE — do not edit by hand.", "# hand-maintained, sorry"
        )
        self.assertNotEqual(tampered, self.expected)
        self.assertGreater(
            _quiet(csd.check_manifest_is_generated, self.tools, tampered), 0
        )

    def test_allowlisted_operations_are_excluded(self):
        with patched("NON_SPEC_TARGETS", {("DELETE", "/api/v1/things")}):
            ops = csd.declared_manifest_ops(self.tools)
        self.assertNotIn(("DELETE", "/api/v1/things"), ops)
        self.assertIn(("GET", "/api/v1/things/{thing_id}"), ops)


class TestInvariant3DeclarationsVsCode(unittest.TestCase):
    """declarations == code, per tool."""

    def test_matching_declarations_pass(self):
        self.assertEqual(
            check_decl(parse(GOOD)), 0
        )

    def test_undeclared_call_fails(self):
        """A handler gains a request and the declaration is not updated — the
        coverage number silently understates, and the mapping is wrong."""
        tools = parse(
            tool_source(
                (
                    "get_thing",
                    ["GET /api/v1/things"],
                    ['path: "/api/v1/things"', 'path: "/api/v1/things/extra"'],
                ),
            )
        )
        self.assertGreater(check_decl(tools), 0)

    def test_declared_but_never_requested_fails(self):
        """The dangerous direction: a declaration claiming coverage no handler
        provides. Presence-only checking is what lets a manifest drift into
        fiction."""
        tools = parse(
            tool_source(
                (
                    "get_thing",
                    ["GET /api/v1/things", "GET /api/v1/things/aspirational"],
                    ['path: "/api/v1/things"'],
                ),
            )
        )
        self.assertGreater(check_decl(tools), 0)

    def test_wrong_method_declared_fails(self):
        tools = parse(
            tool_source(
                ("place", ["POST /api/v1/things"], ['method: "PUT", path: "/api/v1/things"']),
            )
        )
        self.assertGreater(check_decl(tools), 0)

    def test_omitted_method_is_attributed_to_get(self):
        """Most call sites omit `method:` because they are reads; the checker
        takes the client's default. Pin it, since a wrong default would
        mis-attribute the majority of operations while reporting green."""
        tools = parse(
            tool_source(("read", ["GET /api/v1/things"], ['path: "/api/v1/things"']))
        )
        self.assertEqual(tools[0]["requested"], [("GET", "/api/v1/things")])
        self.assertEqual(check_decl(tools), 0)

    def test_swapped_operations_between_tools_fails(self):
        """Why this invariant is per-tool and not a set comparison: swap two
        tools' operations and the aggregate set is unchanged, so an aggregate
        check stays green while the tool -> operation mapping — the entire point
        of the exercise — is wrong."""
        swapped = tool_source(
            ("tool_a", ["GET /api/v1/b"], ['path: "/api/v1/a"']),
            ("tool_b", ["GET /api/v1/a"], ['path: "/api/v1/b"']),
        )
        tools = parse(swapped)
        aggregate_declared = {csd.norm_op(o) for t in tools for o in t["declared"]}
        aggregate_requested = {csd.norm_op(o) for t in tools for o in t["requested"]}
        self.assertEqual(
            aggregate_declared,
            aggregate_requested,
            "fixture must be invisible to an aggregate-only comparison",
        )
        self.assertGreater(check_decl(tools), 0)

    def test_placeholder_spelling_does_not_matter(self):
        """A declaration uses the spec's placeholder name and the handler
        interpolates a local: same operation, compared by shape."""
        tools = parse(
            tool_source(
                (
                    "get_thing",
                    ["GET /api/v1/things/{thing_id}"],
                    ['path: `/api/v1/things/${encodeURIComponent(a.whatever)}`'],
                ),
            )
        )
        self.assertEqual(check_decl(tools), 0)

    def test_empty_ops_requires_the_allowlist(self):
        tools = parse(tool_source(("local_helper", [], [])))
        self.assertGreater(check_decl(tools), 0)
        self.assertEqual(check_decl(tools, {"local_helper"}), 0)

    def test_stale_tools_without_ops_entry_fails(self):
        """The tool now calls something, so the exemption is a lie."""
        tools = parse(
            tool_source(("local_helper", ["GET /api/v1/things"], ['path: "/api/v1/things"']))
        )
        self.assertGreater(check_decl(tools, {"local_helper"}), 0)

    def test_tools_without_ops_naming_a_removed_tool_fails(self):
        tools = parse(GOOD)
        self.assertGreater(check_decl(tools, {"tool_that_no_longer_exists"}), 0)


class TestAllowlistStaleness(unittest.TestCase):
    """Both operation allowlists must rot loudly, not silently."""

    def setUp(self):
        self.tools = parse(GOOD)
        self.spec = csd.spec_ops(spec_with(*GOOD_SPEC_OPS))

    def check(self, tools, non_spec=frozenset(), code_only=frozenset()):
        """Both allowlists scoped to the entries under test, so each case fails
        for its own reason and not because the real allowlists name real tools
        that a synthetic fixture does not have."""
        with patched("NON_SPEC_TARGETS", set(non_spec)), patched(
            "CODE_ONLY_OPS", set(code_only)
        ):
            return _quiet(csd.check_allowlists, tools, self.spec)

    def test_empty_allowlists_pass(self):
        self.assertEqual(self.check(self.tools), 0)

    def test_entry_no_tool_calls_fails(self):
        self.assertGreater(self.check(self.tools, non_spec={("GET", "/demo/gone")}), 0)

    def test_code_only_op_that_the_spec_now_defines_fails(self):
        """The entry's whole justification was "ahead of the pinned spec". The pin
        advanced, so it belongs in the manifest now — exactly the moment an
        allowlist would otherwise become a permanent hole."""
        self.assertGreater(
            self.check(self.tools, code_only={("DELETE", "/api/v1/things")}), 0
        )

    def test_non_spec_target_that_the_spec_now_defines_fails(self):
        self.assertGreater(
            self.check(self.tools, non_spec={("DELETE", "/api/v1/things")}), 0
        )

    def test_code_only_op_ahead_of_spec_passes(self):
        # Called by a tool, absent from the pinned spec: the case the allowlist
        # exists for. It must NOT be an error, and must stay out of the manifest.
        tools = parse(
            tool_source(
                (
                    "new_thing",
                    ["POST /api/v1/unreleased"],
                    ['method: "POST", path: "/api/v1/unreleased"'],
                ),
            )
        )
        ahead = {("POST", "/api/v1/unreleased")}
        self.assertEqual(self.check(tools, code_only=ahead), 0)
        with patched("CODE_ONLY_OPS", ahead):
            self.assertNotIn(
                ("POST", "/api/v1/unreleased"), csd.declared_manifest_ops(tools)
            )


class TestParsersFailClosed(unittest.TestCase):
    """Anything the scanner cannot account for must abort, never be skipped.

    Each case here, if it merely returned fewer operations, would be the checker
    reporting green over a real gap — the failure mode that makes a verification
    tool worse than none."""

    def test_non_inline_path_aborts(self):
        src = tool_source(
            ("sneaky", ["GET /api/v1/things"], ["path: builtPath, signed: true"]),
        )
        with expect_abort(self):
            parse(src)

    def test_request_outside_a_tool_object_aborts(self):
        src = GOOD + "\nfunction helper(client) { client.request({ path: \"/api/v1/hidden\" }); }\n"
        with expect_abort(self):
            parse(src)

    def test_missing_ops_declaration_aborts(self):
        src = (
            "export const tools: ToolDef[] = [\n"
            "  {\n"
            '    name: "undeclared",\n'
            '    description: "no ops field",\n'
            "    handler: (client) => client.request({ path: \"/api/v1/things\" }),\n"
            "  },\n"
            "];"
        )
        with expect_abort(self):
            parse(src)

    def test_renamed_tools_array_aborts(self):
        with expect_abort(self):
            parse(GOOD.replace("export const tools", "export const toolRegistry"))

    def test_empty_tools_array_aborts(self):
        with expect_abort(self):
            parse("export const tools: ToolDef[] = [\n];")

    def test_request_without_a_path_key_aborts(self):
        src = tool_source(("no_path", ["GET /api/v1/things"], ['signed: true']))
        with expect_abort(self):
            parse(src)

    def test_malformed_op_declaration_aborts(self):
        for bad in ("GET", "/api/v1/things", "FETCH /api/v1/things", "GET api/v1/things"):
            with self.subTest(bad=bad):
                with expect_abort(self):
                    parse(tool_source(("bad", [bad], ['path: "/api/v1/things"'])))

    def test_duplicate_tool_name_aborts(self):
        src = tool_source(
            ("same", ["GET /api/v1/a"], ['path: "/api/v1/a"']),
            ("same", ["GET /api/v1/b"], ['path: "/api/v1/b"']),
        )
        with expect_abort(self):
            parse(src)

    def test_path_in_prose_or_nested_object_is_not_read(self):
        """A `path:` inside a comment, a description string, or the nested request
        body must not be mistaken for the request path — that would attribute the
        tool to an operation it never calls."""
        src = (
            "export const tools: ToolDef[] = [\n"
            "  {\n"
            '    name: "nested",\n'
            '    ops: ["POST /api/v1/things"],\n'
            '    description: "mentions path: /api/v1/decoy in prose",\n'
            "    // path: \"/api/v1/comment-decoy\"\n"
            "    handler: (client) =>\n"
            "      client.request({\n"
            '        method: "POST",\n'
            '        path: "/api/v1/things",\n'
            '        body: { path: "/api/v1/body-decoy", method: "GET" },\n'
            "      }),\n"
            "  },\n"
            "];"
        )
        tools = parse(src)
        self.assertEqual(tools[0]["requested"], [("POST", "/api/v1/things")])
        self.assertEqual(check_decl(tools), 0)


class TestAgainstRealSource(unittest.TestCase):
    """The real src/tools/index.ts, so the synthetic fixtures above cannot pass
    while the file they stand in for has drifted."""

    @classmethod
    def setUpClass(cls):
        with contextlib.redirect_stdout(io.StringIO()):
            cls.tools = csd.parse_tools()

    def test_every_tool_parses_with_a_declaration(self):
        self.assertGreater(len(self.tools), 50)
        for t in self.tools:
            with self.subTest(tool=t["name"]):
                self.assertTrue(
                    t["declared"] or t["name"] in csd.TOOLS_WITHOUT_OPS,
                    f"{t['name']} declares no ops and is not in TOOLS_WITHOUT_OPS",
                )

    def test_a_real_tool_calls_more_than_one_operation(self):
        """The premise of the whole exercise: tools are not operations. If this
        ever stops holding, the unit decision in docs/coverage-unit.md should be
        revisited — but silently reverting to "tool count == operation count" is
        not the way to find out."""
        multi = [t["name"] for t in self.tools if len(t["declared"]) > 1]
        self.assertTrue(
            multi, "no tool declares multiple operations; re-check the unit decision"
        )

    def test_real_declarations_match_the_real_handlers(self):
        self.assertEqual(_quiet(csd.check_declarations_vs_code, self.tools), 0)

    def test_client_default_method_contract_holds(self):
        csd.check_client_contract()  # exits non-zero if the client's default moved

    def test_generated_manifest_is_committed(self):
        _, text = csd.load_manifest()
        self.assertEqual(
            _quiet(csd.check_manifest_is_generated, self.tools, text),
            0,
            "endpoints.txt is stale — regenerate it with --write",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
