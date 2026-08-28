#!/usr/bin/env bun
// Deletes files the template retired from the target's working tree.
// Invoked from the repo-platform checkout root by reusable-template-sync.yml's
// "Remove files the template retired" step and by ci/upgrade_path_test.sh;
// deletion candidates come from retired_paths.ts (see its header for the
// safety rules), diffing the clean renders clean_renders.ts materialized
// (ensureRenders is idempotent, so callers that never ran the materialize
// step - rehearse.ts, older harness legs - still work; they just pay for
// the renders here).
//
// Env: RUNNER_TEMP, MODULES; TARGET_DIR (default target); plus, when the
// renders are not already materialized, ensureRenders' inputs (OLD_SHA,
// TARGET_REF, PRIVATE, DESCRIPTION, SRC_PATH).

import { appendFileSync, existsSync, lstatSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { env, fail, requireEnv } from "../shared/gha.ts";
import { parseJson } from "../shared/json.ts";
import { parseModules } from "../shared/modules.ts";
import { capture } from "../shared/proc.ts";
import { ensureRenders, run } from "./clean_renders.ts";
import { customLicenseFlipError } from "./retired_paths.ts";

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

const runnerTemp = requireEnv("RUNNER_TEMP");
const targetDir = env("TARGET_DIR", "target");

const { renderOld, renderNew, answersOldText } = ensureRenders();

// Dropping the custom-license module leaves the repo's own license file
// behind (see customLicenseFlipError); the guard needs the pre-update
// module answer, so an unparseable answers file falls through to
// render_data.ts's canonical error inside ensureRenders (or, on the
// already-materialized path, to the fallthrough below).
const newModules = parseModules(requireEnv("MODULES"));
if (newModules === null) {
  fail("MODULES must be a JSON list of strings");
}
let answersOld: unknown;
try {
  answersOld = parse(answersOldText);
} catch {
  answersOld = undefined;
}
const recordedModules = (answersOld as Record<string, unknown> | null | undefined)?.modules;
if (recordedModules !== undefined && !isStringList(recordedModules)) {
  fail(
    "HEAD:.copier-answers.yml records a malformed modules list; cannot check the custom-license flip",
  );
}
const oldModules = isStringList(recordedModules) ? recordedModules : [];
const presentLicenses = ["LICENSE", "LICENSE.md"].filter((name) => {
  const probe = capture(["git", "-C", targetDir, "cat-file", "-e", `HEAD:${name}`]);
  // A deadline expiry must fail this step, not read as "license absent":
  // absent is what lets the custom-license flip guard stand down.
  if (probe.timedOut) {
    fail(`git cat-file timed out probing HEAD:${name}`);
  }
  return probe.exitCode === 0;
});
const flipError = customLicenseFlipError(oldModules, newModules, presentLicenses);
if (flipError !== null) {
  fail(flipError);
}

const retiredJson = run(
  [
    "bun",
    ".github/scripts/sync/retired_paths.ts",
    "--old-render",
    renderOld,
    "--new-render",
    renderNew,
    "--old-copier",
    join(runnerTemp, "copier-old.yml"),
    "--new-copier",
    join(runnerTemp, "copier-new.yml"),
    "--modules",
    requireEnv("MODULES"),
  ],
  { stdout: "pipe" },
);
// The file copy is for debugging only; the captured stdout is the input.
writeFileSync(join(runnerTemp, "retired-paths.json"), retiredJson);

// parseJson, not a raw JSON.parse: a SyntaxError's message quotes the
// payload (target-derived paths) into the public sync log.
const retired = parseJson(retiredJson, "retired_cleanup: retired_paths.ts output");
if (!isStringList(retired)) {
  fail("retired_paths.ts printed something other than a JSON list of paths");
}
writeFileSync(join(runnerTemp, "removed-paths.txt"), "");
for (const path of retired) {
  const absolute = join(targetDir, path);
  // lstat catches dangling symlinks that existsSync (which follows links)
  // would miss.
  const present =
    existsSync(absolute) ||
    (() => {
      try {
        lstatSync(absolute);
        return true;
      } catch {
        return false;
      }
    })();
  if (present) {
    rmSync(absolute, { force: true });
    appendFileSync(join(runnerTemp, "removed-paths.txt"), `${path}\n`);
    console.log(`removed retired file: ${path}`);
  }
}
