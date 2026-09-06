#!/usr/bin/env bun
// Whether the settings inputs changed since the fleet last saw main -
// post-green.yml's settings-inputs leg, whose `changed` output decides if
// the fleet-wide settings apply follows the merge. The path list below is
// the one authority (docs/settings.md points here). The base is the build
// tip's stamped source, the last green main that completed post-green,
// so a push superseded in ci.yml's pending slot is still covered; the
// push payload's `before` serves only when no stamp exists yet
// (docs/all-green.md has the reasoning).
//
// Env: SOURCE_SHA (the judged commit), BEFORE_SHA (the push's previous
// tip, the fallback base), GITHUB_OUTPUT (changed). The checkout must
// carry full history and the build branch as refs/remotes/origin/build.

import { commitStampParseAll } from "../shared/commit_stamp.ts";
import { fail, notice, requireEnv, setOutput } from "../shared/gha.ts";
import { capture, mustCapture } from "../shared/proc.ts";

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
  "scripts/jinja_subset.ts",
  "scripts/module_manifests.ts",
  "scripts/ownership.ts",
  "scripts/render_dogfood.ts",
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

const FULL_SHA = /^[0-9a-f]{40}$/;
const BUILD_REF = "refs/remotes/origin/build";

/** A git yes/no question answers with exit 0 or 1; anything else (or a
 *  deadline expiry) is an errored look, never a verdict. */
function gitAnswersYes(cwd: string, args: string[]): boolean {
  const probe = capture(["git", "-C", cwd, ...args]);
  if (probe.timedOut || (probe.exitCode !== 0 && probe.exitCode !== 1)) {
    throw new Error(`git ${args[0]} could not answer (exit ${probe.exitCode}); refusing to guess`);
  }
  return probe.exitCode === 0;
}

export type DiffBase =
  | { kind: "build-stamp"; base: string }
  | { kind: "push-before"; base: string }
  | { kind: "empty-tree"; base: string };

/** The base the push is diffed from: the newest build stamp that is not
 *  `sha` itself (the tip may already be THIS run's publish), walking the
 *  whole build history so no bound can hide an older stamp. The push's
 *  `before` (the empty tree when all zeros - a branch-creating push) only
 *  when no build branch exists or its only stamp is `sha`, the first
 *  publish ever; a build branch with no stamp at all is refused. */
export function resolveBase(cwd: string, sha: string, before: string): DiffBase {
  if (gitAnswersYes(cwd, ["rev-parse", "--verify", "--quiet", `${BUILD_REF}^{commit}`])) {
    const stamps = commitStampParseAll(
      mustCapture(["git", "-C", cwd, "log", "--format=%B", BUILD_REF]),
    );
    if (stamps.length === 0) {
      throw new Error(
        "the build branch carries no stamped source in its whole history: publish.ts stamps every build commit, so this branch was not published by it - reset it (dispatch Build Branches) before the settings apply reads it",
      );
    }
    const base = stamps.find((stamped) => stamped !== sha);
    if (base !== undefined) return { kind: "build-stamp", base };
  }
  if (/^0+$/.test(before)) {
    return {
      kind: "empty-tree",
      base: mustCapture(["git", "-C", cwd, "hash-object", "-t", "tree", "/dev/null"]),
    };
  }
  return { kind: "push-before", base: before };
}

/** The paths changed from `base` to `sha`, renames unfolded, read from the
 *  checkout at `cwd`. A commit base must be present and a strict ancestor
 *  of `sha`; anything else would make the range mean something else. */
export function changedPaths(cwd: string, sha: string, base: DiffBase): string[] {
  if (base.kind !== "empty-tree") {
    const what = base.kind === "build-stamp" ? "the build tip's stamped source" : "the push base";
    if (!gitAnswersYes(cwd, ["rev-parse", "--verify", "--quiet", `${base.base}^{commit}`])) {
      throw new Error(
        `${what} ${base.base.slice(0, 12)} is not in this checkout: fetch the full history (actions/checkout fetch-depth: 0)`,
      );
    }
    // --is-ancestor is inclusive; an equal base is an empty range.
    if (base.base === sha) {
      throw new Error(
        `${what} ${base.base.slice(0, 12)} is the judged commit itself: an empty range says nothing about the push`,
      );
    }
    if (!gitAnswersYes(cwd, ["merge-base", "--is-ancestor", base.base, sha])) {
      throw new Error(
        `${what} ${base.base.slice(0, 12)} is not an ancestor of ${sha.slice(0, 12)}: the range means nothing (a force-push, a foreign payload, or a tampered build stamp) - the nightly heal covers the commit`,
      );
    }
  }
  return mustCapture(["git", "-C", cwd, "diff", "--name-only", "--no-renames", base.base, sha])
    .split("\n")
    .filter((line) => line !== "");
}

function main(): void {
  const sha = requireEnv("SOURCE_SHA");
  if (!FULL_SHA.test(sha)) fail(`SOURCE_SHA is not a full commit sha (got '${sha}')`);
  const before = requireEnv("BEFORE_SHA");
  if (!FULL_SHA.test(before)) fail(`BEFORE_SHA is not a full commit sha (got '${before}')`);
  let base: DiffBase;
  let touched: string[];
  try {
    base = resolveBase(process.cwd(), sha, before);
    touched = settingsInputsTouched(changedPaths(process.cwd(), sha, base));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (base.kind !== "build-stamp") {
    notice(
      `no build stamp older than ${sha.slice(0, 12)} exists (nothing published before this run); diffing the push alone, from ${base.kind === "empty-tree" ? "the empty tree" : before.slice(0, 12)}`,
    );
  }
  setOutput("changed", String(touched.length > 0));
  const range = `${base.base.slice(0, 12)}..${sha.slice(0, 12)}`;
  notice(
    touched.length === 0
      ? `${range} touched no settings input; the fleet's settings stand as they are`
      : `${range} touched settings inputs (${touched.join(", ")}): applying fleet-wide`,
  );
}

if (import.meta.main) {
  main();
}
