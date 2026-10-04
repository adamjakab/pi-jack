# JACK: JSON Agent Contractor Kit

A [Pi](https://pi.dev) extension for getting structured answers from agents. It adds:

- **The `jack` tool.** The model delegates one task, or a batch run sequentially or in parallel, to subagents.
  Each subagent is an isolated `pi` process, and its answer conforms to a JSON Schema you choose.
- **The `--json-schema <schema>` flag.** It makes any `pi` run finish with an answer that conforms to a schema. The
  name matches Claude Code's flag for the same purpose.
- **The `/jack-demo [path]` prompt.** Four subagents survey a folder in parallel while you watch.

## Install

```bash
pi install npm:@adibacsi/pi-jack             # from npm
pi install git:github.com/adamjakab/pi-jack   # from GitHub
pi install /path/to/pi-jack                  # from a local checkout
```

You can also put the folder, or a symlink to it, in `~/.pi/agent/extensions/`.

## The `jack` tool

| Parameter                       | Meaning                                                                                                                                            |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `task`, or `tasks` + `run_mode` | One task, or a list run `sequential` (default) or `parallel`. Each item in `tasks` can override `agent`, `model`, `thinking` and the other fields. |
| `agent`                         | A named agent (see below). Leave it out to use the default `worker` agent.                                                                         |
| `schema`                        | The JSON Schema the answer must conform to: an object, inline JSON, or a path to a `.json` file.                                                   |
| `model`                         | The model, as for `pi --model`. Overrides the agent's model.                                                                                       |
| `thinking`                      | `off`, `low`, `medium`, `high`, `xhigh` or `max`. Overrides the agent's level.                                                                     |
| `system_prompt`, `tools`        | Only apply when no agent is named: extra system prompt and a tool list for the default agent.                                                      |
| `debug_mode`                    | Shows each subagent's resolved setup (agent, prompt, model, thinking, tools, schema, command line) and what it actually ran with.                  |

The tool returns each subagent's validated answer as `data`, plus `success`, `error`, `attempts`, token usage, and
`ranWith` (the model and thinking level the subagent actually used).

### Thinking levels

The level is passed to the subagent as `pi --thinking`. When the model doesn't support it, Pi uses the nearest
higher level the model does support, or else the nearest lower one. Some models can't switch thinking off at all,
so `off` runs at their lowest level.

## Agents

An agent is a Markdown file with YAML frontmatter. The body becomes the subagent's system prompt.

```markdown
---
name: reviewer
description: Reviews a diff and reports problems.
tools: read, grep, find, ls
model: openrouter/~anthropic/claude-haiku-latest
thinking: medium
schema: schemas/review.json
---

You review code changes...
```

`name` and `description` are required. `tools`, `model`, `thinking` and `schema` are optional. `schema` can be YAML,
inline JSON, or a path relative to the agent file.

- **Built-in agents** ship in this repo's `agents/` folder: `worker` (the default) and `tester`.
- **Your agents** go in `~/.pi/agent/agents/`. One with the same name as a built-in agent replaces it.
- **Broken files:** an agent file that fails to load is reported and skipped. A call that names it fails instead of
  quietly falling back to another agent.

## The output contract

Every subagent answers in a JSON Schema. JACK picks the call's `schema`, else the agent's `schema`, else a default
that asks for `success` (boolean) and `result` (string).

- **Shape:** the root must describe an object.
- **Descriptions:** each property's `description` is how the subagent learns what goes there, so write them carefully.
- **Checked first:** a schema is checked before any subagent starts. Unknown keywords, unknown type names and
  wrongly-shaped values (usually typos) are refused rather than silently ignored.

The answer is collected through `--json-schema`. That flag gives the run a `jack_subagent_result` tool whose
parameters are the schema, with provider-side constrained sampling where the provider supports it. It also adds a
`jack_subagent_fail` tool for giving up with a reason.

- **Invalid answers** are rejected with their errors, and the subagent fixes them in the same run.
- **Missing answers:** a subagent that stops without answering is reminded to answer.
- **Second check:** JACK validates the answer again in the parent. It stops a subagent after too many rejected answers.

### `--json-schema` without the tool

```bash
pi --mode json -p --json-schema ./schema.json "Summarize this repository"
pi --mode json -p --json-schema '{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"]}' "…"
```

The answer is `result.details` of the last successful `tool_execution_end` event for `jack_subagent_result`.

## License

[MIT](LICENSE)
