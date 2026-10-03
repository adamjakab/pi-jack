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

export function discoverAgents(): AgentConfig[] {
  const dir = path.join(getAgentDir(), "agents");
  const agents: AgentConfig[] = [];

  if (!fs.existsSync(dir)) return agents;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return agents;
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = path.join(dir, entry.name);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const { frontmatter, body } = parseFrontmatter<{
      name?: unknown;
      description?: unknown;
      tools?: unknown;
      model?: unknown;
      schema?: unknown;
    }>(content);

    if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") {
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

  return agents;
}
