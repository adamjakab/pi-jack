import * as fs from "node:fs";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  contractError,
  ERROR_KEY,
  hasSchemaPlaceholder,
  renderSchema,
  getFinalAssistantText,
  mapWithLimit,
  normalizeTools,
  parseJsonReply,
  taskLabel,
} from "../index.ts";

describe("normalizeTools", () => {
  it("splits and trims a comma-separated string", () => {
    expect(normalizeTools(" read, bash ,grep")).toEqual(["read", "bash", "grep"]);
  });

  it("keeps string entries of an array and drops the rest", () => {
    expect(normalizeTools(["read", 42, " bash ", ""])).toEqual(["read", "bash"]);
  });

  it("returns undefined when nothing usable is given", () => {
    expect(normalizeTools(undefined)).toBeUndefined();
    expect(normalizeTools("")).toBeUndefined();
    expect(normalizeTools(" , ")).toBeUndefined();
    expect(normalizeTools([])).toBeUndefined();
  });
});

describe("taskLabel", () => {
  it("returns a short single-line task unchanged", () => {
    expect(taskLabel("count files")).toBe("count files");
  });

  it("truncates the first line at 60 characters", () => {
    expect(taskLabel("x".repeat(61))).toBe(`${"x".repeat(60)}...`);
  });

  it("marks multi-line tasks as truncated", () => {
    expect(taskLabel("first\nsecond")).toBe("first...");
  });
});

describe("getFinalAssistantText", () => {
  const assistant = (...texts: string[]) =>
    ({ role: "assistant", content: texts.map((text) => ({ type: "text", text })) }) as any;

  it("returns the first text part of the last assistant message", () => {
    const messages = [assistant("old"), { role: "user", content: [] } as any, assistant("new", "extra")];
    expect(getFinalAssistantText(messages)).toBe("new");
  });

  it("skips assistant messages without text", () => {
    const toolOnly = { role: "assistant", content: [{ type: "toolCall" }] } as any;
    expect(getFinalAssistantText([assistant("answer"), toolOnly])).toBe("answer");
  });

  it("returns undefined when there is no assistant text", () => {
    expect(getFinalAssistantText([])).toBeUndefined();
  });
});

describe("mapWithLimit", () => {
  it("keeps results in input order", async () => {
    const delays = [30, 10, 20];
    const out = await mapWithLimit(delays, 3, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return i;
    });
    expect(out).toEqual([0, 1, 2]);
  });

  it("never runs more than `concurrency` items at once", async () => {
    let active = 0;
    let peak = 0;
    await mapWithLimit(Array.from({ length: 10 }), 4, async () => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    });
    expect(peak).toBe(4);
  });

  it("treats concurrency below 1 as sequential", async () => {
    let active = 0;
    let peak = 0;
    await mapWithLimit([1, 2, 3], 0, async () => {
      peak = Math.max(peak, ++active);
      await Promise.resolve();
      active--;
    });
    expect(peak).toBe(1);
  });

  it("returns an empty array for no items", async () => {
    expect(await mapWithLimit([], 4, async () => 1)).toEqual([]);
  });
});

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
  const prompt = "Intro\n\n{{#schema}}\nReturn JSON:\n{{schema}}\n{{/schema}}\n\n{{^schema}}\nWrite a report.\n{{/schema}}\n";

  it("keeps the schema section and fills in the schema when there is one", () => {
    expect(renderSchema(prompt, '{"a": "$&"}')).toBe('Intro\n\nReturn JSON:\n{"a": "$&"}\n\n');
  });

  it("keeps the no-schema section when there is none", () => {
    expect(renderSchema(prompt, undefined)).toBe("Intro\n\nWrite a report.\n\n");
  });

  it("leaves a prompt without placeholders unchanged", () => {
    expect(renderSchema("plain", "{}")).toBe("plain");
  });
});

describe("hasSchemaPlaceholder", () => {
  it("detects any of the three placeholder forms", () => {
    expect(hasSchemaPlaceholder("{{schema}}")).toBe(true);
    expect(hasSchemaPlaceholder("{{#schema}}x{{/schema}}")).toBe(true);
    expect(hasSchemaPlaceholder("{{^schema}}x{{/schema}}")).toBe(true);
    expect(hasSchemaPlaceholder("no placeholders")).toBe(false);
  });
});

// Guards the contract between this extension and the default agent it ships with.
describe("agents/worker.md", () => {
  const { body } = parseFrontmatter(fs.readFileSync(new URL("../../../agents/worker.md", import.meta.url), "utf-8"));

  it("states the output contract itself, with the schema and the error form", () => {
    expect(hasSchemaPlaceholder(body)).toBe(true);
    const withSchema = renderSchema(body, '{"count": "number"}');
    expect(withSchema).toContain('{"count": "number"}');
    expect(withSchema).toContain(`{"${ERROR_KEY}": "<one-line reason>"}`);
    expect(withSchema).not.toContain("## Completed");
    expect(withSchema).not.toMatch(/\{\{/);
  });

  it("falls back to its Markdown report without a schema", () => {
    const withoutSchema = renderSchema(body, undefined);
    expect(withoutSchema).toContain("## Completed");
    expect(withoutSchema).not.toContain(ERROR_KEY);
    expect(withoutSchema).not.toMatch(/\{\{/);
  });
});
