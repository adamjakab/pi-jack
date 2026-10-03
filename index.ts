/**
 * Subagent Runner — delegates tasks to isolated pi subprocesses with structured JSON output.
 *
 * Supports single task or batch execution with configurable concurrency.
 *
 * Modes:
 *   - Single:  { task: "...", agent?: "...", system_prompt?: "...", ... }
 *   - Batch:   { tasks: [{ task: "..." }, ...], run_mode: "sequential" | "parallel" }
 *
 * Child runs: pi --mode json -p --no-session --extension child.ts --subagent-schema <file>
 * Without `agent`, the child runs as DEFAULT_AGENT (agents/worker.md), or a bare pi agent if that file is missing.
 *
 * Output contract (contract.ts, child.ts): every child has a JSON Schema (the call's `schema`, else the agent's
 * `schema` frontmatter, else DEFAULT_SCHEMA) and answers by calling the `subagent_result` tool, whose parameters
 * are that schema; it gives up with `subagent_fail`. The child validates each answer and lets the model fix an
 * invalid one; this side reads the outcome from the child's tool events and validates the answer once more.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionAPI,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { Type, type TSchema } from "typebox";
import {
  type AgentConfig,
  type AgentLoadError,
  type AgentSource,
  discoverAgents,
} from "./agents.ts";
import {
  DEFAULT_SCHEMA,
  FAIL_TOOL,
  MAX_FORMAT_RETRIES,
  RESULT_TOOL,
  resolveSchema,
  SCHEMA_FLAG,
  schemaErrors,
} from "./contract.ts";

export const MAX_PARALLEL = 2;

/** The child-side extension that gives each subagent its result tools. */
const CHILD_EXTENSION = fileURLToPath(new URL("./child.ts", import.meta.url));

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

/** Writes the child's schema and, when there is one, its system prompt into a fresh private temp dir. */
async function writeTempFiles(
  agentName: string,
  schema: TSchema,
  prompt: string,
): Promise<{ dir: string; schemaPath: string; promptPath?: string }> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
  const write = (filePath: string, text: string) =>
    withFileMutationQueue(filePath, () =>
      fs.promises.writeFile(filePath, text, { encoding: "utf-8", mode: 0o600 }),
    );

  const schemaPath = path.join(dir, "schema.json");
  await write(schemaPath, JSON.stringify(schema));
  if (!prompt) return { dir, schemaPath };

  const promptPath = path.join(
    dir,
    `prompt-${agentName.replace(/[^\w.-]+/g, "_")}.md`,
  );
  await write(promptPath, prompt);
  return { dir, schemaPath, promptPath };
}

export function normalizeTools(value: unknown): string[] | undefined {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
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
  /** Whether `data` holds an answer the subagent submitted. */
  parsed: boolean;
  data: any;
  raw: string;
  agent: string;
  task: string;
  error?: string;
  /** How many answers the subagent submitted with `subagent_result`, valid or not. */
  attempts: number;
  usage: SubagentUsage;
}

/** How a subagent was set up once defaults and overrides were applied; shown by `debug_mode`. */
export interface SubagentSetup {
  agent: string;
  /** Where the agent file came from; undefined for a bare pi agent (no default agent file). */
  agentSource?: AgentSource;
  overridesBuiltIn?: boolean;
  /** Which prompts make up the system prompt: the agent's, the call's `system_prompt`, or both. */
  prompt: Array<"agent" | "call">;
  model?: string;
  modelFrom?: "call" | "agent";
  /** The `--tools` allowlist given to the child, result tools included; undefined means pi's default tools. */
  tools?: string[];
  toolsFrom?: "call" | "agent";
  schema: TSchema;
  schemaFrom: "call" | "agent" | "default";
  /** The child's command line, as spawned. Its temp files are deleted once the child exits. */
  command: string[];
}

