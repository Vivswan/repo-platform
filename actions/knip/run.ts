#!/usr/bin/env bun
// knip's default and plugin globs honor git's excludes; a repository's own configured entry pattern (a `**/*.test.ts`
// entry) honors neither `.git/info/exclude` nor a `.gitignore` line, so the platform checkout fleet-ci.yml leaves in
// the workspace was analyzed as the caller's code. `ignoreWorkspaces` is the key knip negates in every entry and
// project glob, so the written configuration is the repository's own with the checkout under that key. `ignore`
// would only drop findings while the files were still analyzed.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { error, requireEnv, run, warning } from "../shared/action_runtime.ts";
import { PLATFORM_CHECKOUT_DIR } from "../shared/platform.ts";

/** knip's own search order; the first found is layered over package.json's `knip` key, as knip layers them. */
const CONFIG_FILES = [
  "knip.json",
  "knip.jsonc",
  ".knip.json",
  ".knip.jsonc",
  "knip.ts",
  "knip.js",
  "knip.config.ts",
  "knip.config.js",
];
/** Configuration hints stay with the repository's own knip run: the written configuration carries a key knip would
 *  hint about ("Remove from ignoreWorkspaces", since the checkout holds a package.json), and a repository's
 *  `treatConfigHintsAsErrors` would make that hint a failure. */
const KNIP_FLAGS = ["--no-config-hints"];
/** Well inside fleet-ci.yml's job timeout; the fleet's knip runs take seconds. */
const KNIP_DEADLINE_MS = 10 * 60_000;

type Config = Record<string, unknown>;

export type Effective =
  /** The repository's configuration with the checkout ignored; `source` names what it was read from. */
  | { kind: "merged"; source: string; config: Config }
  /** A knip.ts or knip.js is a program; knip runs it as the repository wrote it, and the checkout stays visible. */
  | { kind: "code"; source: string };

/** Refuses what knip refuses (a document that is no object), naming the repository's file rather than the written one. */
function readConfig(cwd: string, source: string): Config {
  const value: unknown = Bun.JSONC.parse(readFileSync(join(cwd, source), "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${source} is not a knip configuration object`);
  }
  return value as Config;
}

export function effectiveConfig(cwd: string): Effective {
  const source = CONFIG_FILES.find((name) => existsSync(join(cwd, name)));
  if (source !== undefined && /\.[jt]s$/.test(source)) return { kind: "code", source };
  const manifest = readConfig(cwd, "package.json");
  const own: Config = {
    ...((manifest.knip as Config | undefined) ?? {}),
    ...(source === undefined ? {} : readConfig(cwd, source)),
  };
  // An absent key is an empty list; anything but a list (null, a string) is left for knip's schema to refuse.
  const ignored = own.ignoreWorkspaces === undefined ? [] : own.ignoreWorkspaces;
  const config = Array.isArray(ignored)
    ? { ...own, ignoreWorkspaces: [...new Set([...ignored, PLATFORM_CHECKOUT_DIR])] }
    : own;
  return { kind: "merged", source: source ?? "package.json", config };
}

/** The arguments after `knip`; a merged configuration is written to `tempDir` first. */
export function knipArguments(effective: Effective, tempDir: string): string[] {
  if (effective.kind === "code") return KNIP_FLAGS;
  const path = join(tempDir, "knip.json");
  writeFileSync(path, JSON.stringify(effective.config, null, 2));
  return [...KNIP_FLAGS, "--config", path];
}

if (import.meta.main) {
  const version = requireEnv("KNIP_VERSION");
  const effective = effectiveConfig(process.cwd());
  if (effective.kind === "code") {
    warning(
      `${effective.source} is a program, so this run cannot add ${PLATFORM_CHECKOUT_DIR} to its ignoreWorkspaces: knip reads the platform checkout`,
    );
  }
  const exit = run(
    ["npx", "--yes", `knip@${version}`, ...knipArguments(effective, requireEnv("RUNNER_TEMP"))],
    { timeoutMs: KNIP_DEADLINE_MS },
  );
  if (exit.kind !== "exited") {
    error(`knip ${exit.kind === "timed-out" ? "timed out" : `died on ${exit.signal}`}`);
    process.exit(1);
  }
  process.exit(exit.code);
}
