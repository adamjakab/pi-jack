import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const agentDir = vi.hoisted(() => ({ current: "" }));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
  getAgentDir: () => agentDir.current,
}));

const { BUILT_IN_AGENTS_DIR, discoverAgents: discoverWith } =
  await import("../agents.ts");

// The user's agents live in <agentDir>/agents; tests use their own built-in folder unless they say otherwise.
const builtInDir = () => path.join(agentDir.current, "built-in");
const discoverAgents = () => discoverWith(builtInDir());

function writeAgent(
  name: string,
  content: string,
  folder = path.join(agentDir.current, "agents"),
) {
  fs.writeFileSync(path.join(folder, name), content);
}

beforeEach(() => {
  agentDir.current = fs.mkdtempSync(path.join(os.tmpdir(), "jack-test-"));
  fs.mkdirSync(path.join(agentDir.current, "agents"));
  fs.mkdirSync(builtInDir());
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
        'schema: \'{"ok": "boolean"}\'\n---\nYou are a probe.\n',
    );
    expect(discoverAgents().agents).toEqual([
      {
        name: "probe",
        description: "A probe",
        tools: ["read", "bash"],
        model: "some-model",
        schema: '{"ok": "boolean"}',
        dir: path.join(agentDir.current, "agents"),
        source: "user",
        systemPrompt: expect.stringContaining("You are a probe."),
      },
    ]);
  });

  it("keeps a schema written as YAML as an object", () => {
    writeAgent(
      "a.md",
      "---\nname: a\ndescription: d\nschema:\n  type: object\n  required: [ok]\n---\nbody\n",
    );
    expect(discoverAgents().agents[0].schema).toEqual({
      type: "object",
      required: ["ok"],
    });
  });

  it("reads a thinking level, and reports one that isn't offered", () => {
    writeAgent(
      "deep.md",
      "---\nname: deep\ndescription: d\nthinking: high\n---\nbody\n",
    );
    writeAgent(
      "odd.md",
      "---\nname: odd\ndescription: d\nthinking: minimal\n---\nbody\n",
    );
    const { agents, errors } = discoverAgents();
    expect(agents.map((a) => [a.name, a.thinking])).toEqual([["deep", "high"]]);
    expect(errors).toEqual([
      {
        file: "odd.md",
        source: "user",
        message: "`thinking` must be one of off, low, medium, high, xhigh, max",
      },
    ]);
  });

  it("reports files without a name or description, and ignores non-Markdown files", () => {
    writeAgent("no-name.md", "---\ndescription: d\n---\nbody\n");
    writeAgent("no-description.md", "---\nname: x\n---\nbody\n");
    writeAgent("notes.txt", "---\nname: txt\ndescription: d\n---\nbody\n");
    const { agents, errors } = discoverAgents();
    expect(agents).toEqual([]);
    expect(errors.map((e) => e.file).sort()).toEqual([
      "no-description.md",
      "no-name.md",
    ]);
    expect(errors[0].message).toMatch(/needs a `name` and a `description`/);
  });

  it("reports a file whose frontmatter is not valid YAML, and still loads the others", () => {
    writeAgent(
      "broken.md",
      "---\nname: b\ndescription: d\nschema: {type: object, properties: [\n---\nbody\n",
    );
    writeAgent("good.md", "---\nname: good\ndescription: d\n---\nbody\n");
    const { agents, errors } = discoverAgents();
    expect(agents.map((a) => a.name)).toEqual(["good"]);
    expect(errors).toEqual([
      {
        file: "broken.md",
        source: "user",
        message: expect.stringMatching(/^Flow sequence/),
      },
    ]);
    expect(errors[0].message).not.toContain("\n");
  });

  it("loads built-in agents, and lets a user agent of the same name replace one", () => {
    writeAgent(
      "worker.md",
      "---\nname: worker\ndescription: built-in\n---\nb\n",
      builtInDir(),
    );
    writeAgent(
      "helper.md",
      "---\nname: helper\ndescription: built-in\n---\nb\n",
      builtInDir(),
    );
    writeAgent("worker.md", "---\nname: worker\ndescription: mine\n---\nu\n");

    const { agents } = discoverAgents();
    expect(
      agents.map((a) => [a.name, a.description, a.source, a.overridesBuiltIn]),
    ).toEqual([
      ["helper", "built-in", "built-in", undefined],
      ["worker", "mine", "user", true],
    ]);
    expect(agents.find((a) => a.name === "helper")!.dir).toBe(builtInDir());
  });

  it("reports which folder a broken file is in", () => {
    writeAgent("bad.md", "---\ndescription: d\n---\nb\n", builtInDir());
    expect(discoverAgents().errors).toEqual([
      expect.objectContaining({ file: "bad.md", source: "built-in" }),
    ]);
  });
});

describe("built-in agents", () => {
  it("ships a loadable worker agent", () => {
    const { agents, errors } = discoverWith(BUILT_IN_AGENTS_DIR);
    expect(errors).toEqual([]);
    expect(agents.find((a) => a.name === "worker")).toMatchObject({
      source: "built-in",
      dir: BUILT_IN_AGENTS_DIR,
    });
  });
});
