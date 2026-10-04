/**
 * End-to-end test of the jack tool: drives a parent pi that calls the tool,
 * then checks the tool results. Uses the built-in tester agent. Cases run concurrently.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The repository root, used as a sample folder to survey.
const ROOT = fileURLToPath(new URL("../..", import.meta.url));

const CWD = ROOT;
const TIMEOUT_MS = 45_000;

// A schema whose descriptions make the subagent run one timed bash sleep, so the parallel case can tell
// overlapping children from sequential ones.
const PROBE_COMMAND = "echo $$; date +%s%3N; sleep 3; date +%s%3N";
const PROBE_DIR = mkdtempSync(path.join(tmpdir(), "jack-e2e-"));
const PROBE_SCHEMA = path.join(PROBE_DIR, "probe.json");
writeFileSync(
  PROBE_SCHEMA,
  JSON.stringify({
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
  }),
);

interface ToolRun {
  args: any;
  result: any;
  startedAt: number;
  endedAt: number;
}

interface ParentRun {
  code: number | null;
  timedOut: boolean;
  tools: ToolRun[];
}

function runParent(prompt: string): Promise<ParentRun> {
  return new Promise((resolve) => {
    const proc = spawn("pi", ["--mode", "json", "-p", "--no-session", prompt], {
      cwd: CWD,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const tools = new Map<string, ToolRun>();
    let buffer = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
    }, TIMEOUT_MS);

    proc.stdout.on("data", (d) => {
      buffer += d.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        let ev: any;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.toolName !== "jack") continue;
        if (ev.type === "tool_execution_start") {
          tools.set(ev.toolCallId, {
            args: ev.args,
            result: null,
            startedAt: Date.now(),
            endedAt: 0,
          });
        } else if (ev.type === "tool_execution_end") {
          const run = tools.get(ev.toolCallId);
          if (run) {
            run.result = ev.result;
            run.endedAt = Date.now();
          }
        }
      }
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut, tools: [...tools.values()] });
    });
  });
}

function check(failures: string[], ok: boolean, msg: string) {
  if (!ok) failures.push(msg);
}

function finished(
  failures: string[],
  run: ParentRun,
  minCalls: number,
): boolean {
  check(failures, !run.timedOut, `timed out after ${TIMEOUT_MS / 1000}s`);
  check(
    failures,
    run.tools.length >= minCalls,
    `expected >= ${minCalls} tool call(s), got ${run.tools.length}`,
  );
  check(
    failures,
    run.tools.every((t) => t.result),
    "a tool call never finished",
  );
  return failures.length === 0;
}

const cases: Record<string, () => Promise<string[]>> = {
  async "named agent, parallel batch"() {
    const failures: string[] = [];
    const run = await runParent(
      `Call the jack tool exactly once with: agent='tester', schema='${PROBE_SCHEMA}', run_mode='parallel', ` +
        "tasks = 3 items whose task text is 'label: w1', 'label: w2', 'label: w3'. Then stop.",
    );
    if (!finished(failures, run, 1)) return failures;

    const tool = run.tools[0];
    const results: any[] = tool.result.structuredContent.results;
    check(
      failures,
      results.length === 3,
      `expected 3 results, got ${results.length}`,
    );
    results.forEach((r, i) => {
      check(
        failures,
        r.success && r.parsed,
        `w${i + 1}: success=${r.success} parsed=${r.parsed} error=${r.error}`,
      );
      check(
        failures,
        r.data?.label === `w${i + 1}`,
        `w${i + 1}: unexpected data ${JSON.stringify(r.data)}`,
      );
    });
    check(
      failures,
      new Set(results.map((r) => r.data?.pid)).size === 3,
      "expected 3 distinct pids",
    );
    // The model only sees `content`, so every child's reply must be in it.
    const text: string = tool.result.content[0].text;
    for (const n of [1, 2, 3]) {
      check(
        failures,
        new RegExp(`"label":\\s*"w${n}"`).test(text),
        `content is missing w${n}'s reply`,
      );
    }
    // Sequential runs never overlap; model latency varies too much to judge by wall-clock time.
    const spans = results.map(
      (r) => [r.data?.start, r.data?.end] as [number, number],
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
    if (!finished(failures, run, 1)) return failures;

    const r = run.tools[0].result.structuredContent.results[0];
    check(
      failures,
      r.success === true,
      `success=${r.success} error=${r.error}`,
    );
    check(failures, r.parsed === true, `parsed=${r.parsed}, expected true`);
    check(
      failures,
      /hello/i.test(r.data?.result ?? ""),
      `unexpected data ${JSON.stringify(r.data)}`,
    );
    return failures;
  },

  async "unknown agent fails cleanly"() {
    const failures: string[] = [];
    const run = await runParent(
      "Call the jack tool exactly once with agent='does-not-exist' and task='anything'. Then stop.",
    );
    if (!finished(failures, run, 1)) return failures;

    const tool = run.tools[0];
    const r = tool.result.structuredContent.results[0];
    check(failures, tool.result.isError === true, "expected isError");
    check(failures, r.success === false, "expected success=false");
    check(
      failures,
      /Unknown agent/.test(r.error ?? ""),
      `unexpected error ${r.error}`,
    );
    check(
      failures,
      /tester/.test(r.error ?? ""),
      "error should list tester as available",
    );
    return failures;
  },

  async "separate tool calls in one turn"() {
    const failures: string[] = [];
    const run = await runParent(
      "In a SINGLE assistant turn, emit THREE separate jack tool calls at once (parallel tool calls, " +
        "not one batch). Each call has agent='tester' and task = 'label: d1' / 'label: d2' / 'label: d3' " +
        "respectively. Then stop.",
    );
    if (!finished(failures, run, 3)) return failures;

    const firstEnd = Math.min(...run.tools.map((t) => t.endedAt));
    check(
      failures,
      run.tools.every((t) => t.startedAt < firstEnd),
      "calls did not overlap (ran one after another)",
    );
    for (const t of run.tools) {
      const r = t.result.structuredContent.results[0];
      check(
        failures,
        r.success && r.parsed,
        `${t.args.task}: success=${r.success} error=${r.error}`,
      );
    }
    return failures;
  },
};

const outcomes = await Promise.all(
  Object.entries(cases).map(async ([name, fn]) => {
    const t0 = Date.now();
    const failures = await fn().catch((e) => [String(e)]);
    return { name, failures, secs: (Date.now() - t0) / 1000 };
  }),
);
rmSync(PROBE_DIR, { recursive: true, force: true });

for (const { name, failures, secs } of outcomes) {
  console.log(
    `${failures.length === 0 ? "✅" : "❌"} ${name} (${secs.toFixed(1)}s)`,
  );
  for (const f of failures) console.log(`     - ${f}`);
}

if (outcomes.some((o) => o.failures.length > 0)) process.exitCode = 1;
