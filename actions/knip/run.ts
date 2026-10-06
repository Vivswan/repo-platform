#!/usr/bin/env bun
// knip's default and plugin globs honor git's excludes; a repository's own configured entry pattern (a `**/*.test.ts`
// entry) honors neither `.git/info/exclude` nor a `.gitignore` line, so the platform checkout fleet-ci.yml leaves in
// the workspace was analyzed as the caller's code. `ignoreWorkspaces` is the key knip negates in every entry and
// project glob, so the written configuration is the repository's own with the checkout under that key. `ignore`
// would only drop findings while the files were still analyzed.
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

/** Configuration hints stay with the repository's own knip run: the written configuration carries a key knip would
 *  hint about ("Remove from ignoreWorkspaces", since the checkout holds a package.json), and a repository's
 *  `treatConfigHintsAsErrors` would make that hint a failure. One spelling of the run's arguments: knip's loader hands
 *  this object to a configuration function, and its CLI parses the flags. */
const KNIP_ARGS = { "no-config-hints": true } as const;
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
 *  configuration file. The checkout joins the list the configuration yields under knip's own runtime, else
 *  package.json's, layered by knip's own expression (`Object.assign({}, manifest.knip, file)`): a function deciding by
 *  runtime is read where knip reads it, and nothing resolved here rides into the run. The module heals nothing: a
 *  configuration that is no object, or a list that is no list, is left as it came, for knip to refuse. */
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
  const checkout = JSON.stringify(PLATFORM_CHECKOUT_DIR);
  const path = join(dir, MODULE_NAME);
  writeFileSync(
    path,
    [
      ...own,
      `import manifest from ${JSON.stringify(join(effective.cwd, "package.json"))};`,
      "export default async (args) => {",
      "  const config = await (own.default ?? own);",
      '  const resolved = typeof config === "function" ? await config(args) : config;',
      '  if (typeof resolved !== "object" || resolved === null || Array.isArray(resolved)) return resolved;',
      "  const layered = Object.assign({}, manifest.knip, resolved).ignoreWorkspaces;",
      "  return {",
      "    ...resolved,",
      "    ignoreWorkspaces:",
      `      layered === undefined ? [${checkout}]`,
      `      : Array.isArray(layered) ? [...new Set([...layered, ${checkout}])]`,
      "      : layered,",
      "  };",
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
