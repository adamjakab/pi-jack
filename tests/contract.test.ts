import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_SCHEMA, resolveSchema, schemaErrors } from "../contract.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-contract-test-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

// A schema as demanding as the ones real callers pass: descriptions everywhere, nested arrays of objects,
// required fields, closed objects, and length limits.
const verdictSchema = {
  type: "object",
  properties: {
    summary: { type: "string", maxLength: 50, description: "What you did, as markdown." },
    complete: { type: "boolean", description: "True only when everything asked for is finished." },
    questions: { type: "array", items: { type: "string" }, description: "Open questions, one per entry." },
    new_items: {
      type: "array",
      maxItems: 2,
      description: "Work items to create.",
      items: {
        type: "object",
        properties: {
          key: { type: "string", description: "Handle used inside this verdict only." },
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
    expect(resolveSchema(` ${JSON.stringify(verdictSchema)} `, tmp)).toEqual(verdictSchema);
  });

  it("loads a .json file, resolving a relative path against the base dir", () => {
    fs.writeFileSync(path.join(tmp, "verdict.json"), JSON.stringify(verdictSchema));
    expect(resolveSchema("verdict.json", tmp)).toEqual(verdictSchema);
    expect(resolveSchema(path.join(tmp, "verdict.json"), "/elsewhere")).toEqual(verdictSchema);
  });

  it("explains why a schema can't be used", () => {
    expect(() => resolveSchema("  ", tmp)).toThrow("the schema is empty");
    expect(() => resolveSchema("{nope", tmp)).toThrow(/^the inline schema is not valid JSON/);
    expect(() => resolveSchema("missing.json", tmp)).toThrow(/^could not load the schema file .*missing\.json/);
    expect(() => resolveSchema(["string"], tmp)).toThrow("the schema must be a JSON Schema object");
    expect(() => resolveSchema({ type: "array", items: {} }, tmp)).toThrow(/root of the schema must describe an object/);
  });

  it("accepts an object root given by `properties` alone", () => {
    expect(() => resolveSchema({ properties: { a: { type: "string" } } }, tmp)).not.toThrow();
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
    expect(schemaErrors(verdictSchema as any, withoutQuestions)).toEqual([expect.stringMatching(/^\/: .*questions/)]);
    expect(schemaErrors(verdictSchema as any, { ...validVerdict, summary: "x".repeat(51) })).toEqual([
      expect.stringMatching(/^\/summary: /),
    ]);
    const tooMany = { ...validVerdict, new_items: [1, 2, 3].map((n) => ({ key: `${n}`, title: "t" })) };
    expect(schemaErrors(verdictSchema as any, tooMany)).toEqual([expect.stringMatching(/^\/new_items: /)]);
    expect(schemaErrors(verdictSchema as any, { ...validVerdict, extra: 1 })).toContain(
      "/extra: property not allowed by the schema",
    );
  });

  it("keeps the list short", () => {
    const schema = { type: "object", properties: { a: { type: "array", items: { type: "string" } } } };
    const errors = schemaErrors(schema as any, { a: Array.from({ length: 20 }, (_, i) => i) });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.length).toBeLessThanOrEqual(10);
  });
});

describe("DEFAULT_SCHEMA", () => {
  it("requires success and result, and allows extra fields", () => {
    expect(schemaErrors(DEFAULT_SCHEMA as any, { success: true, result: "done", extra: 1 })).toEqual([]);
    expect(schemaErrors(DEFAULT_SCHEMA as any, { result: "done" })).toHaveLength(1);
    expect(schemaErrors(DEFAULT_SCHEMA as any, { success: "yes", result: "done" })).toHaveLength(1);
  });
});
