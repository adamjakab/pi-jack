/**
 * Tests the subagent_runner tool's execute() with `spawn` mocked, so no pi subprocess or model is involved.
 * Each fake child replays a scripted list of JSON events, then exits.
 */

import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const agentDir = vi.hoisted(() => ({ current: "" }));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
  getAgentDir: () => agentDir.current,
}));

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

const { spawn } = await import("node:child_process");
const { default: extension, MAX_PARALLEL, DEFAULT_AGENT, DEFAULT_SCHEMA } = await import("../index.ts");

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

// System prompt each child was given, in spawn order (the file itself is deleted once the child exits).
let systemPrompts: (string | undefined)[] = [];

// Queue one script per expected child, in spawn order.
function scriptChildren(...scripts: ChildScript[]) {
  vi.mocked(spawn).mockImplementation(((_command: string, args: string[]) => {
    const promptFlag = args.indexOf("--append-system-prompt");
    systemPrompts.push(promptFlag >= 0 ? fs.readFileSync(args[promptFlag + 1], "utf-8") : undefined);
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
  systemPrompts = [];
});

describe("registration", () => {
  it("lists discovered agents in the tool description", () => {
    expect(loadTool().description).toContain("- probe: Test probe");
  });
});

describe("single task", () => {
  it("uses the default schema when neither the call nor the agent gives one", async () => {
    scriptChildren({ events: [assistantEnd('{"result": "hello"}')] });
    const result = await run({ task: "say hello" });

    const [r] = result.structuredContent.results;
    expect(systemPrompts[0]).toMatch(/^## Output contract\n[\s\S]*\n\{"result": "text"\}$/);
    expect(systemPrompts[0]).toContain(DEFAULT_SCHEMA);
    expect(result.isError).toBe(false);
    expect(r).toMatchObject({ success: true, parsed: true, data: { result: "hello" }, agent: "direct" });
    expect(r.usage).toEqual({ turns: 1, input: 10, output: 5, cacheRead: 1, cacheWrite: 2, cost: 0.01 });
    expect(result.content[0].text).toBe('✓ direct: say hello\n{"result": "hello"}');
  });

  it("fails when a reply without a schema is not JSON", async () => {
    scriptChildren({ events: [assistantEnd("hello")] });
    const result = await run({ task: "say hello" });

    expect(result.isError).toBe(true);
    expect(result.structuredContent.results[0]).toMatchObject({ success: false, parsed: false, raw: "hello" });
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

  it("puts the output contract in the system prompt and parses a fenced JSON reply", async () => {
    scriptChildren({ events: [assistantEnd('```json\n{"count": 3}\n```')] });
    const result = await run({ task: "count", schema: '{"count": "number"}' });

    expect(systemPrompts[0]).toMatch(/^## Output contract\n[\s\S]*\n\{"count": "number"\}$/);
    expect(spawnArgs().at(-1)).toMatch(/^count\n[\s\S]*only the JSON/);
    expect(result.structuredContent.results[0]).toMatchObject({ success: true, parsed: true, data: { count: 3 } });
  });

  it("fails with the agent's reason when it replies with the contract's error form", async () => {
    scriptChildren({ events: [assistantEnd('{"subagent_error": "repo not found"}')] });
    const result = await run({ task: "count", schema: '{"count": "number"}' });

    expect(result.isError).toBe(true);
    expect(result.structuredContent.results[0]).toMatchObject({
      success: false,
      parsed: true,
      data: { subagent_error: "repo not found" },
      error: "repo not found",
    });
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
    expect(systemPrompts[0]).toContain('{"label": "string"}');
    expect(result.structuredContent.results[0]).toMatchObject({ success: true, parsed: true, agent: "probe" });
  });

  it("appends the output contract after the agent's own prompt", async () => {
    scriptChildren({ events: [assistantEnd('{"label": "a"}')] });
    await run({ agent: "probe", task: "label: a" });
    expect(systemPrompts[0]).toMatch(/You are a probe\.\n+## Output contract\n[\s\S]*\{"label": "string"\}$/);
  });

  it("fills the agent's {{schema}} placeholder instead of appending the generic contract", async () => {
    fs.writeFileSync(
      path.join(agentDir.current, "agents", "templated.md"),
      "---\nname: templated\ndescription: d\n---\nReturn {{schema}}.\n",
    );
    scriptChildren({ events: [assistantEnd('{"n": 1}')] }, { events: [assistantEnd('{"result": "x"}')] });
    await run({ agent: "templated", task: "t", schema: '{"n": "number"}' });
    await run({ agent: "templated", task: "t" });

    fs.rmSync(path.join(agentDir.current, "agents", "templated.md"));
    expect(systemPrompts).toEqual(['Return {"n": "number"}.', `Return ${DEFAULT_SCHEMA}.`]);
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
    expect(result.structuredContent.results[0].error).toMatch(/Unknown agent: "nope"\. Available: "probe"\./);
  });
});

describe("default agent", () => {
  const workerFile = path.join(agentDir.current, "agents", `${DEFAULT_AGENT}.md`);

  beforeEach(() => {
    fs.writeFileSync(workerFile, `---\nname: ${DEFAULT_AGENT}\ndescription: Default\n---\nYou are a worker.\n`);
  });

  afterEach(() => {
    fs.rmSync(workerFile, { force: true });
  });

  it("runs the default agent when `agent` is omitted", async () => {
    scriptChildren({ events: [assistantEnd('{"result": "done"}')] });
    const result = await run({ task: "t" });

    expect(systemPrompts[0]).toContain("You are a worker.");
    expect(result.structuredContent.results[0]).toMatchObject({ success: true, agent: DEFAULT_AGENT });
  });

  it("appends a call-level system_prompt, then the output contract, and passes tools and model", async () => {
    scriptChildren({ events: [assistantEnd('{"n": 1}')] });
    await run({ task: "t", system_prompt: "Be brief.", tools: "read", model: "m1", schema: '{"n": "number"}' });

    expect(systemPrompts[0]).toMatch(/You are a worker\.[\s\S]*Be brief\.[\s\S]*## Output contract/);
    const args = spawnArgs();
    expect(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2)).toEqual(["--tools", "read"]);
    expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual(["--model", "m1"]);
  });
});

describe("batch", () => {
  it("lets items inherit top-level defaults and keeps results in order", async () => {
    scriptChildren({ events: [assistantEnd('{"result": "one"}')] }, { events: [assistantEnd('{"result": "two"}')] });
    const result = await run({ model: "shared", tasks: [{ task: "a" }, { task: "b", model: "own" }] });

    expect(spawnArgs(0)).toContain("shared");
    expect(spawnArgs(1)).toContain("own");
    expect(result.structuredContent.results.map((r: any) => r.data.result)).toEqual(["one", "two"]);
    expect(result.content[0].text).toMatch(/^\[1\/2\] ✓ direct: a\n.*"one"\}\n\n\[2\/2\] ✓ direct: b\n.*"two"\}$/);
  });

  it("marks the whole call as an error when any item fails", async () => {
    scriptChildren({ events: [assistantEnd('{"result": "ok"}')] }, { exitCode: 1 });
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
