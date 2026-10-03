/**
 * Tests the jack tool's execute() with `spawn` mocked, so no pi subprocess or model is involved.
 * Each fake child replays a scripted list of JSON events, then exits. A child answers the way child.ts makes a
 * real one answer: through `tool_execution_end` events of the jack_subagent_result / jack_subagent_fail tools.
 */

import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Value } from "typebox/value";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const agentDir = vi.hoisted(() => ({ current: "" }));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
  getAgentDir: () => agentDir.current,
}));

// Built-in agents come from <agentDir>/built-in, so tests control them like the user's agents.
vi.mock("../agents.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents.ts")>();
  return {
    ...actual,
    discoverAgents: () => actual.discoverAgents(`${agentDir.current}/built-in`),
  };
});

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

const { spawn } = await import("node:child_process");
const {
  default: extension,
  MAX_PARALLEL,
  DEFAULT_AGENT,
} = await import("../index.ts");
const {
  DEFAULT_SCHEMA,
  FAIL_TOOL,
  MAX_FORMAT_RETRIES,
  RESULT_TOOL,
  SCHEMA_FLAG,
} = await import("../contract.ts");

interface ChildScript {
  events?: object[];
  stderr?: string;
  exitCode?: number;
}

const usage = {
  input: 10,
  output: 5,
  cacheRead: 1,
  cacheWrite: 2,
  cost: { total: 0.01 },
};

function assistantEnd(text: string) {
  return {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }], usage },
  };
}

/** An accepted jack_subagent_result call carrying `answer`. */
function answered(answer: object) {
  return {
    type: "tool_execution_end",
    toolName: RESULT_TOOL,
    isError: false,
    result: { details: answer },
  };
}

/** A jack_subagent_result call the child rejected with `text`. */
function rejected(text: string) {
  return {
    type: "tool_execution_end",
    toolName: RESULT_TOOL,
    isError: true,
    result: { content: [{ text }] },
  };
}

function gaveUp(reason: string) {
  return {
    type: "tool_execution_end",
    toolName: FAIL_TOOL,
    isError: false,
    result: { details: { reason } },
  };
}

const okAnswer = { success: true, result: "done" };

// What each child was given, in spawn order (the temp files are deleted once the child exits).
let systemPrompts: (string | undefined)[] = [];
let schemas: unknown[] = [];

// Queue one script per expected child, in spawn order.
function scriptChildren(...scripts: ChildScript[]) {
  vi.mocked(spawn).mockImplementation(((_command: string, args: string[]) => {
    const promptFlag = args.indexOf("--append-system-prompt");
    systemPrompts.push(
      promptFlag >= 0
        ? fs.readFileSync(args[promptFlag + 1], "utf-8")
        : undefined,
    );
    schemas.push(
      JSON.parse(
        fs.readFileSync(args[args.indexOf(`--${SCHEMA_FLAG}`) + 1], "utf-8"),
      ),
    );
    const script = scripts.shift() ?? {};
    const proc = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
    setTimeout(() => {
      for (const event of script.events ?? [])
        proc.stdout.emit("data", Buffer.from(`${JSON.stringify(event)}\n`));
      if (script.stderr) proc.stderr.emit("data", Buffer.from(script.stderr));
      proc.emit("close", script.exitCode ?? 0);
    }, 5);
    return proc;
  }) as any);
}

function spawnArgs(call = 0): string[] {
  return vi.mocked(spawn).mock.calls[call][1] as string[];
}

function argAfter(flag: string, call = 0): string | undefined {
  const args = spawnArgs(call);
  return args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
}

function loadTool() {
  let tool: any;
  extension({ registerTool: (t: any) => (tool = t), on: () => {} } as any);
  return tool;
}

async function run(params: object) {
  return loadTool().execute("call-1", params, undefined, undefined);
}

const labelSchema = {
  type: "object",
  properties: { label: { type: "string" } },
  required: ["label"],
};

