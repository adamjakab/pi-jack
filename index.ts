/**
 * Subagent JSON Tool — minimal extension that delegates to a pi subprocess
 * and returns structured JSON output for parent-child contract communication.
 *
 * Contract:
 *   - Single agent only (no parallel/chain modes)
 *   - Child runs in JSON mode: pi --mode json -p --no-session
 *   - Optional `schema` parameter instructs child to emit valid JSON
 *   - Parent receives structuredContent matching outputSchema
 *
 * Two invocation modes:
 *   1. Named agent: { agent: "scout", task: "..." } — looks up ~/.pi/agent/agents/scout.md
 *   2. Direct:      { task: "...", system_prompt?: "...", tools?: "read,bash", model?: "claude" }
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { discoverAgents } from "./agents.ts";

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

const outputSchema = Type.Object({
  success: Type.Boolean({ description: "Whether the subagent completed without error" }),
  parsed: Type.Boolean({ description: "Whether the subagent output was successfully parsed as JSON" }),
  data: Type.Any({ description: "Parsed JSON output from the subagent, or null" }),
  raw: Type.String({ description: "Raw text output from the subagent" }),
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
});

const subagentJsonTool = defineTool({
  name: "subagent_runner",
  label: "Subagent Runner",
  description:
    "Delegate a task to a subagent running in an isolated pi process with structured JSON output. " +
    "Two modes:\n" +
    '- Named agent: pass "agent" to use a definition from ~/.pi/agent/agents/*.md.\n' +
    '- Direct: omit "agent" and optionally set "system_prompt", "tools", and "model".',
  parameters: Type.Object({
    task: Type.String({ description: "Task description for the subagent" }),
    agent: Type.Optional(
      Type.String({
        description: 'Name of a pre-defined agent in ~/.pi/agent/agents/*.md. If omitted, runs in direct mode.',
      }),
    ),
    system_prompt: Type.Optional(
      Type.String({ description: "Custom system prompt for direct mode. Ignored when agent is provided." }),
    ),
    tools: Type.Optional(
      Type.Union([Type.String(), Type.Array(Type.String())], {
        description: 'Tools to enable (comma-separated string or array). Ignored when agent is provided.',
      }),
    ),
    model: Type.Optional(Type.String({ description: "Model override. Ignored when agent is provided." })),
    schema: Type.Optional(
      Type.String({
        description:
          "Optional description of the expected JSON shape. When provided, the subagent " +
          "is instructed to return ONLY valid JSON with no markdown or prose.",
      }),
    ),
  }),
  outputSchema,

  async execute(_toolCallId, params, signal) {
    let systemPrompt: string = "";
    let tools: string[] | undefined;
    let model: string | undefined;
    let agentName = params.agent ?? "direct";

    if (params.agent) {
      const agents = discoverAgents();
      const agent = agents.find((a) => a.name === params.agent);
      if (!agent) {
        const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
        const errorMsg = `Unknown agent: "${params.agent}". Available: ${available}.`;
        return {
          content: [{ type: "text", text: errorMsg }],
          structuredContent: {
            success: false,
            parsed: false,
            data: null,
            raw: "",
            agent: params.agent,
            task: params.task,
            error: errorMsg,
            usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
          } as any,
          details: { agent: params.agent, task: params.task, error: errorMsg } as any,
          isError: true,
        };
      }
      systemPrompt = agent.systemPrompt;
      tools = agent.tools;
      model = agent.model;
      agentName = agent.name;
    } else {
      systemPrompt = params.system_prompt ?? "";
      tools = normalizeTools(params.tools);
      model = params.model;
    }

    const args: string[] = ["--mode", "json", "-p", "--no-session"];
    if (model) args.push("--model", model);
    if (tools && tools.length > 0) args.push("--tools", tools.join(","));

    let tmpPromptPath: string | null = null;
    let tmpDir: string | null = null;

    try {
      if (systemPrompt.trim()) {
        const tmp = await writeTempPrompt(agentName, systemPrompt);
        tmpPromptPath = tmp.filePath;
        tmpDir = tmp.dir;
        args.push("--append-system-prompt", tmpPromptPath);
      }

      let taskText = params.task;
      if (params.schema) {
        taskText +=
          "\n\n---\n" +
          "IMPORTANT: Your entire response MUST be a single valid JSON object. " +
          "Do not wrap it in markdown code blocks. Do not include any explanatory text outside the JSON. " +
          "Match this shape:\n" +
          params.schema;
      }
      args.push(taskText);

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

      const raw = getFinalAssistantText(messages);
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
      const errorMsg = !success ? (parseError || stderr || `Exit code ${exitCode}`) : undefined;

      const contentText = success
        ? `Subagent "${agentName}" completed. Raw output:\n${raw ?? "(no output)"}`
        : `Subagent "${agentName}" failed (exit ${exitCode}).${parseError ? ` JSON parse error: ${parseError}.` : ""} Raw output:\n${raw ?? "(no output)"}\nStderr: ${stderr || "(none)"}`;

      return {
        content: [{ type: "text", text: contentText }],
        structuredContent: {
          success,
          parsed,
          data,
          raw: raw ?? "",
          agent: agentName,
          task: params.task,
          ...(errorMsg ? { error: errorMsg } : {}),
          usage,
        } as any,
        details: { agent: agentName, task: params.task, exitCode, messages, stderr, error: errorMsg } as any,
        isError: !success,
      };
    } finally {
      if (tmpPromptPath && tmpDir) {
        try {
          await fs.promises.rm(tmpDir, { recursive: true, force: true });
        } catch {
          // ignore cleanup errors
        }
      }
    }
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
  pi.registerTool(subagentJsonTool);
}
