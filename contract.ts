/**
 * The output contract between subagent_runner (the parent) and its subagents (child pi processes).
 *
 * A subagent answers by calling the `subagent_result` tool, whose parameters are the run's JSON Schema, so each
 * field's `description` reaches the model right where it fills that field. It gives up by calling `subagent_fail`
 * with a reason instead. Both tools live in child.ts, which the parent loads into every child; this module holds
 * what both sides share: the tool names, the default schema, schema loading, and validation.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";

/** Tool a subagent calls with its answer; its parameters are the run's schema. */
export const RESULT_TOOL = "subagent_result";

/** Tool a subagent calls, instead of RESULT_TOOL, when it cannot complete the task. */
export const FAIL_TOOL = "subagent_fail";

/** CLI flag, registered by child.ts, that carries the path of the run's schema file to the child. */
export const SCHEMA_FLAG = "subagent-schema";

/**
 * How many invalid answers or nudges a subagent gets after its first try. An invalid `subagent_result` call is
 * thrown back with its errors so the model can fix it; finishing without calling either tool earns a nudge.
 */
export const MAX_FORMAT_RETRIES = 2;

/** Schema used when neither the call nor the agent gives one. */
export const DEFAULT_SCHEMA = {
  type: "object",
  properties: {
    success: {
      type: "boolean",
      description: "True only when all requested operations were finished and nothing is left to do.",
    },
    result: {
      type: "string",
      description: "A concise description of what was found or achieved during this session.",
    },
  },
  required: ["success", "result"],
  additionalProperties: true,
} as const;

/**
 * Turns a schema given as an object, inline JSON, or a path to a `.json` file into a JSON Schema object.
 * Relative paths resolve against `baseDir`. Tool parameters must be an object, so the root must describe one.
 * Throws with a message fit for the caller when the schema can't be used.
 */
export function resolveSchema(value: unknown, baseDir: string): TSchema {
  let schema = value;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) throw new Error("the schema is empty");
    if (text.startsWith("{")) {
      try {
        schema = JSON.parse(text);
      } catch (e) {
        throw new Error(`the inline schema is not valid JSON (${e instanceof Error ? e.message : e})`);
      }
    } else {
      const filePath = path.resolve(baseDir, text);
      try {
        schema = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      } catch (e) {
        throw new Error(`could not load the schema file ${filePath} (${e instanceof Error ? e.message : e})`);
      }
    }
  }

  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error("the schema must be a JSON Schema object");
  }
  const root = schema as Record<string, unknown>;
  if (root.type !== "object" && root.properties === undefined) {
    throw new Error('the root of the schema must describe an object, e.g. {"type": "object", "properties": {...}}');
  }
  return root as TSchema;
}

/** Lists how `value` breaks `schema`, as "/path: message" lines (at most 10); empty when it conforms. */
export function schemaErrors(schema: TSchema, value: unknown): string[] {
  return [...Value.Errors(schema, value)].slice(0, 10).map((e) => {
    // TypeBox reports a property that `additionalProperties: false` forbids as "schema is false".
    const message = e.message === "schema is false" ? "property not allowed by the schema" : e.message;
    return `${e.instancePath || "/"}: ${message}`;
  });
}
