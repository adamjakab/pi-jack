/**
 * Test direct-mode subagent (no agent file, no system prompt)
 * mimicking what the tool does in the execute() path.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// The repository root, used as a sample folder to survey.
const ROOT = fileURLToPath(new URL("..", import.meta.url));

const args = [
  "--mode",
  "json",
  "-p",
  "--no-session",
  "--exclude-tools",
  "jack",
  `count the number of .md files in ${ROOT}`,
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
  let toolCalls = 0;

  for (const line of lines) {
    try {
      const ev = JSON.parse(line);
      if (ev.type === "message_end" && ev.message?.role === "assistant") {
        const text = ev.message.content?.find(
          (c: any) => c.type === "text",
        )?.text;
        if (text) lastAssistantText = text;
      }
      if (ev.type === "tool_execution_start") toolCalls++;
    } catch {
      /* ignore */
    }
  }

  console.log("\nLast assistant text:", lastAssistantText ?? "(none)");
  console.log("Tool calls made:", toolCalls);

  if (code === 0 && lastAssistantText) {
    console.log("SUCCESS");
  } else {
    console.log("FAIL");
    process.exitCode = 1;
  }
});
