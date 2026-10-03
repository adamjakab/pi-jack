/**
 * Subagent Runner — delegates tasks to isolated pi subprocesses with structured JSON output.
 *
 * Supports single task or batch execution with configurable concurrency.
 *
 * Modes:
 *   - Single:  { task: "...", agent?: "...", system_prompt?: "...", ... }
 *   - Batch:   { tasks: [{ task: "..." }, ...], run_mode: "sequential" | "parallel" }
 *
 * Child runs: pi --mode json -p, with a private session in a temp dir so a retry can resume it
 * Without `agent`, the child runs as DEFAULT_AGENT (agents/worker.md), or a bare pi agent if that file is missing.
 *
 * Output contract (contract.ts): every child has a schema (the call's `schema`, else the agent's `schema`
 * frontmatter, else DEFAULT_SCHEMA) and must reply with one bare JSON value matching it, or
 * `{"subagent_error": "..."}` if it cannot finish. An agent states the contract in its own instructions around a
 * `{{schema}}` placeholder; for an agent without one, the extension appends outputContract() to its system prompt.
 *
 * Verification: each reply is checked for valid JSON matching the schema. A reply that fails is sent back to the
 * same subagent (its session is resumed, so it keeps its context) with the errors, up to MAX_FORMAT_RETRIES times.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { discoverAgents } from "./agents.ts";
import {
  DEFAULT_SCHEMA,
  hasSchemaPlaceholder,
  outputContract,
  renderSchema,
  retryPrompt,
  type Verification,
  verifyReply,
} from "./contract.ts";

export const MAX_PARALLEL = 2;

/** How many times a subagent is asked to fix a reply that failed verification, after its first attempt. */
export const MAX_FORMAT_RETRIES = 2;

/** Agent used when a call omits `agent`. */
export const DEFAULT_AGENT = "worker";

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

export function normalizeTools(value: unknown): string[] | undefined {
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
  /** How many times the subagent was run: 1, plus one per verification retry. */
  attempts: number;
  usage: SubagentUsage;
}

