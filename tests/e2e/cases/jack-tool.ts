/**
 * End-to-end test of the jack tool: drives a parent pi that calls the tool, then checks the tool results.
 *
 * These cases each spawn a parent that in turn spawns children, so they cost several model turns. Use the built-in
 * tester agent. Run a single case with `npm run test:e2e -- jack-tool/<case name>`.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type Case,
  type PiRun,
  check,
  checkProcess,
  describeRun,
  jackResults,
  resultText,
  runPi,
} from "../harness.ts";

// A schema whose descriptions make the subagent run one timed bash sleep, so the parallel case can tell
// overlapping children from sequential ones.
const PROBE_COMMAND = "echo $$; date +%s%3N; sleep 3; date +%s%3N";
const PROBE_SCHEMA = {
  type: "object",
  properties: {
    label: {
      type: "string",
      description: "The label from the task, e.g. 'w1' for 'label: w1'.",
    },
    pid: {
      type: "number",
      description: `Run this exact bash command once: \`${PROBE_COMMAND}\`. The first line of its output.`,
    },
    start: {
      type: "number",
      description: "The second line of that command's output.",
    },
    end: {
      type: "number",
      description: "The third line of that command's output.",
    },
  },
  required: ["label", "pid", "start", "end"],
};

/** Scratch folder for the probe schema, shared by the cases below and removed when the suite ends. */
const probeDir = mkdtempSync(path.join(tmpdir(), "jack-e2e-"));
const probeSchemaPath = path.join(probeDir, "probe.json");
writeFileSync(probeSchemaPath, JSON.stringify(PROBE_SCHEMA));

/** Runs a parent pi that is asked to make exactly the tool calls described by the prompt. */
function runParent(prompt: string): Promise<PiRun> {
  return runPi(["--mode", "json", "-p", "--no-session", prompt]);
}

/**
 * Asserts the parent itself behaved and that at least `minCalls` jack calls finished. Returns false when the run is
 * too broken for the call-specific assertions to say anything useful.
 */
function usableParent(
  failures: string[],
  run: PiRun,
  minCalls: number,
): boolean {
  checkProcess(failures, run);
  const jackCalls = run.tools.filter((call) => call.toolName === "jack");
  check(
    failures,
    jackCalls.length >= minCalls,
    `expected >= ${minCalls} jack call(s), got ${jackCalls.length}`,
  );
  const unfinished = jackCalls.filter((call) => !call.result);
  check(
    failures,
    unfinished.length === 0,
    `${unfinished.length} jack call(s) never finished\n  ${describeRun(run)}`,
  );
  return failures.length === 0;
}

const cases: Record<string, Case> = {
  async "named agent, parallel batch"() {
    const failures: string[] = [];
    const run = await runParent(
      `Call the jack tool exactly once with: agent='tester', schema='${probeSchemaPath}', run_mode='parallel', ` +
        "tasks = 3 items whose task text is 'label: w1', 'label: w2', 'label: w3'. Then stop.",
    );
    if (!usableParent(failures, run, 1)) return failures;

    const tool = run.tools.find((call) => call.toolName === "jack")!;
    const results = jackResults(failures, "parallel batch", tool.result);
    if (results.length === 0) return failures;
    check(
      failures,
      results.length === 3,
      `expected 3 results, got ${results.length}`,
    );

    results.forEach((result, i) => {
      check(
        failures,
        result.success && result.parsed,
        `w${i + 1}: success=${result.success} parsed=${result.parsed} error=${result.error}`,
      );
      check(
        failures,
        result.data?.label === `w${i + 1}`,
        `w${i + 1}: unexpected data ${JSON.stringify(result.data)}`,
      );
    });
    check(
      failures,
      new Set(results.map((result) => result.data?.pid)).size === 3,
      "expected 3 distinct pids",
    );

    // The model only sees `content`, so every child's reply must be in it.
    const text = resultText(tool.result);
    for (const n of [1, 2, 3]) {
      check(
        failures,
        new RegExp(`"label":\\s*"w${n}"`).test(text),
        `content is missing w${n}'s reply`,
      );
    }

    // Sequential runs never overlap; model latency varies too much to judge by wall-clock time.
    const spans = results.map(
      (result) => [result.data?.start, result.data?.end] as [number, number],
    );
    const overlaps = spans.some((a, i) =>
      spans.some((b, j) => i < j && a[0] < b[1] && b[0] < a[1]),
    );
    check(
      failures,
      overlaps,
      `no worker sleeps overlapped, looks sequential: ${JSON.stringify(spans)}`,
    );
    return failures;
  },

  async "no schema falls back to the default { result } schema"() {
    const failures: string[] = [];
    const run = await runParent(
      "Call the jack tool exactly once with task='Reply with the single word hello.' and tools='read'. " +
        "Do not pass a schema. Then stop.",
    );
    if (!usableParent(failures, run, 1)) return failures;

    const tool = run.tools.find((call) => call.toolName === "jack")!;
    const [result] = jackResults(failures, "default schema", tool.result);
    if (!result) return failures;
    check(
      failures,
      result.success === true,
      `success=${result.success} error=${result.error}`,
    );
    check(
      failures,
      result.parsed === true,
      `parsed=${result.parsed}, expected true`,
    );
    check(
      failures,
      /hello/i.test(result.data?.result ?? ""),
      `unexpected data ${JSON.stringify(result.data)}`,
    );
    return failures;
  },

  async "unknown agent fails cleanly"() {
    const failures: string[] = [];
    const run = await runParent(
      "Call the jack tool exactly once with agent='does-not-exist' and task='anything'. Then stop.",
    );
    if (!usableParent(failures, run, 1)) return failures;

    const tool = run.tools.find((call) => call.toolName === "jack")!;
    const [result] = jackResults(failures, "unknown agent", tool.result);
    check(failures, tool.result?.isError === true, "expected isError");
    check(failures, result?.success === false, "expected success=false");
    check(
      failures,
      /Unknown agent/.test(result?.error ?? ""),
      `unexpected error ${result?.error}`,
    );
    check(
      failures,
      /tester/.test(result?.error ?? ""),
      "error should list tester as available",
    );
    return failures;
  },

  async "separate tool calls in one turn"() {
    const failures: string[] = [];
    const run = await runParent(
      "In a SINGLE assistant turn, emit THREE separate jack tool calls at once (parallel tool calls, " +
        "not one batch). Each call has agent='tester' and task = 'Answer with the text dN. Use no other tools.', " +
        "with N = 1, 2 and 3 respectively. Then stop.",
    );
    if (!usableParent(failures, run, 3)) return failures;

    const calls = run.tools.filter((call) => call.toolName === "jack");
    const firstEnd = Math.min(...calls.map((call) => call.endedAt));
    check(
      failures,
      calls.every((call) => call.startedAt < firstEnd),
      "calls did not overlap (ran one after another)",
    );
    for (const call of calls) {
      const [result] = jackResults(failures, "separate call", call.result);
      check(
        failures,
        result?.success && result?.parsed,
        `${call.args?.task}: success=${result?.success} error=${result?.error}`,
      );
    }
    return failures;
  },
};

function cleanup(): void {
  rmSync(probeDir, { recursive: true, force: true });
}

export default {
  name: "jack-tool",
  cases,
  cleanup,
};
