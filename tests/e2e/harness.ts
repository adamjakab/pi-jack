/**
 * Shared plumbing for the end-to-end tests.
 *
 * Every test drives a real `pi` subprocess in `--mode json` and asserts on the JSON event stream. This module owns
 * spawning, buffering (stdout arrives in arbitrary chunks, so lines must be reassembled), timing out, and collecting
 * the pieces the tests care about: tool calls, tool results, and the last assistant text.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Repository root. Several tests survey it, and children load the extension from it. */
export const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Default per-process budget. A child runs a whole model turn, so this is generous. */
export const DEFAULT_TIMEOUT_MS = 60_000;

/** One tool call, from its `tool_execution_start` to its `tool_execution_end`. */
export interface ToolCall {
  toolName: string;
  args: any;
  result: any;
  startedAt: number;
  endedAt: number;
}

/** The outcome of one `pi` invocation. */
export interface PiRun {
  code: number | null;
  /** Set when the process was killed by a signal, e.g. by our own timeout. */
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stderr: string;
  /** Every parsed event, in arrival order. Unparsable lines are dropped. */
  events: any[];
  /** Completed tool calls, ordered by start time. */
  tools: ToolCall[];
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
}

/**
 * Runs `pi` with the given arguments and collects its JSON events.
 *
 * Never rejects: a crashed, timed-out, or non-zero-exit process is data the caller asserts on. The subprocess is sent
 * SIGTERM on timeout and SIGKILL a few seconds later, so a hung child cannot outlive the test run.
 */
export function runPi(
  args: string[],
  options: RunOptions = {},
): Promise<PiRun> {
  const { cwd = ROOT, timeoutMs = timeoutBudget() } = options;

  return new Promise((resolve) => {
    const proc = spawn("pi", args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const events: any[] = [];
    const tools = new Map<string, ToolCall>();
    let buffer = "";
    let stderr = "";
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
      // A child that ignores SIGTERM must not outlive the suite.
      killTimer = setTimeout(() => proc.kill("SIGKILL"), 5_000);
    }, timeoutMs);

    proc.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          // Partial or non-JSON output (banners, warnings) is not this test's concern.
          continue;
        }
        events.push(event);
        recordToolCall(event, tools);
      }
    });

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("error", (error) => {
      // Most often `pi` is not on PATH. `close` still fires, so this only records the reason.
      stderr += `${error.message}\n`;
    });

    proc.on("close", (code, signal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer);
          events.push(event);
          recordToolCall(event, tools);
        } catch {
          /* ignore */
        }
      }
      resolve({
        code,
        signal,
        timedOut,
        stderr,
        events,
        tools: [...tools.values()],
      });
    });
  });
}

/** Folds one `tool_execution_start`/`tool_execution_end` event pair into the run's tool call list. */
function recordToolCall(event: any, tools: Map<string, ToolCall>): void {
  if (event.toolName === undefined) return;
  if (event.type === "tool_execution_start") {
    tools.set(event.toolCallId, {
      toolName: event.toolName,
      args: event.args,
      result: undefined,
      startedAt: Date.now(),
      endedAt: 0,
    });
  } else if (event.type === "tool_execution_end") {
    const call = tools.get(event.toolCallId);
    if (call) {
      call.result = event.result;
      call.endedAt = Date.now();
    }
  }
}

/** The last text block of the last assistant message, if any. */
export function lastAssistantText(run: PiRun): string | undefined {
  let text: string | undefined;
  for (const event of run.events) {
    if (event.type !== "message_end" || event.message?.role !== "assistant")
      continue;
    const block = event.message.content?.find(
      (part: any) => part.type === "text" && part.text,
    );
    if (block) text = block.text;
  }
  return text;
}

/** Every tool call of the given name that actually finished. */
export function completedCalls(run: PiRun, toolName: string): ToolCall[] {
  return run.tools.filter((call) => call.toolName === toolName && call.result);
}

/** A single test case. Returns the problems it found; an empty array means it passed. */
export type Case = () => Promise<string[]>;

/** Records a failed expectation. */
export function check(failures: string[], ok: unknown, message: string): void {
  if (!ok) failures.push(message);
}

/**
 * Fails unless the process itself behaved: exited cleanly, in time, without stderr noise.
 * A subprocess that crashed makes every later assertion meaningless, so this runs first.
 */
export function checkProcess(
  failures: string[],
  run: PiRun,
  options: { allowStderr?: RegExp; timeoutMs?: number } = {},
): void {
  const { allowStderr, timeoutMs } = options;
  check(
    failures,
    !run.timedOut,
    `pi timed out after ${timeoutMs ?? "the configured budget"}`,
  );
  check(
    failures,
    run.code === 0,
    `pi exited with code ${run.code}${run.signal ? ` (signal ${run.signal})` : ""}`,
  );
  const noise = options.allowStderr
    ? run.stderr.replace(options.allowStderr, "").trim()
    : run.stderr.trim();
  check(failures, noise === "", `pi wrote to stderr:\n${noise}`);
}

/** Formats a run for a failure message: exit state, tool calls, and the tail of the output. */
export function describeRun(run: PiRun): string {
  const tools = run.tools
    .map((call) => `    ${call.toolName} ${JSON.stringify(call.args)}`)
    .join("\n");
  const text = lastAssistantText(run);
  return [
    `exit=${run.code}${run.signal ? ` signal=${run.signal}` : ""} timedOut=${run.timedOut}`,
    `tools:\n${tools || "    (none)"}`,
    text
      ? `last assistant text:\n${text.slice(0, 800)}`
      : "last assistant text: (none)",
  ].join("\n  ");
}

/** Reads the `results` array out of a jack tool result, failing cleanly when it is missing or malformed. */
export function jackResults(
  failures: string[],
  label: string,
  result: any,
): any[] {
  const results = result?.structuredContent?.results;
  if (!Array.isArray(results)) {
    failures.push(
      `${label}: no structuredContent.results in tool result: ${JSON.stringify(result)}`,
    );
    return [];
  }
  return results;
}

/** The `content` text the model sees, which for jack carries every child's reply. */
export function resultText(result: any): string {
  return result?.content?.[0]?.text ?? "";
}

/** Per-process budget, overridable with `$E2E_TIMEOUT_MS` for slow machines or models. */
function timeoutBudget(): number {
  const override = Number(process.env.E2E_TIMEOUT_MS);
  return Number.isFinite(override) && override > 0
    ? override
    : DEFAULT_TIMEOUT_MS;
}
