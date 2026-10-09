# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.7] - 2026-10-09

### Fixed

- A turn that ended in a provider error or an abort is no longer nudged to call `jack_subagent_result`. The model did
  not forget to answer; the request failed, and each nudge sent the whole context again to a provider that had just
  refused it, up to `MAX_FORMAT_RETRIES` more times.
- When a `--tools` list leaves `jack_subagent_fail` out, the run is no longer told to call it: the result tool's
  guidance and the nudge mention it only when the run can actually call it.

## [1.0.6] - 2026-10-06

### Fixed

- The package manifest declares the `prompts/` directory again through `pi.prompts`, so Pi registers the bundled prompt
  templates and users can filter them off in settings.

## [1.0.5] - 2026-10-05

### Changed

- The `pi.prompts` entry is gone from the package manifest; Pi finds the `prompts/` directory by convention.

## [1.0.4] - 2026-10-04

### Changed

- The extension's source files moved into `src/`, and the package's `main`, `exports` and `pi.extensions` point at
  `src/index.ts`. Pi picks up the new location by itself; nothing changes for an installed package.

## [1.0.3] - 2026-10-04

### Changed

- Refreshed the preview image for the [Pi package gallery](https://pi.dev/packages), set through `pi.image`.

## [1.0.2] - 2026-10-04

### Added

- A preview image for the [Pi package gallery](https://pi.dev/packages), set through `pi.image`.

## [1.0.1] - 2026-10-04

### Changed

- Releases are published from GitHub Actions through npm trusted publishing, so each version on npm carries a
  provenance attestation linking it to the commit and workflow that built it.

## [1.0.0] - 2026-10-04

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
