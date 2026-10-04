/**
 * Vitest config. Pi's packages (`@earendil-works/pi-*`, `typebox`) are provided by Pi at runtime and are not
 * installed here, so they are aliased to the installed Pi release: `$PI_MODULES` if set, else the version named in
 * ~/.pi/agent/install/current-version.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

function piModules(): string {
  if (process.env.PI_MODULES) return process.env.PI_MODULES;
  const install = join(homedir(), ".pi", "agent", "install");
  const version = readFileSync(
    join(install, "current-version"),
    "utf-8",
  ).trim();
  return join(install, "releases", version, "node_modules");
}

const PI_MODULES = piModules();

export default defineConfig({
  resolve: {
    alias: [
      // Subpath exports aren't followed through an absolute path, so they point at the built file.
      {
        find: /^typebox\/value$/,
        replacement: `${PI_MODULES}/typebox/build/value/index.mjs`,
      },
      {
        find: /^(@earendil-works\/[^/]+|typebox)$/,
        replacement: `${PI_MODULES}/$1`,
      },
    ],
  },
  test: {
    include: ["tests/unit/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      reporter: ["text", "html"],
    },
  },
});
