/**
 * Subagent Runner — delegates tasks to isolated pi subprocesses with structured JSON output.
 *
 * Supports single task or batch execution with configurable concurrency.
 *
 * Modes:
 *   - Single:  { task: "...", agent?: "...", system_prompt?: "...", ... }
 *   - Batch:   { tasks: [{ task: "..." }, ...], run_mode: "sequential" | "parallel" }
 *
 * Child runs: pi --mode json -p --no-session
 * Optional schema parameter forces JSON-only output from the subagent.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { discoverAgents } from "./agents.ts";

const MAX_PARALLEL = 4;

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }

  return { command: "pi", args };
}

async function writeTempPrompt(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
  await withFileMutationQueue(filePath, async () => {
    await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
  });
  return { dir: tmpDir, filePath };
}

function normalizeTools(value: unknown): string[] | undefined {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const tools = raw
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.trim())
    .filter(Boolean);
  return tools.length > 0 ? tools : undefined;
}

interface SubagentUsage {
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

interface SingleResult {
  success: boolean;
  parsed: boolean;
  data: any;
  raw: string;
  agent: string;
  task: string;
  error?: string;
  usage: SubagentUsage;
}

const taskItemSchema = Type.Object({
  task: Type.String({ description: "Task description for this subagent" }),
  agent: Type.Optional(Type.String({ description: "Agent name (defaults to top-level agent)" })),
  system_prompt: Type.Optional(Type.String({ description: "System prompt override for this task" })),
  tools: Type.Optional(
    Type.Union([Type.String(), Type.Array(Type.String())], { description: "Tools for this task" }),
  ),
  model: Type.Optional(Type.String({ description: "Model override for this task" })),
});

const outputSchema = Type.Object({
  results: Type.Array(
    Type.Object({
      success: Type.Boolean(),
      parsed: Type.Boolean(),
      data: Type.Any(),
      raw: Type.String(),
      agent: Type.String(),
      task: Type.String(),
      error: Type.Optional(Type.String()),
      usage: Type.Object({
        turns: Type.Number(),
        input: Type.Number(),
        output: Type.Number(),
        cacheRead: Type.Number(),
        cacheWrite: Type.Number(),
        cost: Type.Number(),
      }),
    }),
  ),
});

async function runSingleSubagent(
  taskText: string,
  agentNameInput: string | undefined,
  systemPromptInput: string | undefined,
  toolsInput: unknown,
  modelInput: string | undefined,
  schemaHint: string | undefined,
  signal: AbortSignal | undefined,
): Promise<SingleResult> {
  let systemPrompt: string = "";
  let tools: string[] | undefined;
  let model: string | undefined;
  let resolvedAgentName = agentNameInput ?? "direct";

  if (agentNameInput) {
    const agents = discoverAgents();
    const agent = agents.find((a) => a.name === agentNameInput);
    if (!agent) {
      const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
      const errorMsg = `Unknown agent: "${agentNameInput}". Available: ${available}.`;
      return {
        success: false,
        parsed: false,
        data: null,
        raw: "",
        agent: agentNameInput,
        task: taskText,
        error: errorMsg,
        usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
      };
    }
    systemPrompt = agent.systemPrompt;
    tools = agent.tools;
    model = agent.model;
    resolvedAgentName = agent.name;
  } else {
    systemPrompt = systemPromptInput ?? "";
    tools = normalizeTools(toolsInput);
    model = modelInput;
  }

  const args: string[] = ["--mode", "json", "-p", "--no-session", "--exclude-tools", "subagent_runner"];
  if (model) args.push("--model", model);
  if (tools && tools.length > 0) args.push("--tools", tools.join(","));

  let tmpPromptPath: string | null = null;
  let tmpDir: string | null = null;

  try {
    if (systemPrompt.trim()) {
      const tmp = await writeTempPrompt(resolvedAgentName, systemPrompt);
      tmpPromptPath = tmp.filePath;
      tmpDir = tmp.dir;
      args.push("--append-system-prompt", tmpPromptPath);
    }

    let finalTask = taskText;
    if (schemaHint) {
      finalTask +=
        "\n\n---\n" +
        "IMPORTANT: Your entire response MUST be a single valid JSON object. " +
        "Do not wrap it in markdown code blocks. Do not include any explanatory text outside the JSON. " +
        "Match this shape:\n" +
        schemaHint;
    }
    args.push(finalTask);

    const invocation = getPiInvocation(args);
    const proc = spawn(invocation.command, invocation.args, {
      cwd: process.cwd(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const usage: SubagentUsage = { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    const messages: Message[] = [];
    let stderr = "";
    let buffer = "";

    const exitCode = await new Promise<number>((resolve, reject) => {
      proc.stdout.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let event: any;
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }
          if (event.type === "message_end" && event.message) {
            const msg = event.message as Message;
            messages.push(msg);
            if (msg.role === "assistant") {
              usage.turns++;
              const u = msg.usage;
              if (u) {
                usage.input += u.input ?? 0;
                usage.output += u.output ?? 0;
                usage.cacheRead += u.cacheRead ?? 0;
                usage.cacheWrite += u.cacheWrite ?? 0;
                usage.cost += u.cost?.total ?? 0;
              }
            }
          }
        }
      });

      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("error", (err) => reject(err));
      proc.on("close", (code) => resolve(code ?? 1));

      signal?.addEventListener("abort", () => {
        proc.kill("SIGTERM");
      });
    });

    const raw = getFinalAssistantText(messages) ?? "";
    let parsed = false;
    let data: any = null;
    let parseError: string | undefined;

    if (raw) {
      const cleaned = raw.replace(/^```json\s*/, "").replace(/\s*```$/, "").trim();
      try {
        data = JSON.parse(cleaned);
        parsed = true;
      } catch (e) {
        parseError = e instanceof Error ? e.message : String(e);
      }
    }

    const success = exitCode === 0 && !parseError;

    return {
      success,
      parsed,
      data,
      raw,
      agent: resolvedAgentName,
      task: taskText,
      error: !success ? (parseError || stderr || `Exit code ${exitCode}`) : undefined,
      usage,
    };
  } finally {
    if (tmpPromptPath && tmpDir) {
      try {
        await fs.promises.rm(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
}

async function mapWithLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: limit }).map(async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await fn(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

const subagentRunnerTool = defineTool({
  name: "subagent_runner",
  label: "Subagent Runner",
  description:
    "Delegate tasks to isolated pi subprocesses with structured JSON output.\n" +
    "Single task: pass `task`.\n" +
    "Batch: pass `tasks` array with `run_mode: 'sequential' (default) or 'parallel'`.\n" +
    "Named agent: pass `agent` to load from ~/.pi/agent/agents/*.md.\n" +
    "Direct mode: omit `agent` and set `system_prompt`, `tools`, `model`.",
  parameters: Type.Object({
    // Single task (backward compatible)
    task: Type.Optional(Type.String({ description: "Single task description" })),

    // Batch tasks
    tasks: Type.Optional(
      Type.Array(taskItemSchema, {
        description: "Multiple tasks to run. Each item inherits missing fields from the top-level params.",
      }),
    ),

    // Run mode for batch
    run_mode: Type.Optional(
      Type.Union([Type.Literal("sequential"), Type.Literal("parallel")], {
        description: "How to execute `tasks`. Default: sequential.",
      }),
    ),

    // Global defaults (used when tasks[] items don't specify their own)
    agent: Type.Optional(
      Type.String({ description: 'Default agent name from ~/.pi/agent/agents/*.md. Inherited by batch items.' }),
    ),
    system_prompt: Type.Optional(
      Type.String({ description: "Default system prompt. Inherited by batch items." }),
    ),
    tools: Type.Optional(
      Type.Union([Type.String(), Type.Array(Type.String())], {
        description: "Default tools. Inherited by batch items.",
      }),
    ),
    model: Type.Optional(Type.String({ description: "Default model. Inherited by batch items." })),

    // Schema for JSON output
    schema: Type.Optional(
      Type.String({
        description:
          "Optional expected JSON shape. When provided, each subagent is instructed " +
          "to return ONLY valid JSON with no markdown or prose.",
      }),
    ),
  }),
  outputSchema,

  async execute(_toolCallId, params, signal) {
    // Build normalized task list
    const taskItems: Array<{
      task: string;
      agent?: string;
      system_prompt?: string;
      tools?: unknown;
      model?: string;
    }> = [];

    if (params.tasks && params.tasks.length > 0) {
      for (const item of params.tasks) {
        taskItems.push({
          task: item.task,
          agent: item.agent ?? params.agent,
          system_prompt: item.system_prompt ?? params.system_prompt,
          tools: item.tools ?? params.tools,
          model: item.model ?? params.model,
        });
      }
    } else if (params.task) {
      taskItems.push({
        task: params.task,
        agent: params.agent,
        system_prompt: params.system_prompt,
        tools: params.tools,
        model: params.model,
      });
    } else {
      return {
        content: [{ type: "text", text: "Either `task` or `tasks` must be provided." }],
        structuredContent: {
          results: [
            {
              success: false,
              parsed: false,
              data: null,
              raw: "",
              agent: params.agent ?? "direct",
              task: "",
              error: "Either `task` or `tasks` must be provided.",
              usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
            },
          ],
        } as any,
        details: { error: "Missing task or tasks parameter" } as any,
        isError: true,
      };
    }

    const runMode = params.run_mode ?? "sequential";
    const concurrency = runMode === "parallel" ? MAX_PARALLEL : 1;

    const results = await mapWithLimit(taskItems, concurrency, (item) =>
      runSingleSubagent(item.task, item.agent, item.system_prompt, item.tools, item.model, params.schema, signal),
    );

    const anyFailed = results.some((r) => !r.success);

    const lines = results.map((r, i) => {
      const prefix = results.length > 1 ? `[${i + 1}/${results.length}] ` : "";
      return r.success
        ? `${prefix}✓ ${r.agent}: ${r.task.slice(0, 60)}${r.task.length > 60 ? "..." : ""}`
        : `${prefix}✗ ${r.agent}: ${r.error ?? "failed"}`;
    });

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      structuredContent: { results } as any,
      details: { results, runMode, count: results.length } as any,
      isError: anyFailed,
    };
  },
});

function getFinalAssistantText(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") return part.text;
      }
    }
  }
  return undefined;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool(subagentRunnerTool);
}
