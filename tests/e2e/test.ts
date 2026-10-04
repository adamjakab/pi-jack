/**
 * Quick test: spawn a pi subprocess and verify it completes
 */
import { spawn } from "node:child_process";

const args = [
  "--mode",
  "json",
  "-p",
  "--no-session",
  "--exclude-tools",
  "jack",
  "say hello",
];

const proc = spawn("pi", args, {
  cwd: process.cwd(),
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

  // Find the last assistant message
  const lines = stdout.trim().split("\n");
  let lastMsg: any = null;
  for (const line of lines) {
    try {
      const ev = JSON.parse(line);
      if (ev.type === "message_end" && ev.message?.role === "assistant") {
        lastMsg = ev.message;
      }
    } catch {
      /* ignore */
    }
  }

  if (lastMsg) {
    const text =
      lastMsg.content?.find((c: any) => c.type === "text")?.text ?? "(no text)";
    console.log("Assistant said:", text);
    console.log("SUCCESS");
  } else {
    console.log("No assistant message found");
    console.log("FAIL");
    process.exitCode = 1;
  }
});
