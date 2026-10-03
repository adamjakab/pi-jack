import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const agentDir = vi.hoisted(() => ({ current: "" }));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
  getAgentDir: () => agentDir.current,
}));

const { discoverAgents } = await import("../agents.ts");

function writeAgent(name: string, content: string) {
  fs.writeFileSync(path.join(agentDir.current, "agents", name), content);
}

beforeEach(() => {
  agentDir.current = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-runner-test-"));
  fs.mkdirSync(path.join(agentDir.current, "agents"));
});

afterEach(() => {
  fs.rmSync(agentDir.current, { recursive: true, force: true });
});

describe("discoverAgents", () => {
  it("returns nothing when the agents directory is missing", () => {
    fs.rmSync(path.join(agentDir.current, "agents"), { recursive: true });
    expect(discoverAgents()).toEqual([]);
  });

  it("parses frontmatter and body", () => {
    writeAgent(
      "probe.md",
      "---\nname: probe\ndescription: A probe\ntools: read, bash\nmodel: some-model\n" +
        "schema: '{\"ok\": \"boolean\"}'\n---\nYou are a probe.\n",
    );
    expect(discoverAgents()).toEqual([
      {
        name: "probe",
        description: "A probe",
        tools: ["read", "bash"],
        model: "some-model",
        schema: '{"ok": "boolean"}',
        systemPrompt: expect.stringContaining("You are a probe."),
      },
    ]);
  });

  it("turns an unquoted YAML schema object back into JSON", () => {
    writeAgent("a.md", "---\nname: a\ndescription: d\nschema: {ok: boolean}\n---\nbody\n");
    expect(JSON.parse(discoverAgents()[0].schema!)).toEqual({ ok: "boolean" });
  });

  it("skips files without a name or description, and non-Markdown files", () => {
    writeAgent("no-name.md", "---\ndescription: d\n---\nbody\n");
    writeAgent("no-description.md", "---\nname: x\n---\nbody\n");
    writeAgent("notes.txt", "---\nname: txt\ndescription: d\n---\nbody\n");
    expect(discoverAgents()).toEqual([]);
  });
});
