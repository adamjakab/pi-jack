---
description: Demo of subagent_runner, four read-only subagents surveying a folder in parallel
argument-hint: "[path]"
---

# Subagents Demo

Demonstrate the `subagent_runner` tool by surveying ${1:-the current folder} with multiple tasks ran by independent agents.

Call `subagent_runner` exactly **once**, with these parameters and nothing else:

- run_mode: `parallel`
- `schema`: this JSON Schema, as an object:

  ```json
  {
    "type": "object",
    "properties": {
      "topic": {
        "type": "string",
        "description": "The topic name from the square brackets in your task, e.g. LAYOUT."
      },
      "findings": {
        "type": "array",
        "items": { "type": "string" },
        "description": "What you found, one self-contained item per entry."
      },
      "summary": {
        "type": "string",
        "description": "One or two sentences summing up the findings."
      }
    },
    "required": ["topic", "findings", "summary"],
    "additionalProperties": false
  }
  ```

- `tasks` (topic names are in the square brackets):
  - [LAYOUT] Layout of ${1:-the current folder}: list its top-level entries and say in a few words what each one is for.
  - [FTYPE] File types in ${1:-the current folder}: count files per extension, ignoring .git and node_modules, and report the five most common.
  - [NOTES] Open notes in ${1:-the current folder}: find TODO, FIXME and HACK comments, ignoring .git and node_modules, and report up to ten as "file:line: text".
  - [DOCS] Docs in ${1:-the current folder}: read its README.md or AGENTS.md (whichever exists, top level only) and summarize what the project is in three findings.

Do not do any of this work yourself, before or after the call: the point is to watch the subagents do it.

When the call returns, report:

1. A table with one row per task: task number, topic, and ✓ or ✗.
2. Each subagent's `summary` and `findings`, under its topic as a heading.
3. For any failed task, its `error`.
