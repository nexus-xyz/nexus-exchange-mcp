// Tests for surface-lib.mjs (ENG-18798), on synthetic schemas: how a tool's
// input schema becomes listing lines, and the advertised-vs-zod comparison whose
// mismatch makes surface.mjs fail. public_api.sh runs this file first, before it
// builds or lists anything, and again in the consumer that installed the packed
// tarball, with SURFACE_PACKAGE set to the package's name.
//
//   node --test scripts/release_gate/surface.test.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe as suite, test } from "node:test";
import { pathToFileURL } from "node:url";
import {
  UnsupportedSchema,
  describe,
  findMismatches,
  walk,
} from "./surface-lib.mjs";

// The zod surface.mjs compares with: the one the package resolves from its own
// package.json. In the consumer that is the installed package, whose
// dependencies resolve with no lockfile, so its zod can be newer than the
// repo's; there SURFACE_PACKAGE names it and it is found as surface.mjs finds
// it. In the repo, the package is the repo itself.
const manifest = process.env.SURFACE_PACKAGE
  ? createRequire(import.meta.url).resolve(
      `${process.env.SURFACE_PACKAGE}/package.json`,
    )
  : new URL("../../package.json", import.meta.url);
const { z } = await import(
  pathToFileURL(createRequire(manifest).resolve("zod")).href
);

const lines = (schema) => {
  const out = [];
  walk(schema, "tool t", out);
  return out;
};

suite("enum members", () => {
  test("keep the schema's order, so the snapshot's lines do not move", () => {
    assert.equal(
      describe({ type: "string", enum: ["sell", "buy"] }),
      'string enum=["sell","buy"]',
    );
  });
});

suite("constraints", () => {
  test("multipleOf, uniqueItems, minProperties and maxProperties are listed", () => {
    assert.equal(
      describe({ type: "number", multipleOf: 5 }),
      "number multipleOf=5",
    );
    assert.equal(
      describe({ type: "array", uniqueItems: true }),
      "array uniqueItems=true",
    );
    assert.equal(
      describe({ type: "object", minProperties: 1, maxProperties: 3 }),
      "object maxProperties=3 minProperties=1",
    );
  });
});

