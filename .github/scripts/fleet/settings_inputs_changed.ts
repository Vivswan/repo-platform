#!/usr/bin/env bun
// post-green.yml's settings-inputs leg: did a settings input (SETTINGS_INPUT_PATHS, the one
// authority docs/settings.md points at) change between the diff base and SOURCE_SHA? The base
// is judged_range.ts's: the newest earlier build stamp, BEFORE_SHA only as the first-publish fallback.

import { fail, notice, setOutput } from "../shared/gha.ts";
import { mustCapture } from "../shared/proc.ts";
import { type DiffBase, judgedRangeEnv, rangeLabel, resolveBase } from "./judged_range.ts";

/** Every input the apply reads: the fleet settings layers, the writer
 *  workflow and the post-green legs that call it, the selection and merge
 *  scripts with their whole import closure (the test pins the closure
 *  against this list), the module manifests and layers, and the fleet
 *  registry. Not the runtime (.bun-version, the lockfile): an apply per
 *  dependency bump is churn, and the nightly heal covers a bump that
 *  changed a document. GitHub filter-pattern grammar: `*` stays inside
 *  one path segment, `**` crosses them. */
export const SETTINGS_INPUT_PATHS: readonly string[] = [
  ".github/settings.yml",
  ".github/settings-baseline.yml",
  ".github/settings-public.yml",
  ".github/settings-private.yml",
  ".github/settings-override.yml",
  ".github/workflows/post-green.yml",
  ".github/workflows/settings-repos.yml",
  ".github/scripts/fleet/**",
  ".github/scripts/shared/**",
  ".github/scripts/sync/answers_file.ts",
  ".github/scripts/sync/checkout_path.ts",
  ".github/scripts/sync/failure_issue.ts",
  ".github/scripts/sync/modules.ts",
  ".github/scripts/sync/run_hidden.ts",
  "actions/shared/grammar.ts",
  "scripts/lib/jinja_subset.ts",
  "scripts/lib/module_manifests.ts",
  "scripts/ownership.ts",
  "scripts/generate/render_dogfood.ts",
  ".repo-platform-answers.yml",
  "repos.yml",
  "templates/*/module.yml",
  "templates/*/settings.yml",
  "templates/*/settings-public.yml",
  "templates/*/settings-private.yml",
];

const matchers = SETTINGS_INPUT_PATHS.map((pattern) => new Bun.Glob(pattern));

/** The changed paths that are settings inputs, in diff order. */
export function settingsInputsTouched(changedPaths: readonly string[]): string[] {
  return changedPaths.filter((path) => matchers.some((glob) => glob.match(path)));
}

/** The paths changed from `base` to `sha`, renames unfolded. */
export function changedPaths(cwd: string, sha: string, base: DiffBase): string[] {
  return mustCapture(["git", "-C", cwd, "diff", "--name-only", "--no-renames", base.base, sha])
    .split("\n")
    .filter((line) => line !== "");
}

function main(): void {
  const { sha, before } = judgedRangeEnv();
  let base: DiffBase;
  try {
    base = resolveBase(process.cwd(), sha, before);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const touched = settingsInputsTouched(changedPaths(process.cwd(), sha, base));
  if (base.kind !== "build-stamp") {
    notice(
      `no build stamp older than ${sha.slice(0, 12)} exists (nothing published before this run); diffing the push alone, from ${base.kind === "empty-tree" ? "the empty tree" : before.slice(0, 12)}`,
    );
  }
  setOutput("changed", String(touched.length > 0));
  const range = rangeLabel(sha, base);
  notice(
    touched.length === 0
      ? `${range} touched no settings input; the fleet's settings stand as they are`
      : `${range} touched settings inputs (${touched.join(", ")}): applying fleet-wide`,
  );
}

if (import.meta.main) {
  main();
}
