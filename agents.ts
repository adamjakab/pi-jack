/**
 * Simplified agent discovery — loads user-level agents from ~/.pi/agent/agents/*.md
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

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
  file: string;
  message: string;
}

/**
 * Loads every agent file. A file that can't be read or parsed is reported in `errors` instead of throwing, so one
 * broken file never hides the others.
 */
export function discoverAgents(): { agents: AgentConfig[]; errors: AgentLoadError[] } {
  const dir = path.join(getAgentDir(), "agents");
  const agents: AgentConfig[] = [];
  const errors: AgentLoadError[] = [];

  if (!fs.existsSync(dir)) return { agents, errors };

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    errors.push({ file: dir, message: e instanceof Error ? e.message : String(e) });
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
      errors.push({ file: entry.name, message });
      continue;
    }
    const { frontmatter, body } = parsed;

    if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") {
      errors.push({ file: entry.name, message: "the frontmatter needs a `name` and a `description`" });
      continue;
    }

    agents.push({
      name: frontmatter.name,
      description: frontmatter.description,
      tools: parseToolList(frontmatter.tools),
      model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
      schema: parseSchema(frontmatter.schema),
      dir,
      systemPrompt: body,
    });
  }

  return { agents, errors };
}
