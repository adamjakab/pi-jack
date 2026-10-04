/**
 * Test subagent with schema enforcement
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// The repository root, used as a sample folder to survey.
const ROOT = fileURLToPath(new URL("../..", import.meta.url));

const args = [
  "--mode",
  "json",
  "-p",
  "--no-session",
  "--exclude-tools",
  "jack",
  `Count .ts files in ${ROOT}. Return ONLY valid JSON matching: {"count": number, "files": ["string"]}`,
];

const proc = spawn("pi", args, {
  cwd: ROOT,
  shell: false,
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";

proc.stdout.on("data", (d) => {
  stdout += d.toString();
});
proc.stderr.on("data", (d) => {
  stderr += d.toString();
});

proc.on("close", (code) => {
  console.log("Exit code:", code);
  console.log("Stderr:", stderr || "(none)");

  const lines = stdout.trim().split("\n");
  let lastAssistantText: string | null = null;

  for (const line of lines) {
    try {
      const ev = JSON.parse(line);
      if (ev.type === "message_end" && ev.message?.role === "assistant") {
        const text = ev.message.content?.find(
          (c: any) => c.type === "text",
        )?.text;
        if (text) lastAssistantText = text;
      }
    } catch {
      /* ignore */
    }
  }

  console.log("\nRaw assistant text:", lastAssistantText ?? "(none)");

  if (lastAssistantText) {
    const cleaned = lastAssistantText
      .replace(/^```json\s*/, "")
      .replace(/\s*```$/, "")
      .trim();
    try {
      const parsed = JSON.parse(cleaned);
      console.log("Parsed JSON:", JSON.stringify(parsed, null, 2));
      console.log("SUCCESS");
    } catch (e) {
      console.log("JSON parse FAILED:", e);
      process.exitCode = 1;
    }
  } else {
    console.log("FAIL - no assistant text");
    process.exitCode = 1;
  }
});
