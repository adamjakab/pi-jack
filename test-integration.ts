/**
 * Integration test: simulate the exact args the tool uses
 */
import { spawn } from "node:child_process";

const args = [
  "--mode", "json",
  "-p",
  "--no-session",
  "--exclude-tools", "subagent_runner",
  "list the files in /home/jackisback/WslCode/Pi/myPi",
];

console.log("Spawning:", "pi", args.join(" "));

const proc = spawn("pi", args, {
  cwd: "/home/jackisback/WslCode/Pi/myPi",
  shell: false,
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";

proc.stdout.on("data", (d) => { stdout += d.toString(); });
proc.stderr.on("data", (d) => { stderr += d.toString(); });

proc.on("close", (code) => {
  console.log("Exit code:", code);
  console.log("Stderr:", stderr || "(none)");

  const lines = stdout.trim().split("\n");
  let assistantTurns = 0;
  let toolCalls = 0;
  let lastText: string | null = null;

  for (const line of lines) {
    try {
      const ev = JSON.parse(line);
      if (ev.type === "message_end" && ev.message?.role === "assistant") {
        assistantTurns++;
        const text = ev.message.content?.find((c: any) => c.type === "text")?.text;
        if (text) lastText = text;
      }
      if (ev.type === "tool_execution_start") toolCalls++;
    } catch { /* ignore */ }
  }

  console.log("\nAssistant turns:", assistantTurns);
  console.log("Tool calls:", toolCalls);
  console.log("Last text:", lastText?.slice(0, 200) ?? "(none)");

  if (code === 0 && assistantTurns > 0) {
    console.log("\n✅ SUCCESS — subprocess completes without recursion");
  } else {
    console.log("\n❌ FAIL");
    process.exitCode = 1;
  }
});
