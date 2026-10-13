// The pure half of surface.mjs (ENG-18798): how a tool's input schema becomes
// listing lines, and how the advertised schema is compared with the zod one.
// Split out so surface.test.mjs can run it on synthetic input without a built
// package. surface.mjs imports this file, and public_api.sh copies both into the
// consumer.

// Validation keywords that narrow what an argument accepts. Tightening any of
// them breaks a caller that relied on the old range, so each one is part of the
// property's line.
const CONSTRAINTS = [
  "const",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "format",
  "maxItems",
  "maxLength",
  "maxProperties",
  "maximum",
  "minItems",
  "minLength",
  "minProperties",
  "minimum",
  "multipleOf",
  "pattern",
  "uniqueItems",
];

/** Thrown for a schema feature the walk below does not follow. */
export class UnsupportedSchema extends Error {}

// Keywords that put a schema somewhere `walk` does not look: behind a
// reference, or in a tuple, a pattern, a negation, a condition or a dependency.
// A field changed there would move no line, so refuse, rather than list the
// property without it and miss the change. zod v4 emits `prefixItems` for
// z.tuple(). No tool's inputSchema uses any of them today (the 119 were
// checked, and nothing uses the constraint keywords above either, so adding
// those moved no line). If one has to, teach `walk` to follow it (cycle-safe) first.
const UNFOLLOWED = [
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
];

export function describe(schema) {
  const type = Array.isArray(schema.type)
    ? schema.type.join("|")
    : (schema.type ?? "any");
  const parts = [type];
  // Members keep the schema's order, on purpose. Sorting them would itself
  // reorder lines against the published snapshot and force a minor bump on the
  // next release; a real reorder reading as breaking is the cheap side below 1.0.
  if (schema.enum) parts.push(`enum=${JSON.stringify(schema.enum)}`);
  for (const key of CONSTRAINTS) {
    if (key in schema) parts.push(`${key}=${JSON.stringify(schema[key])}`);
  }
  if (typeof schema.additionalProperties === "boolean") {
    parts.push(`additionalProperties=${schema.additionalProperties}`);
  }
  return parts.join(" ");
}

/** The lines below `path`: properties, items, extra properties and branches. */
export function walk(schema, path, out) {
  for (const key of UNFOLLOWED) {
    if (key in schema) {
      throw new UnsupportedSchema(
        `${path} uses ${key}, which the surface listing does not follow`,
      );
    }
  }
  // The draft-07 tuple form, `items: [schemaA, schemaB]`, is a list of schemas
  // by position; the walk below reads `items` as one schema.
  if (Array.isArray(schema.items)) {
    throw new UnsupportedSchema(
      `${path} uses items as an array (a tuple), which the surface listing does not follow`,
    );
  }
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  for (const [name, sub] of Object.entries(properties)) {
    const need = required.has(name) ? "required" : "optional";
    out.push(`${path}.${name} ${describe(sub)} ${need}`);
    walk(sub, `${path}.${name}`, out);
  }
  for (const name of required) {
    if (!(name in properties)) out.push(`${path}.${name} undeclared required`);
  }
  const nested = [];
  if (schema.items && typeof schema.items === "object") {
    nested.push([`${path}[]`, schema.items]);
  }
  if (
    schema.additionalProperties &&
    typeof schema.additionalProperties === "object"
  ) {
    nested.push([`${path}{}`, schema.additionalProperties]);
  }
  for (const key of ["allOf", "anyOf", "oneOf"]) {
    (schema[key] ?? []).forEach((branch, i) => {
      nested.push([`${path}<${key}[${i}]>`, branch]);
    });
  }
  for (const [subPath, sub] of nested) {
    out.push(`${subPath} ${describe(sub)}`);
    walk(sub, subPath, out);
  }
}

const sorted = (values) => JSON.stringify([...(values ?? [])].sort());

/**
 * One message per tool whose advertised inputSchema and zod schema disagree on
 * the properties, the required ones or a top-level enum. `z` is the zod the
 * package itself resolves, so the comparison uses the version its validators
 * were built with.
 */
export function findMismatches(registry, z) {
  const mismatches = [];
  for (const tool of registry) {
    const validated = z.toJSONSchema(tool.zod, {
      io: "input",
      unrepresentable: "any",
    });
    const advertised = tool.inputSchema;
    const differs = [];
    const names = (schema) => Object.keys(schema.properties ?? {});
    if (sorted(names(validated)) !== sorted(names(advertised))) {
      differs.push(
        `properties ${sorted(names(advertised))} advertised, ${sorted(names(validated))} validated`,
      );
    }
    if (sorted(validated.required) !== sorted(advertised.required)) {
      differs.push(
        `required ${sorted(advertised.required)} advertised, ${sorted(validated.required)} validated`,
      );
    }
    for (const [name, sub] of Object.entries(advertised.properties ?? {})) {
      const other = validated.properties?.[name] ?? {};
      if ((sub.enum || other.enum) && sorted(sub.enum) !== sorted(other.enum)) {
        differs.push(
          `${name} enum ${sorted(sub.enum)} advertised, ${sorted(other.enum)} validated`,
        );
      }
    }
    if (differs.length) mismatches.push(`${tool.name}: ${differs.join("; ")}`);
  }
  return mismatches;
}
