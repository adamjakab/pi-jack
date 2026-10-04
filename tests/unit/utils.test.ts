import { afterEach, describe, expect, it } from "vitest";
import {
  describeAgent,
  describeLoadErrors,
  getFinalAssistantText,
  getPiInvocation,
  mapWithLimit,
  normalizeTools,
  taskLabel,
} from "../../src/utils.ts";

describe("normalizeTools", () => {
  it("splits and trims a comma-separated string", () => {
    expect(normalizeTools(" read, bash ,grep")).toEqual([
      "read",
      "bash",
      "grep",
    ]);
  });

  it("keeps string entries of an array and drops the rest", () => {
    expect(normalizeTools(["read", 42, " bash ", ""])).toEqual([
      "read",
      "bash",
    ]);
  });

  it("returns undefined when nothing usable is given", () => {
    expect(normalizeTools(undefined)).toBeUndefined();
    expect(normalizeTools("")).toBeUndefined();
    expect(normalizeTools(" , ")).toBeUndefined();
    expect(normalizeTools([])).toBeUndefined();
  });
});

describe("taskLabel", () => {
  it("returns a short single-line task unchanged", () => {
    expect(taskLabel("count files")).toBe("count files");
  });

  it("truncates the first line at 60 characters", () => {
    expect(taskLabel("x".repeat(61))).toBe(`${"x".repeat(60)}...`);
  });

  it("marks multi-line tasks as truncated", () => {
    expect(taskLabel("first\nsecond")).toBe("first...");
  });
});

describe("getFinalAssistantText", () => {
  const assistant = (...texts: string[]) =>
    ({
      role: "assistant",
      content: texts.map((text) => ({ type: "text", text })),
    }) as any;

  it("returns the first text part of the last assistant message", () => {
    const messages = [
      assistant("old"),
      { role: "user", content: [] } as any,
      assistant("new", "extra"),
    ];
    expect(getFinalAssistantText(messages)).toBe("new");
  });

  it("skips assistant messages without text", () => {
    const toolOnly = {
      role: "assistant",
      content: [{ type: "toolCall" }],
    } as any;
    expect(getFinalAssistantText([assistant("answer"), toolOnly])).toBe(
      "answer",
    );
  });

  it("looks past messages from other roles", () => {
    const user = { role: "user", content: [] } as any;
    expect(getFinalAssistantText([assistant("answer"), user])).toBe("answer");
  });

  it("returns undefined when there is no assistant text", () => {
    expect(getFinalAssistantText([])).toBeUndefined();
  });
});

describe("mapWithLimit", () => {
  it("keeps results in input order", async () => {
    const delays = [30, 10, 20];
    const out = await mapWithLimit(delays, 3, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return i;
    });
    expect(out).toEqual([0, 1, 2]);
  });

  it("never runs more than `concurrency` items at once", async () => {
    let active = 0;
    let peak = 0;
    await mapWithLimit(Array.from({ length: 10 }), 4, async () => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    });
    expect(peak).toBe(4);
  });

  it("treats concurrency below 1 as sequential", async () => {
    let active = 0;
    let peak = 0;
    await mapWithLimit([1, 2, 3], 0, async () => {
      peak = Math.max(peak, ++active);
      await Promise.resolve();
      active--;
    });
    expect(peak).toBe(1);
  });

  it("returns an empty array for no items", async () => {
    expect(await mapWithLimit([], 4, async () => 1)).toEqual([]);
  });
});

describe("getPiInvocation", () => {
  const { argv, execPath } = process;
  afterEach(() => {
    process.argv = argv;
    process.execPath = execPath;
  });

  it("reruns the current script when pi runs as a script on disk", () => {
    process.argv = [execPath, import.meta.filename];
    expect(getPiInvocation(["-p"])).toEqual({
      command: execPath,
      args: [import.meta.filename, "-p"],
    });
  });

  it("runs this executable when pi is a compiled binary", () => {
    process.argv = ["/usr/local/bin/pi", "/$bunfs/root/pi"];
    process.execPath = "/usr/local/bin/pi";
    expect(getPiInvocation(["-p"])).toEqual({
      command: "/usr/local/bin/pi",
      args: ["-p"],
    });
  });

  it("falls back to pi on the PATH under a generic runtime", () => {
    process.argv = ["/usr/bin/node"];
    process.execPath = "/usr/bin/node";
    expect(getPiInvocation(["-p"])).toEqual({ command: "pi", args: ["-p"] });
  });
});

describe("describeLoadErrors", () => {
  it("lists each file with its error, marking built-in ones", () => {
    expect(
      describeLoadErrors([
        { file: "a.md", source: "user", message: "bad yaml" },
        { file: "b.md", source: "built-in", message: "no name" },
      ]),
    ).toBe("a.md (bad yaml); b.md [built-in] (no name)");
  });
});

describe("describeAgent", () => {
  const agent = {
    name: "a",
    description: "Does a",
    dir: "/x",
    systemPrompt: "",
  };

  it("marks where the agent comes from", () => {
    expect(describeAgent({ ...agent, source: "user" })).toBe("- a: Does a");
    expect(describeAgent({ ...agent, source: "built-in" })).toBe(
      "- a (built-in): Does a",
    );
    expect(
      describeAgent({ ...agent, source: "user", overridesBuiltIn: true }),
    ).toBe("- a (yours, overrides built-in): Does a");
  });
});
