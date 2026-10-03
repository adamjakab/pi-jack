/**
 * The output contract between jack (the parent) and its subagents (child pi processes).
 *
 * A subagent answers by calling the `jack_subagent_result` tool, whose parameters are the run's JSON Schema, so each
 * field's `description` reaches the model right where it fills that field. It gives up by calling `jack_subagent_fail`
 * with a reason instead. Both tools live in child.ts, which the parent loads into every child; this module holds
 * what both sides share: the tool names, the default schema, schema loading, validation, and thinking levels.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";

/** Tool a subagent calls with its answer; its parameters are the run's schema. */
export const RESULT_TOOL = "jack_subagent_result";

/** Tool a subagent calls, instead of RESULT_TOOL, when it cannot complete the task. */
export const FAIL_TOOL = "jack_subagent_fail";

/** CLI flag, registered by child.ts, that carries the path of the run's schema file to the child. */
export const SCHEMA_FLAG = "jack-schema";

/**
 * Thinking levels a subagent can be asked for, lowest first. They are passed to the child as `--thinking`; for a
 * level the model doesn't support, pi uses the nearest higher level it does, else the nearest lower one.
 */
export const THINKING_LEVELS = [
  "off",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const isThinkingLevel = (value: unknown): value is ThinkingLevel =>
  THINKING_LEVELS.includes(value as ThinkingLevel);

/**
 * How many invalid answers or nudges a subagent gets after its first try. An invalid `jack_subagent_result` call is
 * thrown back with its errors so the model can fix it; finishing without calling either tool earns a nudge.
 */
export const MAX_FORMAT_RETRIES = 2;

/** Schema used when neither the call nor the agent gives one. */
export const DEFAULT_SCHEMA = {
  type: "object",
  properties: {
    success: {
      type: "boolean",
      description:
        "True only when all requested operations were finished and nothing is left to do.",
    },
    result: {
      type: "string",
      description:
        "A concise description of what was found or achieved during this session.",
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
        throw new Error(
          `the inline schema is not valid JSON (${e instanceof Error ? e.message : e})`,
        );
      }
    } else {
      const filePath = path.resolve(baseDir, text);
      try {
        schema = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      } catch (e) {
        throw new Error(
          `could not load the schema file ${filePath} (${e instanceof Error ? e.message : e})`,
        );
      }
    }
  }

  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error("the schema must be a JSON Schema object");
  }
  const root = schema as Record<string, unknown>;
  if (root.type !== "object" && root.properties === undefined) {
    throw new Error(
      'the root of the schema must describe an object, e.g. {"type": "object", "properties": {...}}',
    );
  }
  const problems = schemaProblems(root);
  if (problems.length > 0) throw new Error(problems.slice(0, 10).join("; "));
  return root as TSchema;
}

const JSON_TYPES = [
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
  "null",
];

type Check = (value: unknown, at: string) => string[];

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const must = (ok: boolean, at: string, what: string): string[] =>
  ok ? [] : [`${at}: must be ${what}`];

const isString: Check = (v, at) => must(typeof v === "string", at, "a string");
const isNumber: Check = (v, at) =>
  must(typeof v === "number" && Number.isFinite(v), at, "a number");
const isCount: Check = (v, at) =>
  must(Number.isInteger(v) && (v as number) >= 0, at, "a non-negative integer");
const isBoolean: Check = (v, at) =>
  must(typeof v === "boolean", at, "true or false");
const isAny: Check = () => [];
const isSchema: Check = (v, at) => schemaProblems(v, at);
const isSchemaOrBoolean: Check = (v, at) =>
  typeof v === "boolean" ? [] : schemaProblems(v, at);
const isStringList: Check = (v, at) =>
  must(
    Array.isArray(v) && v.every((x) => typeof x === "string"),
    at,
    "a list of strings",
  );
const isSchemaList: Check = (v, at) =>
  Array.isArray(v) && v.length > 0
    ? v.flatMap((x, i) => schemaProblems(x, `${at}/${i}`))
    : [`${at}: must be a non-empty list of schemas`];
const isSchemaMap: Check = (v, at) =>
  isObject(v)
    ? Object.entries(v).flatMap(([k, x]) => schemaProblems(x, `${at}/${k}`))
    : [`${at}: must be an object`];

