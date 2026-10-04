/**
 * Runs the end-to-end suite.
 *
 *   npm run test:e2e                           # everything
 *   npm run test:e2e -- smoke                  # only cases whose suite or case name contains "smoke"
 *   npm run test:e2e -- jack-tool/parallel     # one case
 *   npm run test:e2e -- parallel               # or just part of a case name
 *   E2E_TIMEOUT_MS=120000 npm run test:e2e     # slower machine or model
 *
 * Every case drives a real `pi` and a real model, so this costs tokens and minutes. Suites run concurrently and the
 * cases within a suite run concurrently, which is what makes the wall-clock time bearable; the whole run exits
 * non-zero if any case failed.
 */

import directSubagent from "./cases/direct-subagent.ts";
import jackTool from "./cases/jack-tool.ts";
import smoke from "./cases/smoke.ts";
import type { Case } from "./harness.ts";

interface Suite {
  /** Short, stable slug used to select cases: `jack-tool/parallel batch`. */
  name: string;
  cases: Record<string, Case>;
  cleanup?: () => void;
}

/** Every suite in the run. A single case is just a suite with one entry. */
const SUITES: Suite[] = [smoke, directSubagent, jackTool];

interface Entry {
  id: string;
  run: Case;
}

/**
 * Flattens the suites into the individual cases selected by the command line. A filter matches when it appears
 * anywhere in `suite/case` or in the case name on its own, so both `jack-tool/parallel` and `parallel` work.
 */
function select(filters: string[]): Entry[] {
  const entries: Entry[] = [];
  for (const suite of SUITES) {
    for (const [name, run] of Object.entries(suite.cases)) {
      const id = `${suite.name}/${name}`;
      const matches =
        filters.length === 0 ||
        filters.some((filter) => id.includes(filter) || name.includes(filter));
      if (matches) entries.push({ id, run });
    }
  }
  return entries;
}

const filters = process.argv.slice(2);
const entries = select(filters);

if (entries.length === 0) {
  console.error(`No end-to-end case matches ${filters.join(", ")}.`);
  console.error(
    `Available:\n${SUITES.flatMap((s) => Object.keys(s.cases).map((n) => `  ${s.name}/${n}`)).join("\n")}`,
  );
  process.exit(1);
}

console.log(
  `Running ${entries.length} end-to-end case(s):\n${entries.map((e) => `  - ${e.id}`).join("\n")}\n`,
);

const started = Date.now();
const outcomes = await Promise.all(
  entries.map(async (entry) => {
    const at = Date.now();
    try {
      return {
        id: entry.id,
        failures: await entry.run(),
        secs: (Date.now() - at) / 1000,
      };
    } catch (error) {
      // A harness bug or an unexpected shape, not a failed expectation.
      return {
        id: entry.id,
        failures: [
          `threw: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
        ],
        secs: (Date.now() - at) / 1000,
      };
    }
  }),
);

for (const suite of SUITES) suite.cleanup?.();

const failed = outcomes.filter((outcome) => outcome.failures.length > 0);
for (const { id, failures, secs } of outcomes) {
  console.log(
    `${failures.length === 0 ? "✅" : "❌"} ${id} (${secs.toFixed(1)}s)`,
  );
  for (const failure of failures) console.log(`     - ${failure}`);
}

const total = (Date.now() - started) / 1000;
console.log(
  `\n${outcomes.length - failed.length}/${outcomes.length} passed in ${total.toFixed(1)}s`,
);
if (failed.length > 0) process.exitCode = 1;
