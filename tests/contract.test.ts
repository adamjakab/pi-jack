import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  DEFAULT_SCHEMA,
  isThinkingLevel,
  resolveSchema,
  schemaErrors,
  schemaProblems,
} from "../contract.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jack-contract-test-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

// A schema as demanding as the ones real callers pass: descriptions everywhere, nested arrays of objects,
// required fields, closed objects, and length limits.
const verdictSchema = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      maxLength: 50,
      description: "What you did, as markdown.",
    },
    complete: {
      type: "boolean",
      description: "True only when everything asked for is finished.",
    },
    questions: {
      type: "array",
      items: { type: "string" },
      description: "Open questions, one per entry.",
    },
    new_items: {
      type: "array",
      maxItems: 2,
      description: "Work items to create.",
      items: {
        type: "object",
        properties: {
          key: {
            type: "string",
            description: "Handle used inside this verdict only.",
          },
          title: { type: "string", description: "One imperative line." },
        },
        required: ["key", "title"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "complete", "questions", "new_items"],
  additionalProperties: false,
};

const validVerdict = {
  summary: "Sliced the feature.",
  complete: true,
  questions: [],
  new_items: [{ key: "a", title: "Add the parser" }],
};

describe("resolveSchema", () => {
  it("takes an object as is", () => {
    expect(resolveSchema(verdictSchema, tmp)).toBe(verdictSchema);
  });

  it("parses inline JSON", () => {
    expect(resolveSchema(` ${JSON.stringify(verdictSchema)} `, tmp)).toEqual(
      verdictSchema,
    );
  });

  it("loads a .json file, resolving a relative path against the base dir", () => {
    fs.writeFileSync(
      path.join(tmp, "verdict.json"),
      JSON.stringify(verdictSchema),
    );
    expect(resolveSchema("verdict.json", tmp)).toEqual(verdictSchema);
    expect(resolveSchema(path.join(tmp, "verdict.json"), "/elsewhere")).toEqual(
      verdictSchema,
    );
  });

  it("explains why a schema can't be used", () => {
    expect(() => resolveSchema("  ", tmp)).toThrow("the schema is empty");
    expect(() => resolveSchema("{nope", tmp)).toThrow(
      /^the inline schema is not valid JSON/,
    );
    expect(() => resolveSchema("missing.json", tmp)).toThrow(
      /^could not load the schema file .*missing\.json/,
    );
    expect(() => resolveSchema(["string"], tmp)).toThrow(
      "the schema must be a JSON Schema object",
    );
    expect(() => resolveSchema({ type: "array", items: {} }, tmp)).toThrow(
      /root of the schema must describe an object/,
    );
  });

  it("accepts an object root given by `properties` alone", () => {
    expect(() =>
      resolveSchema({ properties: { a: { type: "string" } } }, tmp),
    ).not.toThrow();
  });
});

describe("schemaProblems", () => {
  it("accepts well-formed schemas, including the default and a complex one", () => {
    expect(schemaProblems(DEFAULT_SCHEMA)).toEqual([]);
    expect(schemaProblems(verdictSchema)).toEqual([]);
    expect(
      schemaProblems({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: ["object", "null"],
        properties: {
          kind: { enum: ["a", "b"] },
          code: { type: "string", pattern: "^[A-Z]{2}\\d+$", format: "uuid" },
          n: {
            type: "number",
            minimum: 0,
            exclusiveMaximum: 1,
            multipleOf: 0.5,
          },
          any: { anyOf: [{ type: "string" }, { type: "integer" }] },
          tuple: {
            type: "array",
            prefixItems: [{ type: "string" }],
            items: false,
            uniqueItems: true,
          },
        },
        $defs: { id: { type: "string" } },
        additionalProperties: { type: "string" },
      }),
    ).toEqual([]);
  });

  it("reports typos that a validator would silently ignore", () => {
    expect(
      schemaProblems({
        type: "object",
        properties: { a: { type: "strin" } },
        requried: ["a"],
      }),
    ).toEqual([
      '/properties/a/type: "strin" is not a JSON Schema type (use string, number, integer, boolean, object, array, null)',
      "/requried: unknown JSON Schema keyword",
    ]);
  });

  it("reports keyword values of the wrong shape, at any depth", () => {
    expect(
      schemaProblems({
        type: "object",
        required: "a",
        properties: {
          list: {
            type: "array",
            items: {
              type: "object",
              maxItems: -1,
              properties: { p: "string" },
            },
          },
          re: { type: "string", pattern: "(" },
          pick: { anyOf: [] },
        },
      }),
    ).toEqual([
      "/required: must be a list of strings",
      "/properties/list/items/maxItems: must be a non-negative integer",
      "/properties/list/items/properties/p: a schema must be an object",
      expect.stringMatching(
        /^\/properties\/re\/pattern: is not a valid regular expression/,
      ),
      "/properties/pick/anyOf: must be a non-empty list of schemas",
    ]);
  });

  it("makes resolveSchema refuse a malformed schema", () => {
    expect(() =>
      resolveSchema(
        { type: "object", properties: { a: { type: "strin" } } },
        tmp,
      ),
    ).toThrow(/^\/properties\/a\/type: "strin" is not a JSON Schema type/);
  });
});

describe("schemaErrors", () => {
  it("accepts a conforming value", () => {
    expect(schemaErrors(verdictSchema as any, validVerdict)).toEqual([]);
  });

  it("reports nested problems with their paths", () => {
    const errors = schemaErrors(verdictSchema as any, {
      ...validVerdict,
      complete: "yes",
      new_items: [{ key: "a", title: 3, extra: true }],
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^\/complete: /),
        expect.stringMatching(/^\/new_items\/0\/title: /),
        "/new_items/0/extra: property not allowed by the schema",
      ]),
    );
  });

  it("enforces required fields, length limits and closed objects", () => {
    const { questions: _q, ...withoutQuestions } = validVerdict;
    expect(schemaErrors(verdictSchema as any, withoutQuestions)).toEqual([
      expect.stringMatching(/^\/: .*questions/),
    ]);
    expect(
      schemaErrors(verdictSchema as any, {
        ...validVerdict,
        summary: "x".repeat(51),
      }),
    ).toEqual([expect.stringMatching(/^\/summary: /)]);
    const tooMany = {
      ...validVerdict,
      new_items: [1, 2, 3].map((n) => ({ key: `${n}`, title: "t" })),
    };
    expect(schemaErrors(verdictSchema as any, tooMany)).toEqual([
      expect.stringMatching(/^\/new_items: /),
    ]);
    expect(
      schemaErrors(verdictSchema as any, { ...validVerdict, extra: 1 }),
    ).toContain("/extra: property not allowed by the schema");
  });

  it("keeps the list short", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "array", items: { type: "string" } } },
    };
    const errors = schemaErrors(schema as any, {
      a: Array.from({ length: 20 }, (_, i) => i),
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.length).toBeLessThanOrEqual(10);
  });
});

describe("DEFAULT_SCHEMA", () => {
  it("requires success and result, and allows extra fields", () => {
    expect(
      schemaErrors(DEFAULT_SCHEMA as any, {
        success: true,
        result: "done",
        extra: 1,
      }),
    ).toEqual([]);
    expect(
      schemaErrors(DEFAULT_SCHEMA as any, { result: "done" }),
    ).toHaveLength(1);
    expect(
      schemaErrors(DEFAULT_SCHEMA as any, { success: "yes", result: "done" }),
    ).toHaveLength(1);
  });
});

describe("THINKING_LEVELS", () => {
  it("knows the offered levels", () => {
    expect(
      ["off", "low", "medium", "high", "xhigh", "max"].every(isThinkingLevel),
    ).toBe(true);
    expect(isThinkingLevel("minimal")).toBe(false);
    expect(isThinkingLevel("HIGH")).toBe(false);
  });
});
