/**
 * Tests json-schema.ts, the `--json-schema` flag and its result tools, against a fake `pi` API: flags, tools, the active tool
 * set, and event handlers are recorded so each can be driven directly.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { registerJsonSchema } from "../json-schema.ts";
import {
  FAIL_TOOL,
  MAX_FORMAT_RETRIES,
  RESULT_TOOL,
  SCHEMA_FLAG,
} from "../contract.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jack-json-schema-test-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const schema = {
  type: "object",
  properties: {
    count: { type: "integer", description: "How many." },
    files: {
      type: "array",
      items: { type: "string" },
      description: "Their names.",
    },
  },
  required: ["count", "files"],
  additionalProperties: false,
};
const schemaFile = path.join(tmp, "schema.json");
fs.writeFileSync(schemaFile, JSON.stringify(schema));

/** Loads json-schema.ts into a fake pi with the given flag value and starts a session. */
function startChild(flag: string | undefined, initialTools = ["read"]) {
  const tools = new Map<string, any>();
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  let active = [...initialTools];
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const pi = {
    registerFlag: () => {},
    getFlag: (name: string) => (name === SCHEMA_FLAG ? flag : undefined),
    registerTool: (tool: any) => {
      tools.set(tool.name, tool);
      active.push(tool.name);
    },
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => (active = names),
    on: (event: string, handler: any) => handlers.set(event, handler),
  };
  registerJsonSchema(pi as any);
  const ctx = { cwd: tmp, hasUI: false };
  handlers.get("session_start")!({}, ctx);
  handlers.get("before_agent_start")?.({}, ctx);
  const logged = errors.mock.calls.map(([message]) => String(message));
  errors.mockRestore();
  return {
    tools,
    logged,
    active: () => active,
    settle: () => handlers.get("agent_before_settle")!({}, ctx),
    call: (name: string, params: unknown) =>
      tools.get(name).execute("id", params),
  };
}

describe("--json-schema", () => {
  it("does nothing without the schema flag", () => {
    const child = startChild(undefined);
    expect(child.tools.size).toBe(0);
    expect(child.settle()).toBeUndefined();
  });

  it("registers both tools with the schema as the result tool's parameters", () => {
    const child = startChild(schemaFile);
    const result = child.tools.get(RESULT_TOOL);
    expect(result.parameters).toEqual(schema);
    expect(result.constrainedSampling).toEqual({
      type: "json_schema",
      strict: "prefer",
    });
    expect(child.tools.get(FAIL_TOOL)).toBeDefined();
    expect(child.active()).toEqual(["read", RESULT_TOOL, FAIL_TOOL]);
  });

  it("accepts a valid answer and ends the run", async () => {
    const child = startChild(schemaFile);
    const answer = { count: 2, files: ["a.ts", "b.ts"] };
    expect(await child.call(RESULT_TOOL, answer)).toMatchObject({
      details: answer,
      terminate: true,
    });
    expect(child.settle()).toBeUndefined();
  });

  it("throws an invalid answer back with its errors, every time", async () => {
    const child = startChild(schemaFile);
    const bad = { count: "two", files: ["a.ts"] };
    for (let i = 0; i < 3; i++) {
      await expect(child.call(RESULT_TOOL, bad)).rejects.toThrow(
        /call jack_subagent_result again:\n- \/count: /,
      );
    }
    // Still waiting for an answer, so it gets nudged.
    expect(child.settle()).toMatchObject({ continue: true });
  });

  it("ends the run with the reason when the subagent gives up", async () => {
    const child = startChild(schemaFile);
    expect(await child.call(FAIL_TOOL, { reason: "no access" })).toMatchObject({
      details: { reason: "no access" },
      terminate: true,
    });
    expect(child.settle()).toBeUndefined();
  });

  it(`nudges an agent that stops without answering, at most ${MAX_FORMAT_RETRIES} times`, () => {
    const child = startChild(schemaFile);
    for (let i = 0; i < MAX_FORMAT_RETRIES; i++) {
      const nudge = child.settle();
      expect(nudge).toMatchObject({
        continue: true,
        entries: [{ type: "custom_message", display: false }],
      });
      expect(nudge.entries[0].content).toContain(RESULT_TOOL);
    }
    expect(child.settle()).toBeUndefined();
  });

  it("registers nothing, and reports why, when the schema file is unusable", () => {
    const child = startChild(path.join(tmp, "missing.json"));
    expect(child.tools.size).toBe(0);
    expect(child.logged).toEqual([
      expect.stringMatching(
        /^\[jack\] Could not load the schema: .*missing\.json/,
      ),
    ]);
  });
});
