# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

## [1.0.0] - 2025-10-04

First release.

### Added

- The `jack` tool: delegates a task, or a batch of tasks, to subagents that are isolated `pi` subprocesses and must
  answer in a JSON Schema.
- Named agents, resolved from the built-in `agents/` directory and from `~/.pi/agent/agents/`; a user's agent of the
  same name replaces a built-in one. `worker` is the default, `tester` ships alongside it.
- Per-call overrides for the agent's prompt (`system_prompt`), tools, model, and thinking level.
- `run_mode: 'sequential' | 'parallel'` for batches, with live per-task progress and an optional `debug_mode` that
  reports how each subagent was set up and the exact `pi` command line it ran with.
- `--json-schema <file>`: makes any `pi` run finish with an answer conforming to a JSON Schema, through the
  `jack_subagent_result` / `jack_subagent_fail` tools. This is how every subagent is started, and it works standalone.
- A parent stops a child after `MAX_FORMAT_RETRIES` rejected answers, counting both Pi's own argument validation and
  the tool's re-check.
- The `/jack-demo` prompt template.
