/**
 * Agent discovery. Loads the agents built into this extension (its own `agents/` folder, e.g. the default `worker`)
 * and the user's agents (~/.pi/agent/agents/*.md). A user agent with the same name as a built-in one replaces it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

/** Folder of the agents that ship with this extension. */
export const BUILT_IN_AGENTS_DIR = fileURLToPath(new URL("./agents", import.meta.url));

/** Where an agent comes from: this extension, or the user's agents folder. */
export type AgentSource = "built-in" | "user";

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  /**
   * Default output schema, used when the call doesn't pass one: a JSON Schema written as YAML, inline JSON, or a
   * path to a `.json` file relative to `dir`. Resolved by contract.ts's resolveSchema().
   */
  schema?: unknown;
  /** Folder of the agent file, which relative paths in its frontmatter resolve against. */
  dir: string;
  source: AgentSource;
  /** Set on a user agent that replaces a built-in agent of the same name. */
  overridesBuiltIn?: boolean;
  systemPrompt: string;
}

function parseToolList(value: unknown): string[] | undefined {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const tools = raw
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.trim())
    .filter(Boolean);
  return tools.length > 0 ? tools : undefined;
}

function parseSchema(value: unknown): unknown {
  if (typeof value === "string") return value.trim() || undefined;
  if (value && typeof value === "object") return value;
  return undefined;
}

/** An agent file that could not be loaded, and why. */
export interface AgentLoadError {
  /** The file's name, e.g. `worker.md`. */
  file: string;
  source: AgentSource;
  message: string;
}

/**
 * Loads the built-in agents, then the user's, which replace built-in agents of the same name. A file that can't be
 * read or parsed is reported in `errors` instead of throwing, so one broken file never hides the others.
 */
export function discoverAgents(builtInDir = BUILT_IN_AGENTS_DIR): { agents: AgentConfig[]; errors: AgentLoadError[] } {
  const builtIn = loadAgentDir(builtInDir, "built-in");
  const user = loadAgentDir(path.join(getAgentDir(), "agents"), "user");

  const userNames = new Set(user.agents.map((a) => a.name));
  const builtInNames = new Set(builtIn.agents.map((a) => a.name));
  const agents = [
    ...builtIn.agents.filter((a) => !userNames.has(a.name)),
    ...user.agents.map((a) => (builtInNames.has(a.name) ? { ...a, overridesBuiltIn: true } : a)),
  ];
  return { agents, errors: [...builtIn.errors, ...user.errors] };
}

function loadAgentDir(dir: string, source: AgentSource): { agents: AgentConfig[]; errors: AgentLoadError[] } {
  const agents: AgentConfig[] = [];
  const errors: AgentLoadError[] = [];

  if (!fs.existsSync(dir)) return { agents, errors };

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    errors.push({ file: dir, source, message: e instanceof Error ? e.message : String(e) });
    return { agents, errors };
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = path.join(dir, entry.name);
    let parsed;
    try {
      parsed = parseFrontmatter<{
        name?: unknown;
        description?: unknown;
        tools?: unknown;
        model?: unknown;
        schema?: unknown;
      }>(fs.readFileSync(filePath, "utf-8"));
    } catch (e) {
      // Keep only the first line: YAML errors go on to draw the offending line with a caret.
      const message = (e instanceof Error ? e.message : String(e)).split("\n")[0].replace(/:$/, "");
      errors.push({ file: entry.name, source, message });
      continue;
    }
    const { frontmatter, body } = parsed;

    if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") {
      errors.push({ file: entry.name, source, message: "the frontmatter needs a `name` and a `description`" });
      continue;
    }

    agents.push({
      name: frontmatter.name,
      description: frontmatter.description,
      tools: parseToolList(frontmatter.tools),
      model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
      schema: parseSchema(frontmatter.schema),
      dir,
      source,
      systemPrompt: body,
    });
  }

  return { agents, errors };
}
