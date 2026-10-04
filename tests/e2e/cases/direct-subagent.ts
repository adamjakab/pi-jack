/**
 * Drives a child the way JACK does for a direct subagent: no agent file, an explicit `--json-schema`, and the result
 * tools on the `--tools` allowlist.
 *
 * The old `test-direct.ts` and `test-schema.ts` claimed to cover this but passed neither the flag nor the tools, so
 * they only proved that a model can be asked for JSON in a prompt. This case asserts the parts that JACK depends on:
 *
 *  - the schema is enforced, not merely suggested (the answer parses against it);
 *  - the child can answer at all (`jack_subagent_result` is reachable through `--tools`);
 *  - `jack` is excluded, so a child cannot recurse into another subagent.
 */

import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type Case,
  ROOT,
  check,
  checkProcess,
  completedCalls,
  describeRun,
  runPi,
} from "../harness.ts";

const RESULT_TOOL = "jack_subagent_result";
const FAIL_TOOL = "jack_subagent_fail";

/** What the child is asked for, and what the parent itself expects, so a hallucinated count cannot pass. */
const EXPECTED_COUNT = readdirSync(ROOT).filter((name) =>
  name.endsWith(".ts"),
).length;

const SCHEMA = {
  type: "object",
  properties: {
    count: {
      type: "number",
      description: "How many .ts files are in the repository root.",
    },
  },
  required: ["count"],
  additionalProperties: false,
};

const directSubagent: Case = async () => {
  const failures: string[] = [];
  const dir = mkdtempSync(path.join(tmpdir(), "jack-e2e-direct-"));
  const schemaPath = path.join(dir, "schema.json");
  writeFileSync(schemaPath, JSON.stringify(SCHEMA));

  try {
    const run = await runPi([
      "--mode",
      "json",
      "-p",
      "--no-session",
      // No jack: the child must not be able to spawn further subagents.
      "--exclude-tools",
      "jack",
      "--extension",
      path.join(ROOT, "src", "index.ts"),
      "--json-schema",
      schemaPath,
      // `--tools` is a complete allowlist, so the result tools have to be named explicitly.
      "--tools",
      `bash,read,${RESULT_TOOL},${FAIL_TOOL}`,
      `Count the .ts files directly in ${ROOT} (not in its subdirectories) with one bash command, ` +
        "then answer with the count.",
    ]);

    checkProcess(failures, run);
    check(
      failures,
      run.tools.every((call) => call.toolName !== "jack"),
      "the child called jack, which should have been excluded",
    );

    const failed = completedCalls(run, FAIL_TOOL);
    check(
      failures,
      failed.length === 0,
      `the child gave up instead of answering: ${JSON.stringify(failed[0]?.result)}`,
    );

    const answered = completedCalls(run, RESULT_TOOL);
    check(
      failures,
      answered.length === 1,
      `expected 1 ${RESULT_TOOL} call, got ${answered.length}\n  ${describeRun(run)}`,
    );
    if (answered.length !== 1) return failures;

    // The tool's parameters are the schema, so its arguments are the answer itself.
    const answer = answered[0].args ?? {};
    check(
      failures,
      Number.isInteger(answer.count),
      `answer does not satisfy the schema: ${JSON.stringify(answer)}`,
    );
    check(
      failures,
      answer.count === EXPECTED_COUNT,
      `counted ${answer.count} .ts files in the root, there are ${EXPECTED_COUNT}`,
    );
    // The parent reads the answer from `details` (see json-schema.ts), so the two must agree.
    check(
      failures,
      JSON.stringify(answered[0].result?.details) === JSON.stringify(answer),
      `details ${JSON.stringify(answered[0].result?.details)} does not match the arguments`,
    );
    return failures;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

export default {
  name: "direct-subagent",
  cases: {
    "child enforces --json-schema and cannot recurse": directSubagent,
  },
};