suite("walk", () => {
  test("lists properties, required-ness, items, extra properties and branches", () => {
    assert.deepEqual(
      lines({
        type: "object",
        properties: {
          a: { type: "string" },
          b: { type: "array", items: { type: "number", minimum: 1 } },
          c: {
            allOf: [
              {
                type: "object",
                properties: { id: { type: "string" } },
                required: ["id"],
              },
              { type: "object", properties: { tag: { type: "string" } } },
            ],
          },
          d: { anyOf: [{ type: "string", enum: ["x"] }, { type: "null" }] },
          e: {
            oneOf: [
              { type: "number", minimum: 0 },
              { type: "string", pattern: "^[0-9]+$" },
            ],
          },
          f: {
            type: "object",
            additionalProperties: { type: "string", maxLength: 8 },
          },
          g: { type: "object", additionalProperties: true },
          h: { type: "object", additionalProperties: false },
        },
        required: ["a", "gone"],
        additionalProperties: false,
      }),
      [
        "tool t.a string required",
        "tool t.b array optional",
        "tool t.b[] number minimum=1",
        "tool t.c any optional",
        "tool t.c<allOf[0]> object",
        "tool t.c<allOf[0]>.id string required",
        "tool t.c<allOf[1]> object",
        "tool t.c<allOf[1]>.tag string optional",
        "tool t.d any optional",
        'tool t.d<anyOf[0]> string enum=["x"]',
        "tool t.d<anyOf[1]> null",
        "tool t.e any optional",
        "tool t.e<oneOf[0]> number minimum=0",
        'tool t.e<oneOf[1]> string pattern="^[0-9]+$"',
        "tool t.f object optional",
        "tool t.f{} string maxLength=8",
        "tool t.g object additionalProperties=true optional",
        "tool t.h object additionalProperties=false optional",
        "tool t.gone undeclared required",
      ],
    );
  });

  for (const key of [
    "$ref",
    "$dynamicRef",
    "$defs",
    "definitions",
    "prefixItems",
    "patternProperties",
    "not",
    "if",
    "then",
    "else",
    "dependentSchemas",
    "contains",
    "propertyNames",
    "unevaluatedProperties",
    "unevaluatedItems",
  ]) {
    test(`${key} fails loudly instead of being skipped`, () => {
      const schema = {
        type: "object",
        properties: { a: { [key]: key === "$ref" ? "#/$defs/A" : {} } },
      };
      assert.throws(
        () => lines(schema),
        (err) =>
          err instanceof UnsupportedSchema &&
          err.message.includes("tool t.a") &&
          err.message.includes(key),
      );
    });
  }

  test("a property merely named like one of those keywords is not refused", () => {
    assert.deepEqual(
      lines({
        type: "object",
        properties: { not: { type: "string" }, if: { type: "string" } },
      }),
      ["tool t.not string optional", "tool t.if string optional"],
    );
  });

  test("the draft-07 tuple form of items is refused, not walked as a schema", () => {
    assert.throws(
      () =>
        lines({
          type: "object",
          properties: {
            pair: {
              type: "array",
              items: [{ type: "string" }, { type: "number" }],
            },
          },
        }),
      (err) =>
        err instanceof UnsupportedSchema &&
        err.message.includes("tool t.pair") &&
        err.message.includes("items as an array"),
    );
  });

  test("a reference below an array's items is found too", () => {
    assert.throws(
      () =>
        lines({
          type: "object",
          properties: { xs: { type: "array", items: { $ref: "#/$defs/X" } } },
        }),
      UnsupportedSchema,
    );
  });
});

suite("findMismatches (the advertised schema against the zod one)", () => {
  const tool = (inputSchema, zod, name = "t") => ({ name, inputSchema, zod });

  test("agreeing schemas report nothing", () => {
    assert.deepEqual(
      findMismatches(
        [
          tool(
            {
              type: "object",
              properties: { a: { type: "string", enum: ["y", "x"] } },
              required: ["a"],
            },
            z.object({ a: z.enum(["x", "y"]) }),
          ),
        ],
        z,
      ),
      [],
    );
  });

  test("a property the zod schema does not know", () => {
    const out = findMismatches(
      [
        tool(
          { type: "object", properties: { a: {}, b: {} } },
          z.object({ a: z.string().optional() }),
        ),
      ],
      z,
    );
    assert.equal(out.length, 1);
    assert.match(
      out[0],
      /^t: properties \["a","b"\] advertised, \["a"\] validated$/,
    );
  });

  test("a required field the validator does not require", () => {
    const out = findMismatches(
      [
        tool(
          { type: "object", properties: { a: {} }, required: ["a"] },
          z.object({ a: z.string().optional() }),
        ),
      ],
      z,
    );
    assert.match(out[0], /required \["a"\] advertised, \[\] validated/);
  });

  test("an enum whose members differ", () => {
    const out = findMismatches(
      [
        tool(
          {
            type: "object",
            properties: { a: { enum: ["x", "y", "z"] } },
            required: ["a"],
          },
          z.object({ a: z.enum(["x", "y"]) }),
        ),
      ],
      z,
    );
    assert.match(
      out[0],
      /a enum \["x","y","z"\] advertised, \["x","y"\] validated/,
    );
  });

  test("every disagreeing tool is reported, naming the tool", () => {
    const bad = (name) =>
      tool({ type: "object", properties: { a: {} } }, z.object({}), name);
    const out = findMismatches([bad("one"), bad("two")], z);
    assert.equal(out.length, 2);
    assert.match(out[0], /^one: /);
    assert.match(out[1], /^two: /);
  });
});
