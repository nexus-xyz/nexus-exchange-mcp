// Tests for surface-lib.mjs (ENG-18798), on synthetic schemas: how a tool's
// input schema becomes listing lines, and the advertised-vs-zod comparison whose
// mismatch makes surface.mjs fail. public_api.sh runs this file first, before it
// builds or lists anything.
//
//   node --test scripts/release_gate/surface.test.mjs
import assert from "node:assert/strict";
import { describe as suite, test } from "node:test";
import { z } from "zod";
import {
  UnsupportedSchema,
  describe,
  findMismatches,
  walk,
} from "./surface-lib.mjs";

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
  test("lists properties, required-ness, items and branches", () => {
    assert.deepEqual(
      lines({
        type: "object",
        properties: {
          a: { type: "string" },
          b: { type: "array", items: { type: "number", minimum: 1 } },
        },
        required: ["a", "gone"],
        additionalProperties: false,
      }),
      [
        "tool t.a string required",
        "tool t.b array optional",
        "tool t.b[] number minimum=1",
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
