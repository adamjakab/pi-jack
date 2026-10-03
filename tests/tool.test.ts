/**
 * Tests the subagent_runner tool's execute() with `spawn` mocked, so no pi subprocess or model is involved.
 * Each fake child replays a scripted list of JSON events, then exits.
 */

import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const agentDir = vi.hoisted(() => ({ current: "" }));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
  getAgentDir: () => agentDir.current,
}));

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

const { spawn } = await import("node:child_process");
const { default: extension, MAX_PARALLEL } = await import("../index.ts");

interface ChildScript {
  events?: object[];
  stderr?: string;
  exitCode?: number;
}

function assistantEnd(text: string) {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      usage: { input: 10, output: 5, cacheRead: 1, cacheWrite: 2, cost: { total: 0.01 } },
    },
  };
}

// Queue one script per expected child, in spawn order.
function scriptChildren(...scripts: ChildScript[]) {
  vi.mocked(spawn).mockImplementation((() => {
    const script = scripts.shift() ?? {};
    const proc = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
    setTimeout(() => {
      for (const event of script.events ?? []) proc.stdout.emit("data", Buffer.from(`${JSON.stringify(event)}\n`));
      if (script.stderr) proc.stderr.emit("data", Buffer.from(script.stderr));
      proc.emit("close", script.exitCode ?? 0);
    }, 5);
    return proc;
  }) as any);
}

function spawnArgs(call = 0): string[] {
  return vi.mocked(spawn).mock.calls[call][1] as string[];
}

function loadTool() {
  let tool: any;
  extension({ registerTool: (t: any) => (tool = t) } as any);
  return tool;
}

async function run(params: object) {
  return loadTool().execute("call-1", params, undefined, undefined);
}

agentDir.current = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-runner-test-"));
fs.mkdirSync(path.join(agentDir.current, "agents"));
fs.writeFileSync(
  path.join(agentDir.current, "agents", "probe.md"),
  "---\nname: probe\ndescription: Test probe\ntools: bash\nmodel: probe-model\n" +
    "schema: '{\"label\": \"string\"}'\n---\nYou are a probe.\n",
);

afterAll(() => {
  fs.rmSync(agentDir.current, { recursive: true, force: true });
});

beforeEach(() => {
  vi.mocked(spawn).mockReset();
});

describe("registration", () => {
  it("lists discovered agents in the tool description", () => {
    expect(loadTool().description).toContain("- probe: Test probe");
  });
});