const isType: Check = (v, at) => {
  const names = Array.isArray(v) ? v : [v];
  if (names.length === 0) return [`${at}: must name at least one type`];
  return names.flatMap((name) =>
    typeof name === "string" && JSON_TYPES.includes(name)
      ? []
      : [
          `${at}: ${JSON.stringify(name)} is not a JSON Schema type (use ${JSON_TYPES.join(", ")})`,
        ],
  );
};

const isPattern: Check = (v, at) => {
  if (typeof v !== "string") return [`${at}: must be a string`];
  try {
    new RegExp(v, "u");
    return [];
  } catch (e) {
    return [
      `${at}: is not a valid regular expression (${e instanceof Error ? e.message : e})`,
    ];
  }
};

/** The JSON Schema keywords accepted, each with a check of its value. Anything else is reported as unknown. */
const KEYWORDS: Record<string, Check> = {
  // Identity and annotations
  $schema: isString,
  $id: isString,
  $ref: isString,
  $comment: isString,
  $defs: isSchemaMap,
  definitions: isSchemaMap,
  title: isString,
  description: isString,
  default: isAny,
  examples: (v, at) => must(Array.isArray(v), at, "a list"),
  deprecated: isBoolean,
  readOnly: isBoolean,
  writeOnly: isBoolean,
  // Any type
  type: isType,
  enum: (v, at) =>
    must(Array.isArray(v) && v.length > 0, at, "a non-empty list"),
  const: isAny,
  allOf: isSchemaList,
  anyOf: isSchemaList,
  oneOf: isSchemaList,
  not: isSchema,
  if: isSchema,
  then: isSchema,
  else: isSchema,
  // Objects
  properties: isSchemaMap,
  patternProperties: isSchemaMap,
  additionalProperties: isSchemaOrBoolean,
  unevaluatedProperties: isSchemaOrBoolean,
  propertyNames: isSchema,
  required: isStringList,
  minProperties: isCount,
  maxProperties: isCount,
  dependentRequired: (v, at) =>
    isObject(v)
      ? Object.entries(v).flatMap(([k, x]) => isStringList(x, `${at}/${k}`))
      : [`${at}: must be an object`],
  dependentSchemas: isSchemaMap,
  // Arrays
  items: (v, at) =>
    Array.isArray(v) ? isSchemaList(v, at) : isSchemaOrBoolean(v, at),
  prefixItems: isSchemaList,
  additionalItems: isSchemaOrBoolean,
  unevaluatedItems: isSchemaOrBoolean,
  contains: isSchema,
  minContains: isCount,
  maxContains: isCount,
  minItems: isCount,
  maxItems: isCount,
  uniqueItems: isBoolean,
  // Strings
  minLength: isCount,
  maxLength: isCount,
  pattern: isPattern,
  format: isString,
  contentEncoding: isString,
  contentMediaType: isString,
  // Numbers
  minimum: isNumber,
  maximum: isNumber,
  exclusiveMinimum: isNumber,
  exclusiveMaximum: isNumber,
  multipleOf: (v, at) =>
    must(typeof v === "number" && v > 0, at, "a positive number"),
};

/**
 * Checks that `schema` is well-formed JSON Schema, as "/path: problem" lines; empty when it is.
 *
 * Validators silently ignore what they don't understand, so a typo like `"type": "strin"` or `"requried"` would
 * otherwise turn a rule into no rule at all. This catches those before a subagent is started: unknown keywords,
 * unknown type names, and keyword values of the wrong shape, recursively.
 */
export function schemaProblems(schema: unknown, at = ""): string[] {
  if (!isObject(schema)) return [`${at || "/"}: a schema must be an object`];
  return Object.entries(schema).flatMap(([keyword, value]) => {
    const check = KEYWORDS[keyword];
    const here = `${at}/${keyword}`;
    return check
      ? check(value, here)
      : [`${here}: unknown JSON Schema keyword`];
  });
}

/** Lists how `value` breaks `schema`, as "/path: message" lines (at most 10); empty when it conforms. */
export function schemaErrors(schema: TSchema, value: unknown): string[] {
  return [...Value.Errors(schema, value)].slice(0, 10).map((e) => {
    // TypeBox reports a property that `additionalProperties: false` forbids as "schema is false".
    const message =
      e.message === "schema is false"
        ? "property not allowed by the schema"
        : e.message;
    return `${e.instancePath || "/"}: ${message}`;
  });
}