agentDir.current = fs.mkdtempSync(path.join(os.tmpdir(), "jack-test-"));
fs.mkdirSync(path.join(agentDir.current, "agents"));
fs.mkdirSync(path.join(agentDir.current, "built-in"));
fs.writeFileSync(
  path.join(agentDir.current, "agents", "probe.md"),
  "---\nname: probe\ndescription: Test probe\ntools: bash\nmodel: probe-model\n" +
    `schema: '${JSON.stringify(labelSchema)}'\n---\nYou are a probe.\n`,
);

afterAll(() => {
  fs.rmSync(agentDir.current, { recursive: true, force: true });
});

beforeEach(() => {
  vi.mocked(spawn).mockReset();
  systemPrompts = [];
  schemas = [];
});

describe("registration", () => {
  it("lists discovered agents in the tool description", () => {
    expect(loadTool().description).toContain("- probe: Test probe");
  });
});

describe("single task", () => {
  it("uses the default schema and returns the submitted answer as data", async () => {
    scriptChildren({
      events: [assistantEnd("calling the tool"), answered(okAnswer)],
    });
    const result = await run({ task: "say hello" });

    const [r] = result.structuredContent.results;
    expect(schemas[0]).toEqual(DEFAULT_SCHEMA);
    expect(result.isError).toBe(false);
    expect(r).toMatchObject({
      success: true,
      parsed: true,
      data: okAnswer,
      attempts: 1,
      agent: "direct",
    });
    expect(r.usage).toEqual({
      turns: 1,
      input: 10,
      output: 5,
      cacheRead: 1,
      cacheWrite: 2,
      cost: 0.01,
    });
    expect(result.content[0].text).toBe(
      `✓ direct: say hello\n${JSON.stringify(okAnswer, null, 2)}`,
    );
  });

  it("loads the child extension with the schema file and never lets the child call jack", async () => {
    scriptChildren({ events: [answered(okAnswer)] });
    await run({ task: "t", model: "m1" });

    const args = spawnArgs();
    expect(args).toEqual(
      expect.arrayContaining(["--mode", "json", "-p", "--no-session"]),
    );
    expect(argAfter("--exclude-tools")).toBe("jack");
    expect(argAfter("--extension")).toMatch(/jack\/child\.ts$/);
    expect(argAfter("--model")).toBe("m1");
    expect(args).not.toContain("--tools");
    expect(args.at(-1)).toBe("t");
  });

  it("adds the result tools to an explicit tool list", async () => {
    scriptChildren({ events: [answered(okAnswer)] });
    await run({ task: "t", tools: ["read", "grep"] });
    expect(argAfter("--tools")).toBe(`read,grep,${RESULT_TOOL},${FAIL_TOOL}`);
  });

  it("accepts the schema as an object, as inline JSON, or as a path relative to the working directory", async () => {
    const file = path.join(agentDir.current, "label.json");
    fs.writeFileSync(file, JSON.stringify(labelSchema));
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(agentDir.current);
    try {
      scriptChildren(
        ...[1, 2, 3].map(() => ({ events: [answered({ label: "x" })] })),
      );
      for (const schema of [
        labelSchema,
        JSON.stringify(labelSchema),
        "label.json",
      ]) {
        const result = await run({ task: "t", schema });
        expect(result.structuredContent.results[0]).toMatchObject({
          success: true,
          data: { label: "x" },
        });
      }
      expect(schemas).toEqual([labelSchema, labelSchema, labelSchema]);
    } finally {
      cwd.mockRestore();
    }
  });

  it("fails without spawning when the schema is unusable", async () => {
    const typo = {
      type: "object",
      properties: { a: { type: "strin" } },
      requried: ["a"],
    };
    for (const schema of [
      "{not json",
      "missing.json",
      { type: "array", items: { type: "string" } },
      typo,
    ]) {
      const result = await run({ task: "t", schema });
      expect(result.structuredContent.results[0].error).toMatch(
        /^Invalid schema: /,
      );
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  it("fails with the reason the subagent gave to jack_subagent_fail", async () => {
    scriptChildren({ events: [gaveUp("repo not found")] });
    const result = await run({ task: "t" });

    expect(result.isError).toBe(true);
    expect(result.structuredContent.results[0]).toMatchObject({
      success: false,
      parsed: false,
      data: null,
      error: "repo not found",
    });
  });

  it("counts rejected answers and returns the accepted one", async () => {
    scriptChildren({
      events: [rejected("bad 1"), rejected("bad 2"), answered(okAnswer)],
    });
    const result = await run({ task: "t" });

    expect(result.structuredContent.results[0]).toMatchObject({
      success: true,
      data: okAnswer,
      attempts: 3,
    });
    expect(result.content[0].text).toMatch(/^✓ direct: t \(3 attempts\)/);
  });

  it("reports the last rejection when no answer was accepted", async () => {
    scriptChildren({
      events: [rejected("bad 1"), rejected("/success: Expected boolean")],
    });
    const result = await run({ task: "t" });

    expect(result.structuredContent.results[0]).toMatchObject({
      success: false,
      attempts: 2,
      error: "No valid answer after 2 attempts. /success: Expected boolean",
    });
  });

  it(`stops the child once it has rejected more than MAX_FORMAT_RETRIES answers`, async () => {
    const rejections = Array.from({ length: MAX_FORMAT_RETRIES + 1 }, (_, i) =>
      rejected(`bad ${i + 1}`),
    );
    scriptChildren({
      events: [...rejections, rejected("never seen")],
      exitCode: 143,
    });
    let killed = false;
    const original = vi.mocked(spawn).getMockImplementation()!;
    vi.mocked(spawn).mockImplementation(((...args: any[]) => {
      const proc = (original as any)(...args);
      proc.kill = vi.fn(() => (killed = true));
      return proc;
    }) as any);
    const result = await run({ task: "t" });

    expect(killed).toBe(true);
    expect(result.structuredContent.results[0]).toMatchObject({
      success: false,
      error: `No valid answer after ${MAX_FORMAT_RETRIES + 2} attempts. never seen`,
    });
  });

  it("fails when the subagent never calls jack_subagent_result", async () => {
    scriptChildren({ events: [assistantEnd("here is my answer in prose")] });
    const result = await run({ task: "t" });

    expect(result.structuredContent.results[0]).toMatchObject({
      success: false,
      attempts: 0,
      raw: "here is my answer in prose",
      error: `The subagent finished without calling ${RESULT_TOOL}.`,
    });
  });

  it("validates the answer again, in case the child let a bad one through", async () => {
    scriptChildren({ events: [answered({ result: "no success flag" })] });
    const result = await run({ task: "t" });

    const [r] = result.structuredContent.results;
    expect(r).toMatchObject({
      success: false,
      parsed: true,
      data: { result: "no success flag" },
    });
    expect(r.error).toMatch(
      /^The answer does not match the schema: \/: .*success/,
    );
  });

  it("reports stderr when the child exits non-zero", async () => {
    scriptChildren({ stderr: "boom", exitCode: 2 });
    const result = await run({ task: "t" });

    expect(result.isError).toBe(true);
    expect(result.structuredContent.results[0]).toMatchObject({
      success: false,
      error: "boom",
    });
    expect(result.content[0].text).toContain("Error: boom");
  });

  it("rejects a call with neither task nor tasks", async () => {
    const result = await run({});
    expect(result.isError).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("named agent", () => {
  it("uses the agent's tools, model, prompt and default schema, ignoring call-level tools", async () => {
    scriptChildren({ events: [answered({ label: "a" })] });
    const result = await run({
      agent: "probe",
      task: "label: a",
      tools: "ignored",
    });

    expect(argAfter("--model")).toBe("probe-model");
    expect(argAfter("--tools")).toBe(`bash,${RESULT_TOOL},${FAIL_TOOL}`);
    expect(systemPrompts[0]).toBe("You are a probe.");
    expect(schemas[0]).toEqual(labelSchema);
    expect(result.structuredContent.results[0]).toMatchObject({
      success: true,
      data: { label: "a" },
      agent: "probe",
    });
  });

  it("lets the call's model win over the agent's, for every task in a batch", async () => {
    scriptChildren(
      { events: [answered({ label: "a" })] },
      { events: [answered({ label: "b" })] },
    );
    await run({
      agent: "probe",
      model: "other/model",
      tasks: [{ task: "label: a" }, { task: "label: b" }],
    });
    expect([argAfter("--model", 0), argAfter("--model", 1)]).toEqual([
      "other/model",
      "other/model",
    ]);
  });

  it("lets the call's schema win over the agent's", async () => {
    scriptChildren({ events: [answered(okAnswer)] });
    await run({ agent: "probe", task: "t", schema: DEFAULT_SCHEMA });
    expect(schemas[0]).toEqual(DEFAULT_SCHEMA);
  });

  it("resolves a frontmatter schema path relative to the agent's folder, and accepts YAML", async () => {
    const agents = path.join(agentDir.current, "agents");
    fs.mkdirSync(path.join(agents, "schemas"), { recursive: true });
    fs.writeFileSync(
      path.join(agents, "schemas", "label.json"),
      JSON.stringify(labelSchema),
    );
    fs.writeFileSync(
      path.join(agents, "by-path.md"),
      "---\nname: by-path\ndescription: d\nschema: schemas/label.json\n---\nx\n",
    );
    fs.writeFileSync(
      path.join(agents, "by-yaml.md"),
      "---\nname: by-yaml\ndescription: d\nschema:\n  type: object\n  properties:\n    label:\n      type: string\n" +
        "      description: The label.\n  required: [label]\n---\nx\n",
    );
    try {
      scriptChildren(
        { events: [answered({ label: "a" })] },
        { events: [answered({ label: "b" })] },
      );
      await run({ agent: "by-path", task: "t" });
      await run({ agent: "by-yaml", task: "t" });

      expect(schemas[0]).toEqual(labelSchema);
      expect(schemas[1]).toEqual({
        type: "object",
        properties: { label: { type: "string", description: "The label." } },
        required: ["label"],
      });
    } finally {
      for (const f of ["by-path.md", "by-yaml.md", "schemas"])
        fs.rmSync(path.join(agents, f), { recursive: true });
    }
  });

  it("removes the temporary files afterwards", async () => {
    scriptChildren({ events: [answered({ label: "a" })] });
    await run({ agent: "probe", task: "label: a" });
    expect(fs.existsSync(path.dirname(argAfter(`--${SCHEMA_FLAG}`)!))).toBe(
      false,
    );
  });

  it("names agent files that failed to load when an agent is not found", async () => {
    const broken = path.join(agentDir.current, "agents", "broken.md");
    fs.writeFileSync(broken, "---\nname: broken\ndescription: [\n---\nx\n");
    try {
      const result = await run({ agent: "nope", task: "t" });

      expect(spawn).not.toHaveBeenCalled();
      expect(result.structuredContent.results[0].error).toMatch(
        /^Unknown agent: "nope"\. Available: "probe"\. Agent files that failed to load: broken\.md \(.+\)\./,
      );
    } finally {
      fs.rmSync(broken);
    }
  });

  it("fails with the load error when the requested agent's own file is broken", async () => {
    const broken = path.join(agentDir.current, "agents", "broken.md");
    fs.writeFileSync(broken, "---\nname: broken\ndescription: [\n---\nx\n");
    try {
      const result = await run({ agent: "broken", task: "t" });
      expect(spawn).not.toHaveBeenCalled();
      expect(result.structuredContent.results[0].error).toMatch(
        /^The agent file broken\.md could not be loaded: /,
      );
    } finally {
      fs.rmSync(broken);
    }
  });

  it("warns the user at session start when agent files failed to load", () => {
    const broken = path.join(agentDir.current, "agents", "broken.md");
    fs.writeFileSync(broken, "---\nname: broken\ndescription: [\n---\nx\n");
    try {
      const handlers: Record<string, any> = {};
      extension({
        registerTool: () => {},
        on: (event: string, h: any) => (handlers[event] = h),
      } as any);
      const notify = vi.fn();
      handlers.session_start({}, { hasUI: true, ui: { notify } });
      expect(notify).toHaveBeenCalledWith(
        expect.stringMatching(/failed to load: broken\.md/),
        "warning",
      );
    } finally {
      fs.rmSync(broken);
    }
  });

  it("fails cleanly for an unknown agent and lists the available ones", async () => {
    const result = await run({ agent: "nope", task: "t" });

    expect(spawn).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.structuredContent.results[0].error).toMatch(
      /Unknown agent: "nope"\. Available: "probe"\./,
    );
  });
});

describe("built-in agents", () => {
  const builtIn = path.join(agentDir.current, "built-in", "helper.md");
  const override = path.join(agentDir.current, "agents", "helper.md");

  beforeEach(() => {
    fs.writeFileSync(
      builtIn,
      "---\nname: helper\ndescription: Built-in helper\n---\nBuilt-in prompt.\n",
    );
  });

  afterEach(() => {
    fs.rmSync(builtIn, { force: true });
    fs.rmSync(override, { force: true });
  });

  it("are listed as built-in and can be run", async () => {
    scriptChildren({ events: [answered(okAnswer)] });
    const description = loadTool().description;
    await run({ agent: "helper", task: "t" });

    expect(description).toContain("- helper (built-in): Built-in helper");
    expect(systemPrompts[0]).toBe("Built-in prompt.");
  });

  it("can be overridden by a user agent of the same name", async () => {
    fs.writeFileSync(
      override,
      "---\nname: helper\ndescription: My helper\n---\nMy prompt.\n",
    );
    scriptChildren({ events: [answered(okAnswer)] });
    const description = loadTool().description;
    await run({ agent: "helper", task: "t" });

    expect(description).toContain(
      "- helper (yours, overrides built-in): My helper",
    );
    expect(systemPrompts[0]).toBe("My prompt.");
  });

  it("are not used in place of a user override whose file is broken", async () => {
    fs.writeFileSync(override, "---\nname: helper\ndescription: [\n---\nx\n");
    const result = await run({ agent: "helper", task: "t" });

    expect(spawn).not.toHaveBeenCalled();
    expect(result.structuredContent.results[0].error).toMatch(
      /^The agent file helper\.md could not be loaded: /,
    );
  });
});

describe("default agent", () => {
  const workerFile = path.join(
    agentDir.current,
    "agents",
    `${DEFAULT_AGENT}.md`,
  );

  beforeEach(() => {
    fs.writeFileSync(
      workerFile,
      `---\nname: ${DEFAULT_AGENT}\ndescription: Default\n---\nYou are a worker.\n`,
    );
  });

  afterEach(() => {
    fs.rmSync(workerFile, { force: true });
  });

  it("runs the default agent when `agent` is omitted", async () => {
    scriptChildren({ events: [answered(okAnswer)] });
    const result = await run({ task: "t" });

    expect(systemPrompts[0]).toBe("You are a worker.");
    expect(result.structuredContent.results[0]).toMatchObject({
      success: true,
      agent: DEFAULT_AGENT,
    });
  });

  it("fails instead of running a bare agent when the default agent file is broken", async () => {
    fs.writeFileSync(workerFile, "---\nname: worker\ndescription: [\n---\nx\n");
    const result = await run({ task: "t" });

    expect(spawn).not.toHaveBeenCalled();
    expect(result.structuredContent.results[0].error).toMatch(
      new RegExp(
        `^The default agent file ${DEFAULT_AGENT}\\.md could not be loaded: `,
      ),
    );
  });

  it("appends a call-level system_prompt and passes tools and model", async () => {
    scriptChildren({ events: [answered(okAnswer)] });
    await run({
      task: "t",
      system_prompt: "Be brief.",
      tools: "read",
      model: "m1",
    });

    expect(systemPrompts[0]).toBe("You are a worker.\n\nBe brief.");
    expect(argAfter("--tools")).toBe(`read,${RESULT_TOOL},${FAIL_TOOL}`);
    expect(argAfter("--model")).toBe("m1");
  });
});

describe("batch", () => {
  it("lets items inherit top-level defaults and keeps results in order", async () => {
    scriptChildren(
      { events: [answered({ ...okAnswer, result: "one" })] },
      { events: [answered({ ...okAnswer, result: "two" })] },
    );
    const result = await run({
      model: "shared",
      tasks: [{ task: "a" }, { task: "b", model: "own" }],
    });

    expect(spawnArgs(0)).toContain("shared");
    expect(spawnArgs(1)).toContain("own");
    expect(
      result.structuredContent.results.map((r: any) => r.data.result),
    ).toEqual(["one", "two"]);
    expect(result.content[0].text).toMatch(
      /^\[1\/2\] ✓ direct: a\n[\s\S]*"one"[\s\S]*\n\n\[2\/2\] ✓ direct: b\n[\s\S]*"two"/,
    );
  });

  it("marks the whole call as an error when any item fails", async () => {
    scriptChildren({ events: [answered(okAnswer)] }, { exitCode: 1 });
    const result = await run({ tasks: [{ task: "a" }, { task: "b" }] });

    expect(result.isError).toBe(true);
    expect(result.structuredContent.results.map((r: any) => r.success)).toEqual(
      [true, false],
    );
  });

  it("runs sequentially by default and up to MAX_PARALLEL at once when asked", async () => {
    const tasks = Array.from({ length: MAX_PARALLEL + 2 }, (_, i) => ({
      task: `t${i}`,
    }));
    const peakSpawned = async (params: object) => {
      scriptChildren(...tasks.map(() => ({ events: [answered(okAnswer)] })));
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
    expect(await peakSpawned({ tasks, run_mode: "parallel" })).toBe(
      MAX_PARALLEL,
    );
  });
});

describe("debug_mode", () => {
  it("adds nothing when it is off", async () => {
    scriptChildren({ events: [answered(okAnswer)] });
    const result = await run({ task: "t" });
    expect(result.content[0].text).not.toContain("Debug:");
    expect(result.details.setups).toBeUndefined();
  });

  it("shows each subagent's setup, and where each piece came from", async () => {
    scriptChildren({ events: [answered({ label: "a" })] });
    const result = await run({
      debug_mode: true,
      agent: "probe",
      model: "other/model",
      task: "label: a",
    });

    const [setup] = result.details.setups;
    expect(setup).toMatchObject({
      agent: "probe",
      agentSource: "user",
      prompt: ["agent"],
      model: "other/model",
      modelFrom: "call",
      tools: ["bash", RESULT_TOOL, FAIL_TOOL],
      toolsFrom: "agent",
      schema: labelSchema,
      schemaFrom: "agent",
    });
    expect(setup.command.slice(-spawnArgs().length)).toEqual(spawnArgs());

    const text = result.content[0].text;
    expect(text).toMatch(
      /^Debug: how each subagent was set up\n\[1\] label: a\n/,
    );
    expect(text).toContain("agent: probe (yours)");
    expect(text).toContain("model: other/model (from the call)");
    expect(text).toContain(
      `tools: bash, ${RESULT_TOOL}, ${FAIL_TOOL} (from the agent)`,
    );
    expect(text).toContain(
      `schema (from the agent): ${JSON.stringify(labelSchema)}`,
    );
    expect(text).toContain("command: ");
    expect(text).toContain("'label: a'");
  });

  it("describes the default agent with the call's prompt, tools and schema", async () => {
    scriptChildren({ events: [answered(okAnswer)] });
    const result = await run({
      debug_mode: true,
      task: "t",
      system_prompt: "Be brief.",
      tools: "read",
      schema: DEFAULT_SCHEMA,
    });
    expect(result.details.setups[0]).toMatchObject({
      prompt: ["call"],
      modelFrom: undefined,
      toolsFrom: "call",
      schemaFrom: "call",
    });
    expect(result.content[0].text).toContain(
      "system prompt: pi's, plus the call's system_prompt",
    );
    expect(result.content[0].text).toContain("model: pi's default");
  });

  it("streams the setup with the progress, and notes tasks that never started a child", async () => {
    scriptChildren({ events: [answered(okAnswer)] });
    const updates: string[] = [];
    const result = await loadTool().execute(
      "call-1",
      {
        debug_mode: true,
        tasks: [{ task: "good" }, { task: "bad", agent: "nope" }],
      },
      undefined,
      (u: any) => updates.push(u.content[0].text),
    );

    expect(
      updates.some((u) => u.includes("[1] good — starting\n    agent: ")),
    ).toBe(true);
    expect(result.content[0].text).toContain(
      "[2] bad\n    (no child was started)",
    );
  });
});

describe("thinking", () => {
  /** An assistant turn that ran on `model` at `thinking`, as pi records it on the message. */
  const turn = (model: string, thinking: string) => ({
    type: "message_end",
    message: {
      role: "assistant",
      content: [],
      usage,
      provider: "prov",
      model,
      thinkingLevel: thinking,
    },
  });

  beforeEach(() => {
    fs.writeFileSync(
      path.join(agentDir.current, "agents", "deep.md"),
      "---\nname: deep\ndescription: Thinks hard\nthinking: high\n---\nThink.\n",
    );
  });
  afterEach(() => fs.rmSync(path.join(agentDir.current, "agents", "deep.md")));

  it("passes no level when neither the call nor the agent sets one", async () => {
    scriptChildren({ events: [answered(okAnswer)] });
    await run({ task: "t" });
    expect(spawnArgs()).not.toContain("--thinking");
  });

  it("passes the call's level to pi's --thinking", async () => {
    scriptChildren({ events: [answered(okAnswer)] });
    await run({ task: "t", thinking: "xhigh" });
    expect(argAfter("--thinking")).toBe("xhigh");
  });

  it("uses the agent's level unless the call gives one, per batch item too", async () => {
    scriptChildren(
      { events: [answered(okAnswer)] },
      { events: [answered(okAnswer)] },
      { events: [answered(okAnswer)] },
    );
    await run({ agent: "deep", task: "t" });
    await run({
      agent: "deep",
      thinking: "low",
      tasks: [{ task: "a" }, { task: "b", thinking: "max" }],
    });
    expect([0, 1, 2].map((i) => argAfter("--thinking", i))).toEqual([
      "high",
      "low",
      "max",
    ]);
  });

  it("records the model and level the subagent ran with, and shows them in debug_mode", async () => {
    scriptChildren({ events: [turn("m", "medium"), answered(okAnswer)] });
    const result = await run({ debug_mode: true, agent: "deep", task: "t" });

    expect(result.structuredContent.results[0].ranWith).toEqual({
      model: "prov/m",
      thinking: "medium",
    });
    expect(result.details.setups[0]).toMatchObject({
      thinking: "high",
      thinkingFrom: "agent",
    });
    const text = result.content[0].text;
    expect(text).toContain(
      "thinking: high (from the agent), or the nearest level the model supports",
    );
    expect(text).toContain("ran with: prov/m, thinking medium");
  });

  it("rejects a level that isn't offered", () => {
    expect(
      Value.Check(loadTool().parameters, { task: "t", thinking: "minimal" }),
    ).toBe(false);
    expect(
      Value.Check(loadTool().parameters, { task: "t", thinking: "max" }),
    ).toBe(true);
  });
});
