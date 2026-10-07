#!/usr/bin/env bun
// knip globs a repository's configured `entry` with git's excludes off (an entry a repository names is analyzed
// however git hides it), where its project and plugin globs honor the `.git/info/exclude` line fleet-ci.yml writes.
// So a configured pattern (a `**/*.test.ts` entry) reached the platform checkout the workflow leaves in the workspace,
// and the checkout's files were analyzed as the caller's code.
//
// The configuration knip runs is the repository's own with the checkout negated (`!<dir>/**`, the form knip itself
// adds to entry and project globs for an ignored workspace) in its configured `entry` and `project` lists; the rule is
// knip_layer.ts. knip's configuration hints skip a negated pattern. `ignore` would drop findings while the files were
// still analyzed, and `ignoreWorkspaces` draws a hint (the checkout holds a package.json and is no workspace); a hint
// fails the run.
//
// knip's own loader resolves the repository's configuration: its search order, its jsonc and TypeScript loading, its
// layering over package.json's `knip` key, and its schema. Every form knip accepts is covered by knip's code, and what
// knip refuses is refused before the run.
//
// knip makes its configuration file an entry (its graph builder adds `configFilePath`) and follows that file's imports
// only inside the repository: pointed at a module outside it, knip reports a repository's knip.ts and what it imports
// as unused files. So the configuration knip runs is a file of imports and exports written beside this script,
// inside the caller's workspace: it imports knip_layer.ts, the repository's own knip.ts or knip.js, and its
// package.json, and its default export is the layering of the three. A data configuration (a JSON file, package.json's
// knip key, nothing) has no file to keep referenced, so knip's resolution of it rides in that export as a literal.

import { rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createOptions } from "knip/session";
import { type ChildExit, error, run } from "../shared/action_runtime.ts";
import { PLATFORM_CHECKOUT_DIR } from "../shared/platform.ts";

/** A configuration hint fails the run: a stale `ignore*` entry or an unmatched pattern in the repository's own knip
 *  configuration is a finding, and the written configuration draws none of its own. One spelling of the run's
 *  arguments: knip's loader hands this object to a configuration function, and its CLI parses the flags. */
const KNIP_ARGS = { "treat-config-hints-as-errors": true } as const;
const KNIP_FLAGS = Object.keys(KNIP_ARGS).map((flag) => `--${flag}`);
/** Well inside fleet-ci.yml's job timeout; the fleet's knip runs take seconds. */
const KNIP_DEADLINE_MS = 10 * 60_000;
/** The action's own knip, the one whose loader read the configuration; node runs it, as `npx knip` would. */
export const KNIP_BIN = fileURLToPath(new URL("../bin/knip.js", import.meta.resolve("knip")));
/** knip's `isDefaultPattern`, the test its graph builder applies to a configured list; the written configuration
 *  imports it from the same knip, so the two agree on what a default pattern is (knip exports no path to it). */
export const KNIP_DEFAULT_PATTERNS = fileURLToPath(
  new URL("./ConfigurationChief.js", import.meta.resolve("knip")),
);
const LAYER = fileURLToPath(new URL("./knip_layer.ts", import.meta.url));
const NEGATION = `!${PLATFORM_CHECKOUT_DIR}/**`;
const MODULE_NAME = "knip.config.js";

type Config = Awaited<ReturnType<typeof createOptions>>["parsedConfig"];

export interface Effective {
  /** knip's resolved repository root; the written configuration sits inside it or knip follows no import of it. */
  cwd: string;
  /** What the configuration binds as the repository's own: the knip.ts or knip.js knip found, or knip's resolution
   *  of a data configuration (a JSON file, package.json's knip key, nothing). */
  own: { kind: "code"; path: string } | { kind: "data"; config: Config };
}

export async function effectiveConfig(cwd: string): Promise<Effective> {
  const { cwd: root, configFilePath, parsedConfig } = await createOptions({ cwd, args: KNIP_ARGS });
  return {
    cwd: root,
    own:
      configFilePath !== undefined && /\.[jt]s$/.test(configFilePath)
        ? { kind: "code", path: configFilePath }
        : { kind: "data", config: parsedConfig },
  };
}

/** Writes the configuration knip runs: imports and exports, no logic (knip_layer.ts holds that). `export *` keeps
 *  the repository's knip.ts exports out of the report, as knip's `skipExportsAnalysis` does for its configuration
 *  file's. The paths are absolute, so the file loads wherever knip's root is. */
export function knipModule(effective: Effective, dir: string): string {
  const inside = relative(effective.cwd, dir);
  if (inside.startsWith("..") || isAbsolute(inside)) {
    throw new Error(
      `${dir} is outside ${effective.cwd}, where knip follows the configuration's imports`,
    );
  }
  const own =
    effective.own.kind === "code"
      ? [
          `import * as own from ${JSON.stringify(effective.own.path)};`,
          `export * from ${JSON.stringify(effective.own.path)};`,
        ]
      : [];
  const ownArgument = effective.own.kind === "code" ? "own" : JSON.stringify(effective.own.config);
  const path = join(dir, MODULE_NAME);
  writeFileSync(
    path,
    [
      ...own,
      `import manifest from ${JSON.stringify(join(effective.cwd, "package.json"))};`,
      `import { isDefaultPattern } from ${JSON.stringify(KNIP_DEFAULT_PATTERNS)};`,
      `import { layer } from ${JSON.stringify(LAYER)};`,
      `export default layer(${ownArgument}, manifest, { negation: ${JSON.stringify(NEGATION)}, isDefaultPattern });`,
      "",
    ].join("\n"),
  );
  return path;
}

export function knipArguments(modulePath: string): string[] {
  return [...KNIP_FLAGS, "--config", modulePath];
}

if (import.meta.main) {
  const effective = await effectiveConfig(process.cwd()).catch((cause: unknown) => {
    error(cause instanceof Error ? cause.message : String(cause));
    process.exit(2);
  });
  const modulePath = knipModule(effective, import.meta.dir);
  let exit: ChildExit;
  try {
    exit = run(["node", KNIP_BIN, ...knipArguments(modulePath)], { timeoutMs: KNIP_DEADLINE_MS });
  } finally {
    rmSync(modulePath, { force: true });
  }
  if (exit.kind !== "exited") {
    error(`knip ${exit.kind === "timed-out" ? "timed out" : `died on ${exit.signal}`}`);
    process.exit(1);
  }
  process.exit(exit.code);
}
