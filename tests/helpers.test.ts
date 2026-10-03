import { describe, expect, it } from "vitest";
import { getFinalAssistantText, mapWithLimit, normalizeTools, taskLabel } from "../index.ts";

describe("normalizeTools", () => {
  it("splits and trims a comma-separated string", () => {
    expect(normalizeTools(" read, bash ,grep")).toEqual(["read", "bash", "grep"]);
  });

  it("keeps string entries of an array and drops the rest", () => {
    expect(normalizeTools(["read", 42, " bash ", ""])).toEqual(["read", "bash"]);
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
    ({ role: "assistant", content: texts.map((text) => ({ type: "text", text })) }) as any;

  it("returns the first text part of the last assistant message", () => {
    const messages = [assistant("old"), { role: "user", content: [] } as any, assistant("new", "extra")];
    expect(getFinalAssistantText(messages)).toBe("new");
  });

  it("skips assistant messages without text", () => {
    const toolOnly = { role: "assistant", content: [{ type: "toolCall" }] } as any;
    expect(getFinalAssistantText([assistant("answer"), toolOnly])).toBe("answer");
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
