/**
 * JACK, child side — loaded into every subagent with `--extension child.ts --jack-schema <file>`.
 *
 * Registers the two tools a subagent finishes with (see contract.ts):
 *   - `jack_subagent_result`: parameters are the run's JSON Schema, with provider-side constrained sampling requested.
 *     Pi validates the arguments against it before the tool runs, and the tool checks them again; either way an
 *     invalid call is thrown back with the errors so the model can fix it. The parent stops the child once it has
 *     rejected more than MAX_FORMAT_RETRIES answers, since only it sees both kinds of rejection.
 *   - `jack_subagent_fail({ reason })`: ends the run when the task cannot be completed.
 * If the agent is about to finish without calling either, a hidden message nudges it, up to MAX_FORMAT_RETRIES times.
 *
 * The parent reads the outcome from the `tool_execution_end` events of these tools in the child's JSON stream.
 * Does nothing unless `--jack-schema` is set, so it is inert if loaded anywhere else.
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

export default function subagentChild(pi: ExtensionAPI): void {
  pi.registerFlag(SCHEMA_FLAG, {
    description:
      "Internal to jack: path of the JSON Schema this subagent's answer must conform to",
    type: "string",
  });

  // Per-run state.
  let finished = false;
  let nudges = 0;

  const report = (ctx: ExtensionContext, message: string) => {
    if (ctx.hasUI) ctx.ui.notify(message, "error");
    console.error(message);
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
          `If you cannot complete the task, call ${FAIL_TOOL} with the reason instead of ${RESULT_TOOL}.`,
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

    // The parent adds both tools to any `--tools` list; this keeps them active under the default tool set too.
    const active = pi.getActiveTools();
    const missing = [RESULT_TOOL, FAIL_TOOL].filter((t) => !active.includes(t));
    if (missing.length > 0) pi.setActiveTools([...active, ...missing]);
    if (!pi.getActiveTools().includes(RESULT_TOOL)) {
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

  pi.on("agent_before_settle", () => {
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
            `You have not submitted an answer. Call ${RESULT_TOOL} now with your answer as its arguments ` +
            `(or ${FAIL_TOOL} with the reason if you cannot complete the task).`,
        },
      ],
    };
  });
}
