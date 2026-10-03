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
    expect(discoverAgents()).toEqual({ agents: [], errors: [] });
  });

  it("parses frontmatter and body", () => {
    writeAgent(
      "probe.md",
      "---\nname: probe\ndescription: A probe\ntools: read, bash\nmodel: some-model\n" +
        "schema: '{\"ok\": \"boolean\"}'\n---\nYou are a probe.\n",
    );
    expect(discoverAgents().agents).toEqual([
      {
        name: "probe",
        description: "A probe",
        tools: ["read", "bash"],
        model: "some-model",
        schema: '{"ok": "boolean"}',
        dir: path.join(agentDir.current, "agents"),
        systemPrompt: expect.stringContaining("You are a probe."),
      },
    ]);
  });

  it("keeps a schema written as YAML as an object", () => {
    writeAgent("a.md", "---\nname: a\ndescription: d\nschema:\n  type: object\n  required: [ok]\n---\nbody\n");
    expect(discoverAgents().agents[0].schema).toEqual({ type: "object", required: ["ok"] });
  });

  it("reports files without a name or description, and ignores non-Markdown files", () => {
    writeAgent("no-name.md", "---\ndescription: d\n---\nbody\n");
    writeAgent("no-description.md", "---\nname: x\n---\nbody\n");
    writeAgent("notes.txt", "---\nname: txt\ndescription: d\n---\nbody\n");
    const { agents, errors } = discoverAgents();
    expect(agents).toEqual([]);
    expect(errors.map((e) => e.file).sort()).toEqual(["no-description.md", "no-name.md"]);
    expect(errors[0].message).toMatch(/needs a `name` and a `description`/);
  });

  it("reports a file whose frontmatter is not valid YAML, and still loads the others", () => {
    writeAgent("broken.md", "---\nname: b\ndescription: d\nschema: {type: object, properties: [\n---\nbody\n");
    writeAgent("good.md", "---\nname: good\ndescription: d\n---\nbody\n");
    const { agents, errors } = discoverAgents();
    expect(agents.map((a) => a.name)).toEqual(["good"]);
    expect(errors).toEqual([{ file: "broken.md", message: expect.stringMatching(/^Flow sequence/) }]);
    expect(errors[0].message).not.toContain("\n");
  });
});