const shellQuote = (arg: string) =>
  /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`;

/** Renders a setup as indented lines, for the progress display and the result. */
export function describeSetup(setup: SubagentSetup): string {
  const from = (source: string | undefined) =>
    source ? ` (from the ${source})` : "";
  const agent = !setup.agentSource
    ? `${setup.agent} (no agent file, bare pi)`
    : `${setup.agent} (${setup.agentSource === "built-in" ? "built-in" : setup.overridesBuiltIn ? "yours, overrides built-in" : "yours"})`;
  const appended = setup.prompt.map((p) =>
    p === "agent" ? "the agent's" : "the call's system_prompt",
  );
  const prompt =
    appended.length > 0 ? `pi's, plus ${appended.join(" and ")}` : "pi's only";
  return [
    `agent: ${agent}`,
    `system prompt: ${prompt}`,
    `model: ${setup.model ? `${setup.model}${from(setup.modelFrom)}` : "pi's default"}`,
    `tools: ${setup.tools ? `${setup.tools.join(", ")}${from(setup.toolsFrom)}` : `pi's default, plus ${RESULT_TOOL}, ${FAIL_TOOL}`}`,
    `schema (${setup.schemaFrom === "default" ? "the default" : `from the ${setup.schemaFrom}`}): ${JSON.stringify(setup.schema)}`,
    `command: ${setup.command.map(shellQuote).join(" ")}`,
  ]
    .map((line) => `    ${line}`)
    .join("\n");
}

