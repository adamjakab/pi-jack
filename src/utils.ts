/**
 * Helpers for the `jack` tool in index.ts that don't depend on its state: launching pi, temp files, formatting, and
 * concurrency.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import type { AgentConfig, AgentLoadError } from "./agents.ts";

/**
 * Works out how to start a child pi with `args`: through the same runtime and script as this process when it is a
 * script on disk, through this executable when pi is a compiled binary, else through `pi` on the PATH.
 */
export function getPiInvocation(args: string[]): {
  command: string;
  args: string[];
} {
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
export async function writeTempFiles(
  agentName: string,
  schema: TSchema,
  prompt: string,
): Promise<{ dir: string; schemaPath: string; promptPath?: string }> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-jack-"));
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

/**
 * Turns a `tools` parameter, an array or a comma-separated string, into a list of trimmed tool names. Returns
 * undefined when no name is left, meaning pi's default tools.
 */
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

/** Quotes a command-line argument for a POSIX shell, leaving it bare when it needs no quoting. */
export function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Runs `fn` over `items` with at most `concurrency` calls in flight, and returns the results in the order of
 * `items`.
 */
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

/** Shortens a task to its first line, at most 60 characters, with "..." when anything was cut. */
export function taskLabel(task: string): string {
  const firstLine = task.split("\n")[0];
  return `${firstLine.slice(0, 60)}${firstLine.length > 60 || firstLine !== task ? "..." : ""}`;
}

/** Returns the first text part of the last assistant message, or undefined when there is none. */
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

/** Lists agent files that failed to load, with their errors, on one line. */
export function describeLoadErrors(errors: AgentLoadError[]): string {
  return errors
    .map(
      (e) =>
        `${e.file}${e.source === "built-in" ? " [built-in]" : ""} (${e.message})`,
    )
    .join("; ");
}

/** Renders an agent as a bullet line for the tool description: its name, origin, and description. */
export function describeAgent(agent: AgentConfig): string {
  const origin = agent.overridesBuiltIn
    ? " (yours, overrides built-in)"
    : agent.source === "built-in"
      ? " (built-in)"
      : "";
  return `- ${agent.name}${origin}: ${agent.description}`;
}
