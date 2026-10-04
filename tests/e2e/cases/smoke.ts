/**
 * Cheapest possible end-to-end check: `pi` is installed, on PATH, and a model answers.
 *
 * Everything else in this suite assumes those three things, so when a run fails wholesale, run this case first to
 * tell an environment problem apart from a JACK problem.
 */

import {
  check,
  checkProcess,
  describeRun,
  lastAssistantText,
  runPi,
} from "../harness.ts";

const smoke = {
  name: "smoke",
  cases: {
    "answers a plain prompt": async () => {
      const failures: string[] = [];
      const run = await runPi([
        "--mode",
        "json",
        "-p",
        "--no-session",
        "Reply with the single word: hello",
      ]);

      checkProcess(failures, run);

      const text = lastAssistantText(run);
      check(failures, !!text, `no assistant text\n  ${describeRun(run)}`);
      check(
        failures,
        /hello/i.test(text ?? ""),
        `unexpected answer: ${JSON.stringify(text)}`,
      );
      return failures;
    },
  },
};

export default smoke;