const taskItemSchema = Type.Object({
  task: Type.String({ description: "Task description for this subagent" }),
  agent: Type.Optional(
    Type.String({
      description:
        "Optional. Name of an available agent; defaults to the top-level `agent`, if any",
    }),
  ),
  system_prompt: Type.Optional(
    Type.String({ description: "System prompt override for this task" }),
  ),
  tools: Type.Optional(
    Type.Union([Type.String(), Type.Array(Type.String())], {
      description: "Tools for this task",
    }),
  ),
  model: Type.Optional(
    Type.String({ description: "Model override for this task" }),
  ),
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

const zeroUsage = (): SubagentUsage => ({
  turns: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
});

async function runSingleSubagent(
  taskText: string,
  agentNameInput: string | undefined,
  systemPromptInput: string | undefined,
  toolsInput: unknown,
  modelInput: string | undefined,
  schemaInput: unknown,
  signal: AbortSignal | undefined,
  onProgress?: (turns: number, activity: string) => void,
  onSetup?: (setup: SubagentSetup) => void,
): Promise<SingleResult> {
  let agentPrompt = "";
  let extraPrompt: string | undefined;
  let tools: string[] | undefined;
  let model: string | undefined;
  let toolsFrom: SubagentSetup["toolsFrom"];
  let resolvedAgentName = agentNameInput ?? "direct";
  // A schema passed on the call wins over the agent's default. Each resolves relative paths from where it was
  // written: the call from the working directory, the frontmatter from the agent file's folder.
  let schemaSource: unknown = schemaInput;
  let schemaBaseDir = process.cwd();

  const failure = (error: string): SingleResult => ({
    success: false,
    parsed: false,
    data: null,
    raw: "",
    agent: resolvedAgentName,
    task: taskText,
    error,
    attempts: 0,
    usage: zeroUsage(),
  });

  const { agents, errors: loadErrors } = discoverAgents();
  const wanted = agentNameInput ?? DEFAULT_AGENT;
  const agent = agents.find((a) => a.name === wanted);
  // A broken file for the wanted agent must not quietly turn into another agent: the built-in one it was meant to
  // override, or, for the default agent, a bare pi agent.
  const brokenFile = loadErrors.find(
    (e) => e.file === `${wanted}.md` && (e.source === "user" || !agent),
  );
  if (brokenFile) {
    const which = agentNameInput ? "agent" : "default agent";
    return failure(
      `The ${which} file ${brokenFile.file} could not be loaded: ${brokenFile.message}`,
    );
  }
  if (agentNameInput) {
    if (!agent) {
      const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
      const broken =
        loadErrors.length > 0
          ? ` Agent files that failed to load: ${describeLoadErrors(loadErrors)}.`
          : "";
      return failure(
        `Unknown agent: "${agentNameInput}". Available: ${available}.${broken} ` +
          "Omit `agent` to run the default subagent.",
      );
    }
    // A named agent owns its prompt and tools; the model is only a default, so a call can run it on another one.
    agentPrompt = agent.systemPrompt;
    tools = agent.tools;
    model = modelInput ?? agent.model;
    toolsFrom = tools ? "agent" : undefined;
  } else {
    // The default agent is the base; call-level system_prompt is appended, tools/model/schema override it.
    agentPrompt = agent?.systemPrompt ?? "";
    extraPrompt = systemPromptInput;
    const callTools = normalizeTools(toolsInput);
    tools = callTools ?? agent?.tools;
    model = modelInput ?? agent?.model;
    toolsFrom = callTools ? "call" : tools ? "agent" : undefined;
  }
  if (agent) resolvedAgentName = agent.name;
  if (schemaSource === undefined && agent?.schema !== undefined) {
    schemaSource = agent.schema;
    schemaBaseDir = agent.dir;
  }

  let schema: TSchema;
  try {
    schema = resolveSchema(schemaSource ?? DEFAULT_SCHEMA, schemaBaseDir);
  } catch (e) {
    return failure(`Invalid schema: ${e instanceof Error ? e.message : e}`);
  }

  const systemPrompt = [agentPrompt, extraPrompt]
    .filter((p) => p?.trim())
    .map((p) => p!.trim())
    .join("\n\n");

  let tmpDir: string | null = null;

  try {
    const tmp = await writeTempFiles(resolvedAgentName, schema, systemPrompt);
    tmpDir = tmp.dir;

    const args: string[] = [
      "--mode",
      "json",
      "-p",
      "--no-session",
      "--exclude-tools",
      "subagent_runner",
    ];
    args.push(
      "--extension",
      CHILD_EXTENSION,
      `--${SCHEMA_FLAG}`,
      tmp.schemaPath,
    );
    if (model) args.push("--model", model);
    // `--tools` is a complete allowlist, so the result tools must be on it or the child cannot answer.
    if (tools && tools.length > 0)
      args.push(
        "--tools",
        [...new Set([...tools, RESULT_TOOL, FAIL_TOOL])].join(","),
      );
    if (tmp.promptPath) args.push("--append-system-prompt", tmp.promptPath);
    args.push(taskText);

    if (onSetup) {
      const invocation = getPiInvocation(args);
      const toolsFlag = args.indexOf("--tools");
      onSetup({
        agent: resolvedAgentName,
        agentSource: agent?.source,
        overridesBuiltIn: agent?.overridesBuiltIn,
        prompt: [
          ...(agentPrompt.trim() ? ["agent" as const] : []),
          ...(extraPrompt?.trim() ? ["call" as const] : []),
        ],
        model,
        modelFrom: modelInput ? "call" : model ? "agent" : undefined,
        tools: toolsFlag >= 0 ? args[toolsFlag + 1].split(",") : undefined,
        toolsFrom,
        schema,
        schemaFrom:
          schemaInput !== undefined
            ? "call"
            : schemaSource !== undefined
              ? "agent"
              : "default",
        command: [invocation.command, ...invocation.args],
      });
    }

    const usage = zeroUsage();
    const run = await runChild(args, usage, signal, onProgress);
    const result = (
      error: string | undefined,
      data: unknown = null,
    ): SingleResult => ({
      success: !error,
      parsed: data !== null,
      data,
      raw: run.raw,
      agent: resolvedAgentName,
      task: taskText,
      error,
      attempts: run.submissions,
      usage,
    });

    if (run.retriesExhausted) {
      return result(
        `No valid answer after ${run.submissions} attempts. ${run.lastRejection}`,
      );
    }
    if (run.exitCode !== 0)
      return result(
        run.stderr || `Exit code ${run.exitCode}`,
        run.answer ?? null,
      );
    if (run.failReason !== undefined) return result(run.failReason);
    if (run.answer !== undefined) {
      // The child validated it already; checking again here guards against a child that skipped or broke that step.
      const errors = schemaErrors(schema, run.answer);
      return result(
        errors.length > 0
          ? `The answer does not match the schema: ${errors.join("; ")}`
          : undefined,
        run.answer,
      );
    }
    if (run.lastRejection) {
      return result(
        `No valid answer after ${run.submissions} attempts. ${run.lastRejection}`,
      );
    }
    return result(`The subagent finished without calling ${RESULT_TOOL}.`);
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
  /** The child's final assistant text, or "" when it gave none. Informational only; the answer is `answer`. */
  raw: string;
  /** Arguments of the last accepted `subagent_result` call. */
  answer?: unknown;
  /** Reason given to `subagent_fail`, if the child gave up. */
  failReason?: string;
  /** Number of `subagent_result` calls, accepted or not. */
  submissions: number;
  /** What the child said about the last rejected `subagent_result` call. */
  lastRejection?: string;
  /** Set when the child was stopped for using up MAX_FORMAT_RETRIES. */
  retriesExhausted?: boolean;
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

  const run: ChildRun = { exitCode: 1, stderr: "", raw: "", submissions: 0 };
  const messages: Message[] = [];
  let rejections = 0;
  let buffer = "";

  const handleEvent = (event: any) => {
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
      onProgress?.(
        usage.turns,
        `${event.toolName}${arg ? ` ${String(arg).split("\n")[0].slice(0, 60)}` : ""}`,
      );
    } else if (
      event.type === "tool_execution_end" &&
      event.toolName === RESULT_TOOL
    ) {
      run.submissions++;
      if (!event.isError) {
        run.answer = event.result?.details;
        return;
      }
      // Rejections come from pi's own argument validation as well as child.ts, so the cap is enforced here.
      run.lastRejection =
        event.result?.content?.[0]?.text ?? "The answer was rejected.";
      rejections++;
      if (rejections > MAX_FORMAT_RETRIES && !run.retriesExhausted) {
        run.retriesExhausted = true;
        proc.kill("SIGTERM");
      }
    } else if (
      event.type === "tool_execution_end" &&
      event.toolName === FAIL_TOOL &&
      !event.isError
    ) {
      run.failReason = String(
        event.result?.details?.reason ??
          "The subagent gave up without a reason.",
      );
    }
  };

  run.exitCode = await new Promise<number>((resolve, reject) => {
    proc.stdout.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          handleEvent(JSON.parse(line));
        } catch {
          // not a JSON event line
        }
      }
    });

    proc.stderr.on("data", (data) => {
      run.stderr += data.toString();
    });

    proc.on("error", (err) => reject(err));
    proc.on("close", (code) => resolve(code ?? 1));

    signal?.addEventListener("abort", () => {
      proc.kill("SIGTERM");
    });
  });

  run.stderr = run.stderr.trim();
  run.raw = getFinalAssistantText(messages) ?? "";
  return run;
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
    "Named agent: pass `agent` only with one of the names listed below; never invent one. It keeps its own " +
    "prompt and tools; `model` still overrides the agent's model.",
  parameters: Type.Object({
    // Single task (backward compatible)
    task: Type.Optional(
      Type.String({ description: "Single task description" }),
    ),

    // Batch tasks
    tasks: Type.Optional(
      Type.Array(taskItemSchema, {
        description:
          "Multiple tasks to run. Each item inherits missing fields from the top-level params.",
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
        description:
          "Optional. Name of an available agent (see tool description); omit otherwise. Inherited by batch items.",
      }),
    ),
    system_prompt: Type.Optional(
      Type.String({
        description: "Default system prompt. Inherited by batch items.",
      }),
    ),
    tools: Type.Optional(
      Type.Union([Type.String(), Type.Array(Type.String())], {
        description: "Default tools. Inherited by batch items.",
      }),
    ),
    debug_mode: Type.Optional(
      Type.Boolean({
        description:
          "Show how each subagent is set up: agent, system prompt, model, tools, schema, and the pi command " +
          "line. Only set this when the user asks for it.",
      }),
    ),
    model: Type.Optional(
      Type.String({
        description:
          "Model for the subagents, as `provider/id` or a pattern (as for `pi --model`); overrides a named " +
          "agent's model. Inherited by batch items.",
      }),
    ),

    // Schema for JSON output
    schema: Type.Optional(
      Type.Union([Type.String(), Type.Record(Type.String(), Type.Unknown())], {
        description:
          "Optional JSON Schema the answer must conform to: an object, inline JSON, or a path to a .json file " +
          "(relative to the working directory). The root must describe an object; give each property a " +
          "`description`, which is how the subagent learns what to put there. The subagent's validated answer " +
          "is returned as `data`. Defaults to the agent's `schema` frontmatter, else " +
          `\`${JSON.stringify(DEFAULT_SCHEMA)}\`.`,
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
        content: [
          { type: "text", text: "Either `task` or `tasks` must be provided." },
        ],
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
              usage: {
                turns: 0,
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                cost: 0,
              },
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
    // With debug_mode, each task's setup, filled in as its child starts.
    const setups: Array<SubagentSetup | undefined> = taskItems.map(
      () => undefined,
    );
    const debug = params.debug_mode === true;
    const startedAt = Date.now();
    const reportProgress = () => {
      const done = status.filter(
        (s) => s.startsWith("✓") || s.startsWith("✗"),
      ).length;
      const secs = Math.round((Date.now() - startedAt) / 1000);
      const lines = taskItems.map((item, i) => {
        const line = `[${i + 1}] ${taskLabel(item.task)} — ${status[i]}`;
        return debug && setups[i]
          ? `${line}\n${describeSetup(setups[i])}`
          : line;
      });
      onUpdate?.({
        content: [
          {
            type: "text",
            text: `${done}/${taskItems.length} done (${secs}s)\n${lines.join("\n")}`,
          },
        ],
        details: undefined as any,
      });
    };
    reportProgress();

    const results = await mapWithLimit(
      taskItems,
      concurrency,
      async (item, i) => {
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
          debug
            ? (setup) => {
                setups[i] = setup;
                reportProgress();
              }
            : undefined,
        );
        status[i] = `${result.success ? "✓" : "✗"} ${result.usage.turns} turns`;
        reportProgress();
        return result;
      },
    );

    const anyFailed = results.some((r) => !r.success);

    // The model only receives `content` (structuredContent is for programmatic callers),
    // so each child's full reply must be included here, not just a status line.
    const blocks = results.map((r, i) => {
      const prefix = results.length > 1 ? `[${i + 1}/${results.length}] ` : "";
      const retried = r.attempts > 1 ? ` (${r.attempts} attempts)` : "";
      const header = r.success
        ? `${prefix}✓ ${r.agent}: ${taskLabel(r.task)}${retried}`
        : `${prefix}✗ ${r.agent}: ${taskLabel(r.task)}${retried}\nError: ${r.error ?? "failed"}`;
      return r.data !== null
        ? `${header}\n${JSON.stringify(r.data, null, 2)}`
        : header;
    });

    if (debug) {
      const described = taskItems.map(
        (item, i) =>
          `[${i + 1}] ${taskLabel(item.task)}\n${setups[i] ? describeSetup(setups[i]) : "    (no child was started)"}`,
      );
      blocks.unshift(
        `Debug: how each subagent was set up\n${described.join("\n")}`,
      );
    }

    return {
      content: [{ type: "text", text: blocks.join("\n\n") }],
      structuredContent: { results } as any,
      details: {
        results,
        runMode,
        count: results.length,
        ...(debug ? { setups } : {}),
      } as any,
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

function describeLoadErrors(errors: AgentLoadError[]): string {
  return errors
    .map(
      (e) =>
        `${e.file}${e.source === "built-in" ? " [built-in]" : ""} (${e.message})`,
    )
    .join("; ");
}

function describeAgent(agent: AgentConfig): string {
  const origin = agent.overridesBuiltIn
    ? " (yours, overrides built-in)"
    : agent.source === "built-in"
      ? " (built-in)"
      : "";
  return `- ${agent.name}${origin}: ${agent.description}`;
}

export default function (pi: ExtensionAPI) {
  // List the agents known at load time so the model never has to guess a name.
  const { agents, errors } = discoverAgents();
  const available =
    agents.length > 0
      ? `Available agents:\n${agents.map(describeAgent).join("\n")}`
      : "Available agents: none (always omit `agent`).";
  pi.registerTool({
    ...subagentRunnerTool,
    description: `${subagentRunnerTool.description}\n${available}`,
  });

  if (errors.length > 0) {
    const message = `[subagent-runner] Agent files that failed to load: ${describeLoadErrors(errors)}`;
    pi.on("session_start", (_event, ctx) => {
      if (ctx.hasUI) ctx.ui.notify(message, "warning");
    });
  }
}