describe("single task", () => {
  it("wraps a free-form reply as { response } when there is no schema", async () => {
    scriptChildren({ events: [assistantEnd("hello")] });
    const result = await run({ task: "say hello" });

    const [r] = result.structuredContent.results;
    expect(result.isError).toBe(false);
    expect(r).toMatchObject({ success: true, parsed: false, data: { response: "hello" }, agent: "direct" });
    expect(r.usage).toEqual({ turns: 1, input: 10, output: 5, cacheRead: 1, cacheWrite: 2, cost: 0.01 });
    expect(result.content[0].text).toBe("✓ direct: say hello\nhello");
  });

  it("passes model and tools, and never lets the child call subagent_runner", async () => {
    scriptChildren({ events: [assistantEnd("ok")] });
    await run({ task: "t", model: "m1", tools: ["read", "grep"] });

    const args = spawnArgs();
    expect(args).toEqual(expect.arrayContaining(["--mode", "json", "-p", "--no-session"]));
    expect(args.slice(args.indexOf("--exclude-tools"), args.indexOf("--exclude-tools") + 2)).toEqual([
      "--exclude-tools",
      "subagent_runner",
    ]);
    expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual(["--model", "m1"]);
    expect(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2)).toEqual(["--tools", "read,grep"]);
  });

  it("parses JSON output, including a fenced block, when a schema is given", async () => {
    scriptChildren({ events: [assistantEnd('```json\n{"count": 3}\n```')] });
    const result = await run({ task: "count", schema: '{"count": "number"}' });

    expect(spawnArgs().at(-1)).toContain('Match this shape:\n{"count": "number"}');
    expect(result.structuredContent.results[0]).toMatchObject({ success: true, parsed: true, data: { count: 3 } });
  });

  it("fails when the schema reply is not valid JSON", async () => {
    scriptChildren({ events: [assistantEnd("not json")] });
    const result = await run({ task: "count", schema: '{"count": "number"}' });

    expect(result.isError).toBe(true);
    expect(result.structuredContent.results[0]).toMatchObject({ success: false, parsed: false });
    expect(result.structuredContent.results[0].error).toBeTruthy();
  });

  it("reports stderr when the child exits non-zero", async () => {
    scriptChildren({ stderr: "boom", exitCode: 2 });
    const result = await run({ task: "t" });

    expect(result.isError).toBe(true);
    expect(result.structuredContent.results[0]).toMatchObject({ success: false, error: "boom" });
    expect(result.content[0].text).toContain("Error: boom");
  });

  it("reports missing output when the child says nothing", async () => {
    scriptChildren({});
    const result = await run({ task: "t" });
    expect(result.structuredContent.results[0]).toMatchObject({ success: false, error: "No output" });
  });

  it("rejects a call with neither task nor tasks", async () => {
    const result = await run({});
    expect(result.isError).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("named agent", () => {
  it("uses the agent's tools, model, prompt file and default schema", async () => {
    scriptChildren({ events: [assistantEnd('{"label": "a"}')] });
    const result = await run({ agent: "probe", task: "label: a", model: "ignored" });

    const args = spawnArgs();
    expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual(["--model", "probe-model"]);
    expect(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2)).toEqual(["--tools", "bash"]);
    expect(args[args.indexOf("--append-system-prompt") + 1]).toMatch(/prompt-probe\.md$/);
    expect(args.at(-1)).toContain('{"label": "string"}');
    expect(result.structuredContent.results[0]).toMatchObject({ success: true, parsed: true, agent: "probe" });
  });

  it("removes the temporary prompt file afterwards", async () => {
    scriptChildren({ events: [assistantEnd('{"label": "a"}')] });
    await run({ agent: "probe", task: "label: a" });

    const promptFile = spawnArgs()[spawnArgs().indexOf("--append-system-prompt") + 1];
    expect(fs.existsSync(path.dirname(promptFile))).toBe(false);
  });

  it("fails cleanly for an unknown agent and lists the available ones", async () => {
    const result = await run({ agent: "nope", task: "t" });

    expect(spawn).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.structuredContent.results[0].error).toMatch(/Unknown agent: "nope"\. Available: "probe"/);
  });
});

describe("batch", () => {
  it("lets items inherit top-level defaults and keeps results in order", async () => {
    scriptChildren({ events: [assistantEnd("one")] }, { events: [assistantEnd("two")] });
    const result = await run({ model: "shared", tasks: [{ task: "a" }, { task: "b", model: "own" }] });

    expect(spawnArgs(0)).toContain("shared");
    expect(spawnArgs(1)).toContain("own");
    expect(result.structuredContent.results.map((r: any) => r.data.response)).toEqual(["one", "two"]);
    expect(result.content[0].text).toMatch(/^\[1\/2\] ✓ direct: a\none\n\n\[2\/2\] ✓ direct: b\ntwo$/);
  });

  it("marks the whole call as an error when any item fails", async () => {
    scriptChildren({ events: [assistantEnd("ok")] }, { exitCode: 1 });
    const result = await run({ tasks: [{ task: "a" }, { task: "b" }] });

    expect(result.isError).toBe(true);
    expect(result.structuredContent.results.map((r: any) => r.success)).toEqual([true, false]);
  });

  it("runs sequentially by default and up to MAX_PARALLEL at once when asked", async () => {
    const tasks = Array.from({ length: MAX_PARALLEL + 2 }, (_, i) => ({ task: `t${i}` }));
    const peakSpawned = async (params: object) => {
      scriptChildren(...tasks.map(() => ({ events: [assistantEnd("ok")] })));
      let active = 0;
      let peak = 0;
      const original = vi.mocked(spawn).getMockImplementation()!;
      vi.mocked(spawn).mockImplementation(((...args: any[]) => {
        peak = Math.max(peak, ++active);
        const proc = (original as any)(...args);
        proc.on("close", () => active--);
        return proc;
      }) as any);
      await run(params);
      return peak;
    };

    expect(await peakSpawned({ tasks })).toBe(1);
    expect(await peakSpawned({ tasks, run_mode: "parallel" })).toBe(MAX_PARALLEL);
  });
});
