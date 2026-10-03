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
 * Without `agent`, the child runs as DEFAULT_AGENT (agents/worker.md), or a bare pi agent if that file is missing.
 *
 * Output contract: every child has a schema (the call's `schema`, else the agent's `schema` frontmatter, else
 * DEFAULT_SCHEMA) and must reply with one bare JSON value matching it, or `{"subagent_error": "..."}` if it cannot
 * finish; the extension parses that reply into `data` and turns the error form into a failed result. An agent states
 * the contract in its own instructions around a `{{schema}}` placeholder; for an agent without one, the extension
 * appends outputContract() to its system prompt.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { discoverAgents } from "./agents.ts";

export const MAX_PARALLEL = 2;

/** Agent used when a call omits `agent`. */
export const DEFAULT_AGENT = "worker";

/** Schema used when neither the call nor the agent gives one. */
export const DEFAULT_SCHEMA = '{"result": "text"}';

/** The only key of the reply a child sends, under the output contract, when it cannot complete the task. */
export const ERROR_KEY = "subagent_error";

/** The output contract for an agent whose instructions don't state it, appended to its system prompt. */
export function outputContract(schema: string): string {
  return [
    "## Output contract",
    "",
    "Your final message is not read by a person: the subagent runner parses it as JSON and hands the result to the " +
      "agent that delegated this task.",
    "",
    "- Your final message must be exactly one JSON value matching the schema below: no Markdown fences, no prose " +
      "before or after it.",
    "- Finish all tool calls first; the JSON is your last message.",
    "- This contract replaces any other output format in these instructions.",
    `- If you cannot complete the task, reply with exactly \`{"${ERROR_KEY}": "<one-line reason>"}\` instead.`,
    "",
    "Schema:",
    "",
    schema,
  ].join("\n");
}

const SCHEMA_PLACEHOLDER = /\{\{schema\}\}/g;

/** Whether an agent's instructions place the schema themselves, and so state the output contract on their own. */
export function hasSchemaPlaceholder(prompt: string): boolean {
  return prompt.includes("{{schema}}");
}

/** Replaces each `{{schema}}` in an agent's instructions with the schema. */
export function renderSchema(prompt: string, schema: string): string {
  return prompt.replace(SCHEMA_PLACEHOLDER, () => schema);
}

/** Parses a reply made under the output contract, tolerating Markdown fences or stray prose around the JSON. */
export function parseJsonReply(raw: string): unknown {
  const unfenced = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  try {
    return JSON.parse(unfenced);
  } catch (e) {
    const start = unfenced.indexOf("{");
    const end = unfenced.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(unfenced.slice(start, end + 1));
      } catch {
        // fall through to the original error
      }
    }
    throw e;
  }
}

/** Returns the reason when `data` is the contract's error reply, `{ subagent_error: "..." }`. */
export function contractError(data: unknown): string | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const keys = Object.keys(data);
  const reason = (data as Record<string, unknown>)[ERROR_KEY];
  return keys.length === 1 && typeof reason === "string" ? reason : undefined;
}

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

  const args: string[] = ["--mode", "json", "-p", "--no-session", "--exclude-tools", "subagent_runner"];
  if (model) args.push("--model", model);
  if (tools && tools.length > 0) args.push("--tools", tools.join(","));

  let tmpPromptPath: string | null = null;
  let tmpDir: string | null = null;

  try {
    const tmp = await writeTempPrompt(resolvedAgentName, systemPrompt);
    tmpPromptPath = tmp.filePath;
    tmpDir = tmp.dir;
    args.push("--append-system-prompt", tmpPromptPath);

    // A short reminder at the end of the task; the contract itself lives in the system prompt.
    args.push(`${taskText}\n\n---\nReply with only the JSON your instructions describe.`);

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

    const raw = getFinalAssistantText(messages) ?? "";
    let parsed = false;
    let data: any = null;
    let outputError: string | undefined;

    if (!raw) {
      outputError = "No output";
    } else {
      try {
        data = parseJsonReply(raw);
        parsed = true;
        outputError = contractError(data);
      } catch (e) {
        outputError = e instanceof Error ? e.message : String(e);
      }
    }

    const success = exitCode === 0 && !outputError;

    return {
      success,
      parsed,
      data,
      raw,
      agent: resolvedAgentName,
      task: taskText,
      error: !success
        ? exitCode !== 0
          ? stderr || `Exit code ${exitCode}`
          : outputError
        : undefined,
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
      const header = r.success
        ? `${prefix}✓ ${r.agent}: ${taskLabel(r.task)}`
        : `${prefix}✗ ${r.agent}: ${taskLabel(r.task)}\nError: ${r.error ?? "failed"}`;
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
