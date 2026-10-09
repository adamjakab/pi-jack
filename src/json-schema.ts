/**
 * `--json-schema <schema>`: makes a pi run finish with an answer that conforms to a JSON Schema. The value is an
 * inline JSON Schema or a path to a `.json` file (relative to the working directory). Part of JACK: the parent starts
 * every subagent with it, and it works the same in any pi run, e.g.
 *
 *   pi --mode json -p --json-schema ./schema.json "Summarize this repository"
 *
 * Registers the two tools such a run finishes with (see contract.ts):
 *   - `jack_subagent_result`: parameters are the run's JSON Schema, with provider-side constrained sampling requested.
 *     Pi validates the arguments against it before the tool runs, and the tool checks them again; either way an
 *     invalid call is thrown back with the errors so the model can fix it. For a subagent, JACK's parent stops the
 *     child once it has rejected more than MAX_FORMAT_RETRIES answers, since only it sees both kinds of rejection.
 *   - `jack_subagent_fail({ reason })`: ends the run when the task cannot be completed. A `--tools` list that leaves
 *     it out keeps it out of the run, and then nothing tells the model it exists.
 * If the agent is about to finish a completed turn without calling either, a hidden message nudges it, up to
 * MAX_FORMAT_RETRIES times. A turn that ended in a provider error or an abort is never nudged.
 *
 * With `--mode json`, the answer is `result.details` of the last successful `tool_execution_end` event of
 * `jack_subagent_result` (or the reason, for `jack_subagent_fail`); that is where JACK's parent reads it.
 * Does nothing unless `--json-schema` is set.
 */

import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  FAIL_TOOL,
  MAX_FORMAT_RETRIES,
  RESULT_TOOL,
  resolveSchema,
  SCHEMA_FLAG,
  schemaErrors,
} from "./contract.ts";

export function registerJsonSchema(pi: ExtensionAPI): void {
  pi.registerFlag(SCHEMA_FLAG, {
    description:
      "JSON Schema (inline JSON or path to a .json file) that the final answer must conform to",
    type: "string",
  });

  // Per-run state.
  let finished = false;
  let nudges = 0;
  /** Whether this run can give up with FAIL_TOOL; false when a `--tools` list leaves it out. */
  let canFail = false;

  const report = (ctx: ExtensionContext, message: string) => {
    if (ctx.hasUI) ctx.ui.notify(message, "error");
    console.error(message);
  };

  /** Activates `name` if pi kept it; a tool a `--tools` list leaves out is not in pi's registry and stays out. */
  const activate = (name: string): boolean => {
    const active = pi.getActiveTools();
    if (!active.includes(name)) pi.setActiveTools([...active, name]);
    return pi.getActiveTools().includes(name);
  };

  pi.on("session_start", (_event, ctx) => {
    const schemaPath = pi.getFlag(SCHEMA_FLAG);
    if (typeof schemaPath !== "string" || !schemaPath) return;

    let schema;
    try {
      schema = resolveSchema(schemaPath, ctx.cwd);
    } catch (e) {
      report(
        ctx,
        `[jack] Could not load the schema: ${e instanceof Error ? e.message : e}`,
      );
      return;
    }

    // Registered before the result tool, whose guidance must not tell the model to call a tool it does not have.
    pi.registerTool(
      defineTool({
        name: FAIL_TOOL,
        label: "Subagent Fail",
        description:
          `Give up on the task. Call it instead of ${RESULT_TOOL}, as your last action, only when the task ` +
          "cannot be completed; the delegating agent receives the reason as the error.",
        parameters: Type.Object({
          reason: Type.String({
            description:
              "One or two sentences: what stopped you, and what would unblock it.",
          }),
        }),
        async execute(_toolCallId, params) {
          finished = true;
          return {
            content: [{ type: "text", text: params.reason }],
            details: params,
            terminate: true,
          };
        },
      }),
    );
    canFail = activate(FAIL_TOOL);

    pi.registerTool(
      defineTool({
        name: RESULT_TOOL,
        label: "Subagent Result",
        description:
          "Submit your final answer to the agent that delegated this task. Call it exactly once, as your last " +
          "action, when the task is done. The parameters are the answer: fill each one as its description says.",
        promptSnippet: "Submit your final answer as structured data",
        promptGuidelines: [
          `Finish by calling ${RESULT_TOOL} exactly once with your answer; its parameters define what to return.`,
          `Your text replies are not returned to anyone; only the arguments of ${RESULT_TOOL} are.`,
          ...(canFail
            ? [
                `If you cannot complete the task, call ${FAIL_TOOL} with the reason instead of ${RESULT_TOOL}.`,
              ]
            : []),
        ],
        parameters: schema,
        // "prefer" falls back to plain tool calling on providers without strict JSON-schema sampling;
        // the validation below applies either way.
        constrainedSampling: { type: "json_schema", strict: "prefer" },
        async execute(_toolCallId, params) {
          const errors = schemaErrors(schema, params);
          if (errors.length === 0) {
            finished = true;
            return {
              content: [{ type: "text", text: JSON.stringify(params) }],
              details: params,
              terminate: true,
            };
          }
          const list = errors.map((e) => `- ${e}`).join("\n");
          throw new Error(
            `The answer does not match the schema. Fix these and call ${RESULT_TOOL} again:\n${list}`,
          );
        },
      }),
    );

    // The parent adds both tools to any `--tools` list; this keeps them active under the default tool set too.
    if (!activate(RESULT_TOOL)) {
      report(
        ctx,
        `[jack] The ${RESULT_TOOL} tool is not available; it must not be excluded from the tool list.`,
      );
    }
  });

  pi.on("before_agent_start", () => {
    finished = false;
    nudges = 0;
  });

  pi.on("agent_before_settle", (event) => {
    // Only a completed turn is the model forgetting to answer. After a provider error or an abort, a nudge would send
    // the whole context again to a provider that has just refused, MAX_FORMAT_RETRIES more times. Named outcomes
    // rather than `!== "completed"`, so a pi without the field still nudges.
    if (event.outcome === "error" || event.outcome === "aborted") return;
    if (
      finished ||
      !pi.getActiveTools().includes(RESULT_TOOL) ||
      nudges >= MAX_FORMAT_RETRIES
    )
      return;
    nudges++;
    return {
      continue: true,
      entries: [
        {
          type: "custom_message",
          customType: "jack-result-nudge",
          display: false,
          content:
            `You have not submitted an answer. Call ${RESULT_TOOL} now with your answer as its arguments` +
            (canFail
              ? ` (or ${FAIL_TOOL} with the reason if you cannot complete the task).`
              : "."),
        },
      ],
    };
  });
}
