/**
 * The output contract between subagent_runner and its subagents: what a subagent is told to reply with, and how
 * the reply is verified.
 *
 * A subagent must reply with one bare JSON value matching its schema, or `{"subagent_error": "..."}` if it cannot
 * finish. Schemas are example shapes rather than JSON Schema: `{"count": "number", "files": ["string"]}`.
 */

/** Schema used when neither the call nor the agent gives one. */
export const DEFAULT_SCHEMA = '{"result": "text"}';

/** The only key of the reply a child sends, under the output contract, when it cannot complete the task. */
export const ERROR_KEY = "subagent_error";

/** The output contract for an agent whose instructions don't state it, appended to its system prompt. */
export function outputContract(schema: string): string {
  return [
    "## Output contract",
    "",
    "Your final message is not read by a person: the subagent runner parses it as JSON and hands the result to the " +
      "agent that delegated this task.",
    "",
    "- Your final message must be exactly one JSON value matching the schema below: no Markdown fences, no prose " +
      "before or after it.",
    "- Finish all tool calls first; the JSON is your last message.",
    "- This contract replaces any other output format in these instructions.",
    `- If you cannot complete the task, reply with exactly \`{"${ERROR_KEY}": "<one-line reason>"}\` instead.`,
    "",
    "Schema:",
    "",
    schema,
  ].join("\n");
}

const SCHEMA_PLACEHOLDER = /\{\{schema\}\}/g;

/** Whether an agent's instructions place the schema themselves, and so state the output contract on their own. */
export function hasSchemaPlaceholder(prompt: string): boolean {
  return prompt.includes("{{schema}}");
}

/** Replaces each `{{schema}}` in an agent's instructions with the schema. */
export function renderSchema(prompt: string, schema: string): string {
  return prompt.replace(SCHEMA_PLACEHOLDER, () => schema);
}

/** Parses a reply made under the output contract, tolerating Markdown fences or stray prose around the JSON. */
export function parseJsonReply(raw: string): unknown {
  const unfenced = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  try {
    return JSON.parse(unfenced);
  } catch (e) {
    const start = unfenced.indexOf("{");
    const end = unfenced.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(unfenced.slice(start, end + 1));
      } catch {
        // fall through to the original error
      }
    }
    throw e;
  }
}

/** Returns the reason when `data` is the contract's error reply, `{ subagent_error: "..." }`. */
export function contractError(data: unknown): string | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const keys = Object.keys(data);
  const reason = (data as Record<string, unknown>)[ERROR_KEY];
  return keys.length === 1 && typeof reason === "string" ? reason : undefined;
}

/** Checks one value of a type expression such as "string", "number?" or "string|null". */
const TYPE_CHECKS: Record<string, (value: unknown) => boolean> = {
  string: (v) => typeof v === "string",
  text: (v) => typeof v === "string",
  number: (v) => typeof v === "number" && Number.isFinite(v),
  integer: (v) => Number.isInteger(v),
  int: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === "boolean",
  bool: (v) => typeof v === "boolean",
  null: (v) => v === null,
  object: (v) => isPlainObject(v),
  array: (v) => Array.isArray(v),
  any: () => true,
  unknown: () => true,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isOptional(shape: unknown): boolean {
  return typeof shape === "string" && shape.trim().endsWith("?");
}

/**
 * Lists how `value` departs from the example `shape`, as "$.path: problem" lines; empty when it matches.
 *
 * - Object: every key is required (unless its type ends in `?`) and checked recursively; extra keys are allowed.
 * - Array: `[x]` checks every item against `x`; `[]` accepts any array.
 * - String: a type name from TYPE_CHECKS, a `|` union of them, optionally ending in `?`. Any other string is a
 *   description, not a type, and accepts any value.
 * - Number or boolean: the value must have the same type. `null` accepts any value.
 */
export function validateShape(value: unknown, shape: unknown, at = "$"): string[] {
  if (Array.isArray(shape)) {
    if (!Array.isArray(value)) return [`${at}: expected array, got ${describe(value)}`];
    if (shape.length === 0) return [];
    return value.flatMap((item, i) => validateShape(item, shape[0], `${at}[${i}]`));
  }
  if (isPlainObject(shape)) {
    if (!isPlainObject(value)) return [`${at}: expected object, got ${describe(value)}`];
    return Object.entries(shape).flatMap(([key, sub]) => {
      if (!(key in value)) return isOptional(sub) ? [] : [`${at}.${key}: missing`];
      return validateShape(value[key], sub, `${at}.${key}`);
    });
  }
  if (typeof shape === "string") {
    const types = shape.trim().replace(/\?$/, "").split("|").map((t) => t.trim().toLowerCase());
    if (!types.every((t) => t in TYPE_CHECKS)) return [];
    if (isOptional(shape) && value === undefined) return [];
    return types.some((t) => TYPE_CHECKS[t](value)) ? [] : [`${at}: expected ${types.join(" or ")}, got ${describe(value)}`];
  }
  if (typeof shape === "number" || typeof shape === "boolean") {
    return typeof value === typeof shape ? [] : [`${at}: expected ${typeof shape}, got ${describe(value)}`];
  }
  return [];
}

export interface Verification {
  /** Whether the reply parsed as JSON. */
  parsed: boolean;
  data: unknown;
  /** What is wrong with the reply's format; empty when it honors the contract. */
  errors: string[];
  /** The subagent's own reason, when it replied with the contract's error form. */
  agentError?: string;
}

/** Verifies a subagent's final reply: it must be JSON, and either the error form or a value matching the schema. */
export function verifyReply(raw: string, schema: string): Verification {
  if (!raw.trim()) return { parsed: false, data: null, errors: ["the reply is empty"] };

  let data: unknown;
  try {
    data = parseJsonReply(raw);
  } catch (e) {
    return { parsed: false, data: null, errors: [`the reply is not valid JSON (${e instanceof Error ? e.message : e})`] };
  }

  const agentError = contractError(data);
  if (agentError !== undefined) return { parsed: true, data, errors: [], agentError };

  // A schema that is not JSON itself (e.g. hand-written `{count: number}`) can't be checked beyond the JSON parse.
  let shape: unknown;
  try {
    shape = JSON.parse(schema);
  } catch {
    return { parsed: true, data, errors: [] };
  }
  return { parsed: true, data, errors: validateShape(data, shape) };
}

/** The follow-up sent to the same subagent session when its reply failed verification. */
export function retryPrompt(errors: string[], schema: string): string {
  return [
    "Your previous reply failed verification by the subagent runner:",
    "",
    ...errors.map((e) => `- ${e}`),
    "",
    "Do not redo the task. Reply again with only one JSON value matching this schema, with no Markdown fences and " +
      "no prose before or after it:",
    "",
    schema,
    "",
    `If you cannot, reply with exactly {"${ERROR_KEY}": "<one-line reason>"}.`,
  ].join("\n");
}
