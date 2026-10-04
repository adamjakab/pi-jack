# AGENTS.md

Guidance for agents working on this repository: JACK (JSON Agent Contractor Kit), a Pi extension. The README
describes what it does for users.

## Layout

| Path             | What it holds                                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`       | Entry point: the `jack` tool. It resolves each task's agent and schema, spawns child `pi` processes, reads their JSON events. |
| `json-schema.ts` | The `--json-schema` flag and the `jack_subagent_result` / `jack_subagent_fail` tools it registers.                            |
| `contract.ts`    | Shared between both sides: tool and flag names, the default schema, schema loading and checking, validation, thinking levels. |
| `agents.ts`      | Agent discovery: built-in `agents/` plus the user's `~/.pi/agent/agents/`.                                                    |
| `agents/`        | Built-in agents. `worker` is the default.                                                                                     |
| `prompts/`       | Prompt templates, offered to Pi through the `resources_discover` event.                                                       |
| `scripts/`       | `pi-modules.mjs` resolves the installed Pi release and links it as `.pi-modules`, which `tsconfig.json` resolves against.     |
| `tests/unit/`    | Vitest unit tests (`*.test.ts`).                                                                                              |
| `tests/e2e/`     | End-to-end tests: `run.ts` is the runner, `harness.ts` the shared pi-spawning helpers, `cases/` the tests.                    |

How a child is started: the parent runs
`pi --mode json -p --no-session --exclude-tools jack --extension <index.ts> --json-schema <file> …`.

- **Loading the extension:** Pi loads an extension path only once, so `--extension` does nothing where Pi already
  discovers JACK by itself.
- **Reading the answer:** the parent takes it from the `tool_execution_end` events of the result tools.
- **Retry limit:** the parent stops the child after `MAX_FORMAT_RETRIES` rejected answers. Pi's own argument
  validation rejects some answers before the tool runs, and only the parent sees both kinds of rejection.

## Conventions

- **Runtime:** TypeScript, run directly by Pi, as ESM.
- **Pi's packages:** `@earendil-works/pi-*` and `typebox` are provided by Pi. They are listed as optional
  `peerDependencies` and are never installed here.
- **`tsconfig.json`:** resolves Pi's packages through the `.pi-modules` symlink, which `scripts/pi-modules.mjs`
  creates from `$PI_MODULES` or the installed release. Run `npm run typecheck`; it relinks first, so a Pi update needs no
  edit here.
- **Vitest:** finds the installed version by itself, or uses `$PI_MODULES` if set.
- **Formatting:** Prettier with default settings. Format the files you touch.
- **Prompts:** `prompts/*.md` is declared by the `pi.prompts` entry in `package.json`, not by a `resources_discover`
  handler, so users can filter prompts off in settings. Declaring both would load every template twice.

## Tooling

```bash
npm install            # dev tools only (Vitest, Prettier)
npm test               # unit tests
npm run test:e2e             # end-to-end tests; needs a working pi and model
npm run test:e2e -- smoke    # one case or suite: npm run test:e2e -- jack-tool/parallel
npm run format:check
npm run typecheck      # TypeScript, against the installed Pi release
```

## Releasing

Pushing a `v*` tag publishes to npm through `.github/workflows/release.yml`, which runs the checks first. Everything a
release needs is therefore committed before the tag, in three steps:

1. Move the `## [Unreleased]` section of `CHANGELOG.md` to `## [X.Y.Z] - YYYY-MM-DD`, write the entries for what
   changed, and leave an empty `## [Unreleased]` behind. Describe user-visible changes; skip internal refactors.
2. Set `version` in `package.json` to the same `X.Y.Z`.
3. Commit both, then tag and push: `git tag vX.Y.Z && git push && git push --tags`.

Checklist before tagging:

```bash
npm test && npm run format:check && npm run typecheck && npm pack --dry-run
```

`npm pack --dry-run` is the one that matters: it lists exactly what would be published. `CHANGELOG.md` has to stay in
the `files` array for this to include it. The tag must match `package.json`'s `version`, or npm refuses the publish.
A version can only be published once, so a mistake means a new patch version.
