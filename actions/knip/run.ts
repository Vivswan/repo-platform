#!/usr/bin/env bun
// knip globs a repository's own configured `entry` with git's excludes off (an entry a repository names is analyzed
// however git hides it), so the platform checkout fleet-ci.yml leaves in the workspace was analyzed as the caller's
// code once a configured pattern (a `**/*.test.ts` entry) reached it; knip's project and plugin globs honor the
// `.git/info/exclude` line the workflow writes. A negated pattern (`!<dir>/**`) is how knip itself keeps an ignored
// workspace out of an entry or project glob, and its configuration hints skip negated patterns, so the written
// configuration is the repository's own with the checkout negated in the root workspace's configured `entry` and
// `project` lists. `ignore` would only drop findings while the files were still analyzed; `ignoreWorkspaces` keeps
// the files out but draws a hint ("Remove from ignoreWorkspaces": the checkout holds a package.json and is no
// workspace), and a hint fails the run.
//
// knip's own loader resolves the repository's configuration: its search order, its jsonc and TypeScript loading, its
// layering over package.json's `knip` key, and its schema. Every form knip accepts is covered by knip's code, and what
// knip refuses is refused before the run.
//
// knip makes its configuration file an entry (its graph builder adds `configFilePath`), and analyzes a file only inside
// a workspace. So the written configuration is a module beside this script, inside the caller's workspace, importing
// a knip.ts or knip.js as the repository wrote it: that file and what it imports stay referenced, and a RegExp, a
// compiler function, and the run's arguments reach it as they would through knip alone.

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
const MODULE_NAME = "knip.config.js";

type Config = Awaited<ReturnType<typeof createOptions>>["parsedConfig"];

export interface Effective {
  /** knip's resolved repository root; the written module sits inside it or knip never analyzes it. */
  cwd: string;
  /** What the module binds as the repository's configuration: the knip.ts or knip.js knip found, or knip's resolution
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

/** `await (own.default ?? own)` is how knip's loader reads a configuration module (a promise resolves, a function is
 *  called), and `export *` keeps the file's own exports out of the report, as knip's `skipExportsAnalysis` does for its
 *  configuration file. The checkout's negation joins the `entry` and `project` lists the configuration yields under
 *  knip's own runtime, else package.json's, layered by knip's own expression (`Object.assign({}, manifest.knip, file)`):
 *  a function deciding by runtime is read where knip reads it, and nothing resolved here rides into the run. knip
 *  reads the root workspace's lists under `workspaces["."]` when that key exists, else at the top level, and a list
 *  the repository never configured stays knip's default (a negation alone is an empty glob). The module heals nothing:
 *  a configuration that is no object, or a list that is neither a list nor a string, is left as it came, for knip to
 *  refuse. */
export function knipModule(effective: Effective, dir: string): string {
  const inside = relative(effective.cwd, dir);
  if (inside.startsWith("..") || isAbsolute(inside)) {
    throw new Error(`${dir} is outside ${effective.cwd}, where knip analyzes files`);
  }
  const own =
    effective.own.kind === "code"
      ? [
          `import * as own from ${JSON.stringify(effective.own.path)};`,
          `export * from ${JSON.stringify(effective.own.path)};`,
        ]
      : [`const own = ${JSON.stringify(effective.own.config, null, 2)};`];
  const path = join(dir, MODULE_NAME);
  writeFileSync(
    path,
    [
      ...own,
      `import manifest from ${JSON.stringify(join(effective.cwd, "package.json"))};`,
      `const negation = ${JSON.stringify(`!${PLATFORM_CHECKOUT_DIR}/**`)};`,
      'const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);',
      "const negated = (patterns) =>",
      "  Array.isArray(patterns) ? [...new Set([...patterns, negation])]",
      '  : typeof patterns === "string" ? [patterns, negation]',
      "  : patterns;",
      "const withNegation = (config) =>",
      "  !isObject(config) ? config : {",
      "    ...config,",
      '    ...("entry" in config ? { entry: negated(config.entry) } : {}),',
      '    ...("project" in config ? { project: negated(config.project) } : {}),',
      "  };",
      "export default async (args) => {",
      "  const config = await (own.default ?? own);",
      '  const resolved = typeof config === "function" ? await config(args) : config;',
      "  if (!isObject(resolved)) return resolved;",
      "  const layered = Object.assign({}, manifest.knip, resolved);",
      '  return isObject(layered.workspaces) && "." in layered.workspaces',
      '    ? { ...layered, workspaces: { ...layered.workspaces, ".": withNegation(layered.workspaces["."]) } }',
      "    : withNegation(layered);",
      "};",
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