const taskItemSchema = Type.Object({
  task: Type.String({ description: "Task description for this subagent" }),
  agent: Type.Optional(
    Type.String({ description: "Optional. Name of an available agent; defaults to the top-level `agent`, if any" }),
  ),
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
      attempts: Type.Number(),
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
  schemaInput: string | undefined,
  signal: AbortSignal | undefined,
  onProgress?: (turns: number, activity: string) => void,
): Promise<SingleResult> {
  let agentPrompt = "";
  let extraPrompt: string | undefined;
  let tools: string[] | undefined;
  let model: string | undefined;
  let schema = schemaInput;
  let resolvedAgentName = agentNameInput ?? "direct";

  const agents = discoverAgents();
  if (agentNameInput) {
    const agent = agents.find((a) => a.name === agentNameInput);
    if (!agent) {
      const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
      const errorMsg =
        `Unknown agent: "${agentNameInput}". Available: ${available}. ` +
        "Omit `agent` to run the default subagent.";
      return {
        success: false,
        parsed: false,
        data: null,
        raw: "",
        agent: agentNameInput,
        task: taskText,
        error: errorMsg,
        attempts: 0,
        usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
      };
    }
    agentPrompt = agent.systemPrompt;
    tools = agent.tools;
    model = agent.model;
    resolvedAgentName = agent.name;
    // A schema passed on the call wins over the agent's default.
    schema = schemaInput ?? agent.schema;
  } else {
    // The default agent is the base; call-level system_prompt is appended, tools/model/schema override it.
    const base = agents.find((a) => a.name === DEFAULT_AGENT);
    agentPrompt = base?.systemPrompt ?? "";
    extraPrompt = systemPromptInput;
    tools = normalizeTools(toolsInput) ?? base?.tools;
    model = modelInput ?? base?.model;
    schema = schemaInput ?? base?.schema;
    resolvedAgentName = base?.name ?? "direct";
  }

  schema ??= DEFAULT_SCHEMA;
  const contract = hasSchemaPlaceholder(agentPrompt) ? undefined : outputContract(schema);
  const systemPrompt = [renderSchema(agentPrompt, schema), extraPrompt, contract]
    .filter((p) => p?.trim())
    .map((p) => p!.trim())
    .join("\n\n");

  let tmpDir: string | null = null;

  try {
    const tmp = await writeTempPrompt(resolvedAgentName, systemPrompt);
    tmpDir = tmp.dir;

    // The session lives in the run's temp dir, so a retry can resume it and the subagent keeps its context.
    const args: string[] = ["--mode", "json", "-p", "--session-dir", tmp.dir, "--session-id", "subagent"];
    args.push("--exclude-tools", "subagent_runner");
    if (model) args.push("--model", model);
    if (tools && tools.length > 0) args.push("--tools", tools.join(","));
    args.push("--append-system-prompt", tmp.filePath);

    const usage: SubagentUsage = { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    // A short reminder at the end of the task; the contract itself lives in the system prompt.
    let prompt = `${taskText}\n\n---\nReply with only the JSON your instructions describe.`;
    let attempts = 0;
    let run: ChildRun;
    let check: Verification | undefined;

    while (true) {
      attempts++;
      const retryLabel = attempts > 1 ? `retry ${attempts - 1}: ` : "";
      run = await runChild([...args, prompt], usage, signal, (turns, activity) =>
        onProgress?.(turns, `${retryLabel}${activity}`),
      );
      // A crashed or aborted child is not a format problem, so it is not retried.
      if (run.exitCode !== 0 || signal?.aborted) break;
      check = verifyReply(run.raw, schema);
      if (check.errors.length === 0 || attempts > MAX_FORMAT_RETRIES) break;
      prompt = retryPrompt(check.errors, schema);
    }

    let error: string | undefined;
    if (run.exitCode !== 0) error = run.stderr || `Exit code ${run.exitCode}`;
    else if (!check) error = "Aborted";
    else if (check.agentError !== undefined) error = check.agentError;
    else if (check.errors.length > 0) {
      error = `Reply failed verification after ${attempts} attempts: ${check.errors.join("; ")}`;
    }

    return {
      success: !error,
      parsed: check?.parsed ?? false,
      data: check?.data ?? null,
      raw: run.raw,
      agent: resolvedAgentName,
      task: taskText,
      error,
      attempts,
      usage,
    };
  } finally {
    if (tmpDir) {
      try {
        await fs.promises.rm(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
}

interface ChildRun {
  exitCode: number;
  stderr: string;
  /** The child's final assistant text, or "" when it gave none. */
  raw: string;
}

/** Runs one pi child to completion, adding its turns and token usage to `usage`. */
async function runChild(
  args: string[],
  usage: SubagentUsage,
  signal: AbortSignal | undefined,
  onProgress?: (turns: number, activity: string) => void,
): Promise<ChildRun> {
  const invocation = getPiInvocation(args);
  const proc = spawn(invocation.command, invocation.args, {
    cwd: process.cwd(),
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

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
            onProgress?.(usage.turns, "thinking");
          }
        } else if (event.type === "tool_execution_start") {
          const arg = event.args?.command ?? event.args?.path ?? "";
          onProgress?.(usage.turns, `${event.toolName}${arg ? ` ${String(arg).split("\n")[0].slice(0, 60)}` : ""}`);
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

  // pi warns on the first run that the session id is new; that is expected here, not an error.
  stderr = stderr.replace(/^Warning: No project session found with id .*\n?/m, "").trim();
  return { exitCode, stderr, raw: getFinalAssistantText(messages) ?? "" };
}

export async function mapWithLimit<TIn, TOut>(
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
    `No agent (the usual case): omit \`agent\`; the subagent is the default \`${DEFAULT_AGENT}\` agent, ` +
    "optionally customized with `system_prompt` (appended), `tools`, `model`.\n" +
    "Named agent: pass `agent` only with one of the names listed below; never invent one.",
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
      Type.String({
        description: "Optional. Name of an available agent (see tool description); omit otherwise. Inherited by batch items.",
      }),
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
          "Optional expected JSON shape. Each subagent must reply with only a JSON value of this shape, " +
          "parsed into `data`; a subagent that cannot finish fails with its stated reason. " +
          `Defaults to the agent's \`schema\` frontmatter, else \`${DEFAULT_SCHEMA}\`.`,
      }),
    ),
  }),
  outputSchema,

  async execute(_toolCallId, params, signal, onUpdate) {
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
              attempts: 0,
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

    // Live per-task status, streamed to the TUI so long batches don't look frozen.
    const status = taskItems.map(() => "queued");
    const startedAt = Date.now();
    const reportProgress = () => {
      const done = status.filter((s) => s.startsWith("✓") || s.startsWith("✗")).length;
      const secs = Math.round((Date.now() - startedAt) / 1000);
      const lines = taskItems.map((item, i) => `[${i + 1}] ${taskLabel(item.task)} — ${status[i]}`);
      onUpdate?.({
        content: [{ type: "text", text: `${done}/${taskItems.length} done (${secs}s)\n${lines.join("\n")}` }],
        details: undefined as any,
      });
    };
    reportProgress();

    const results = await mapWithLimit(taskItems, concurrency, async (item, i) => {
      status[i] = "starting";
      reportProgress();
      const result = await runSingleSubagent(
        item.task,
        item.agent,
        item.system_prompt,
        item.tools,
        item.model,
        params.schema,
        signal,
        (turns, activity) => {
          status[i] = `turn ${turns + 1}: ${activity}`;
          reportProgress();
        },
      );
      status[i] = `${result.success ? "✓" : "✗"} ${result.usage.turns} turns`;
      reportProgress();
      return result;
    });

    const anyFailed = results.some((r) => !r.success);

    // The model only receives `content` (structuredContent is for programmatic callers),
    // so each child's full reply must be included here, not just a status line.
    const blocks = results.map((r, i) => {
      const prefix = results.length > 1 ? `[${i + 1}/${results.length}] ` : "";
      const retried = r.attempts > 1 ? ` (${r.attempts} attempts)` : "";
      const header = r.success
        ? `${prefix}✓ ${r.agent}: ${taskLabel(r.task)}${retried}`
        : `${prefix}✗ ${r.agent}: ${taskLabel(r.task)}${retried}\nError: ${r.error ?? "failed"}`;
      return r.raw ? `${header}\n${r.raw}` : header;
    });

    return {
      content: [{ type: "text", text: blocks.join("\n\n") }],
      structuredContent: { results } as any,
      details: { results, runMode, count: results.length } as any,
      isError: anyFailed,
    };
  },
});

export function taskLabel(task: string): string {
  const firstLine = task.split("\n")[0];
  return `${firstLine.slice(0, 60)}${firstLine.length > 60 || firstLine !== task ? "..." : ""}`;
}

export function getFinalAssistantText(messages: Message[]): string | undefined {
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
  // List the agents known at load time so the model never has to guess a name.
  const agents = discoverAgents();
  const available =
    agents.length > 0
      ? `Available agents:\n${agents.map((a) => `- ${a.name}: ${a.description}`).join("\n")}`
      : "Available agents: none (always omit `agent`).";
  pi.registerTool({ ...subagentRunnerTool, description: `${subagentRunnerTool.description}\n${available}` });
}
