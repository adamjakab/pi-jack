import * as fs from "node:fs";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  contractError,
  ERROR_KEY,
  hasSchemaPlaceholder,
  parseJsonReply,
  renderSchema,
  retryPrompt,
  validateShape,
  verifyReply,
} from "../contract.ts";

describe("parseJsonReply", () => {
  it("parses bare and fenced JSON", () => {
    expect(parseJsonReply(' {"a": 1} ')).toEqual({ a: 1 });
    expect(parseJsonReply('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(parseJsonReply("```\n[1, 2]\n```")).toEqual([1, 2]);
  });

  it("recovers an object surrounded by stray prose", () => {
    expect(parseJsonReply('Here you go:\n{"a": {"b": 2}}\nDone.')).toEqual({ a: { b: 2 } });
  });

  it("throws when there is no JSON", () => {
    expect(() => parseJsonReply("not json")).toThrow();
  });
});

describe("contractError", () => {
  it("returns the reason of a lone subagent_error key", () => {
    expect(contractError({ subagent_error: "blocked" })).toBe("blocked");
  });

  it("ignores ordinary replies, including ones that merely contain the key", () => {
    expect(contractError({ count: 3 })).toBeUndefined();
    expect(contractError({ subagent_error: "x", count: 3 })).toBeUndefined();
    expect(contractError({ subagent_error: 42 })).toBeUndefined();
    expect(contractError([{ subagent_error: "x" }])).toBeUndefined();
    expect(contractError(null)).toBeUndefined();
  });
});

describe("renderSchema", () => {
  it("replaces every {{schema}} with the schema, verbatim", () => {
    expect(renderSchema("Return {{schema}}, i.e. {{schema}}.", '{"a": "$&"}')).toBe(
      'Return {"a": "$&"}, i.e. {"a": "$&"}.',
    );
  });

  it("leaves a prompt without placeholders unchanged", () => {
    expect(renderSchema("plain", "{}")).toBe("plain");
  });
});

describe("hasSchemaPlaceholder", () => {
  it("detects {{schema}}", () => {
    expect(hasSchemaPlaceholder("Return {{schema}}")).toBe(true);
    expect(hasSchemaPlaceholder("no placeholders")).toBe(false);
  });
});

// Guards the contract between this extension and the default agent it ships with.
describe("agents/worker.md", () => {
  const { body } = parseFrontmatter(fs.readFileSync(new URL("../../../agents/worker.md", import.meta.url), "utf-8"));

  it("states the output contract itself, with the schema and the error form", () => {
    expect(hasSchemaPlaceholder(body)).toBe(true);
    const rendered = renderSchema(body, '{"count": "number"}');
    expect(rendered).toContain('{"count": "number"}');
    expect(rendered).toContain(`{"${ERROR_KEY}": "<one-line reason>"}`);
    expect(rendered).not.toMatch(/\{\{/);
  });
});

describe("validateShape", () => {
  it("accepts a value matching the shape, ignoring extra keys", () => {
    const shape = { topic: "string", count: "number", tags: ["string"], meta: { ok: "boolean" } };
    const value = { topic: "x", count: 2, tags: ["a", "b"], meta: { ok: true }, extra: 1 };
    expect(validateShape(value, shape)).toEqual([]);
  });

  it("reports missing keys and wrong types with their paths", () => {
    const shape = { topic: "string", count: "number", tags: ["string"], meta: { ok: "boolean" } };
    const value = { count: "2", tags: ["a", 3], meta: { ok: "yes" } };
    expect(validateShape(value, shape)).toEqual([
      "$.topic: missing",
      "$.count: expected number, got string",
      "$.tags[1]: expected string, got number",
      "$.meta.ok: expected boolean, got string",
    ]);
  });

  it("checks the top-level kind", () => {
    expect(validateShape([1], { a: "string" })).toEqual(["$: expected object, got array"]);
    expect(validateShape({}, ["string"])).toEqual(["$: expected array, got object"]);
    expect(validateShape([1, "x"], [])).toEqual([]);
  });

  it("supports text, integer, unions and optional keys", () => {
    expect(validateShape({ r: "hi" }, { r: "text" })).toEqual([]);
    expect(validateShape({ n: 1.5 }, { n: "integer" })).toEqual(["$.n: expected integer, got number"]);
    expect(validateShape({ v: null }, { v: "string|null" })).toEqual([]);
    expect(validateShape({ v: 1 }, { v: "string | null" })).toEqual(["$.v: expected string or null, got number"]);
    expect(validateShape({}, { note: "string?" })).toEqual([]);
    expect(validateShape({ note: 1 }, { note: "string?" })).toEqual(["$.note: expected string, got number"]);
  });

  it("treats a descriptive string as any value, but still requires the key", () => {
    expect(validateShape({ label: 42 }, { label: "<label from the task>" })).toEqual([]);
    expect(validateShape({}, { label: "<label from the task>" })).toEqual(["$.label: missing"]);
  });

  it("checks number and boolean example values by type", () => {
    expect(validateShape({ n: 7, b: false }, { n: 0, b: true })).toEqual([]);
    expect(validateShape({ n: "7" }, { n: 0 })).toEqual(["$.n: expected number, got string"]);
  });
});

describe("verifyReply", () => {
  const schema = '{"count": "number"}';

  it("accepts a valid reply", () => {
    expect(verifyReply('{"count": 3}', schema)).toEqual({ parsed: true, data: { count: 3 }, errors: [] });
  });

  it("rejects an empty reply, invalid JSON, and a shape mismatch", () => {
    expect(verifyReply("  ", schema).errors).toEqual(["the reply is empty"]);
    expect(verifyReply("not json", schema)).toMatchObject({ parsed: false, errors: [expect.stringMatching(/^the reply is not valid JSON/)] });
    expect(verifyReply('{"count": "3"}', schema)).toMatchObject({
      parsed: true,
      errors: ["$.count: expected number, got string"],
    });
  });

  it("passes the error form through as the agent's reason, not a format error", () => {
    expect(verifyReply('{"subagent_error": "blocked"}', schema)).toMatchObject({ errors: [], agentError: "blocked" });
  });

  it("only checks JSON validity when the schema itself is not JSON", () => {
    expect(verifyReply('{"anything": 1}', "{count: number}").errors).toEqual([]);
  });
});

describe("retryPrompt", () => {
  it("lists the errors, restates the schema and the error form", () => {
    const prompt = retryPrompt(["$.count: missing"], '{"count": "number"}');
    expect(prompt).toContain("- $.count: missing");
    expect(prompt).toContain('{"count": "number"}');
    expect(prompt).toContain(`{"${ERROR_KEY}": "<one-line reason>"}`);
  });
});
