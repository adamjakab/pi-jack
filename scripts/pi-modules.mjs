/**
 * Resolves the `node_modules` folder of the installed Pi release and exposes it to TypeScript.
 *
 * Pi's packages (`@earendil-works/pi-*`, `typebox`) are provided by Pi at runtime and are never installed here, so
 * `tsconfig.json` cannot resolve them by name. This script symlinks the release's `node_modules` to `.pi-modules` in
 * the repository root, which `tsconfig.json` then points its `paths` at. That keeps the checked-in `tsconfig.json`
 * static and version-independent: after a Pi update, re-running this script is enough.
 *
 * Resolution order: `$PI_MODULES`, else `~/.pi/agent/install/current-version`, else the newest release folder found
 * there. The resolved folder must contain `typebox` and `@earendil-works`.
 */

import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root: this script lives in `<root>/scripts`. */
export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Symlink in the repository root that `tsconfig.json` resolves Pi's packages through. */
export const LINK = join(ROOT, ".pi-modules");

/** Whether a folder looks like the `node_modules` of an installed Pi release. */
function isPiModules(folder) {
  return (
    existsSync(join(folder, "typebox")) &&
    existsSync(join(folder, "@earendil-works", "pi-coding-agent"))
  );
}

/** Newest release folder by version, used only when `current-version` is missing. */
function newestRelease(install) {
  const releases = join(install, "releases");
  if (!existsSync(releases)) return undefined;
  const versions = readdirSync(releases)
    .filter((name) => isPiModules(join(releases, name, "node_modules")))
    .sort((a, b) =>
      a === b ? 0 : a.localeCompare(b, undefined, { numeric: true }),
    );
  return versions.at(-1);
}

/** Absolute path of the `node_modules` folder of the installed Pi release. */
export function piModules() {
  if (process.env.PI_MODULES) return process.env.PI_MODULES;
  const install = join(homedir(), ".pi", "agent", "install");
  const pointer = join(install, "current-version");
  const version = existsSync(pointer)
    ? readFileSync(pointer, "utf-8").trim()
    : newestRelease(install);
  if (!version)
    throw new Error(
      `No Pi release found under ${install}. Set $PI_MODULES to point at one.`,
    );
  const modules = join(install, "releases", version, "node_modules");
  if (!isPiModules(modules)) {
    throw new Error(
      `${modules} does not look like a Pi release's node_modules. Set $PI_MODULES to point at one.`,
    );
  }
  return modules;
}

/** Points `.pi-modules` at the resolved folder, replacing a link that points somewhere else. */
export function linkPiModules() {
  const target = piModules();
  if (existsSync(LINK) || lstatSync(LINK, { throwIfNoEntry: false })) {
    rmSync(LINK, { recursive: true, force: true });
  }
  symlinkSync(target, LINK, "dir");
  return target;
}

if (import.meta.url === `file://${process.argv[1]}`)
  console.log(`Pi packages: ${linkPiModules()}`);
