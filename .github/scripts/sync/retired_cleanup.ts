#!/usr/bin/env bun
// Deletes files the template retired from the target's working tree and raises the new-starter
// hold (new_starters.ts), both read off the diff of the two clean renders (retired_paths.ts has
// the deletion rules; ensureRenders materializes on demand for callers that skipped the step).
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
import { newStarterHolds, newStartersReport } from "./new_starters.ts";
import { customLicenseFlipError } from "./retired_paths.ts";
import { NEW_STARTERS_REVIEW_NAME } from "./section_files.ts";

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/** Whether the target's HEAD carries `path`, via ls-tree (absent = exit 0 with no output), so a
 * timeout or any git failure fails the step instead of reading as absent, which stands the flip
 * guard down and clears a hold. `timeoutMs` is the tests' seam; production takes the default. */
export function presentAtHead(dir: string, path: string, timeoutMs?: number): boolean {
  const probe = capture(["git", "-C", dir, "ls-tree", "HEAD", "--", path], { timeoutMs });
  if (probe.timedOut) {
    fail(`git ls-tree timed out probing HEAD:${path}`);
  }
  if (probe.exitCode !== 0) {
    fail(`git ls-tree failed probing HEAD:${path} (exit ${probe.exitCode})`);
  }
  return probe.stdout.trim() !== "";
}

function main(): void {
  const runnerTemp = requireEnv("RUNNER_TEMP");
  const targetDir = env("TARGET_DIR", "target");

  const { renderOld, renderNew, answersOldText } = ensureRenders();

  // Dropping the custom-license module leaves the repo's own license file
  // behind (see customLicenseFlipError); the guard needs the pre-update
  // module answer, so an unparsable answers file falls through to
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
      "HEAD:.github/.copier-answers.yml records a malformed modules list; cannot check the custom-license flip",
    );
  }
  const oldModules = isStringList(recordedModules) ? recordedModules : [];
  const presentLicenses = ["LICENSE.md"].filter((name) => presentAtHead(targetDir, name));
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
      // Safe for the public log: the sync step runs this script under
      // run_hidden.ts (output captured for a hide-details target), and the
      // paths come from clean template renders, never the target's tree.
      console.log(`removed retired file: ${path}`);
    }
  }

  // The new-starter hold; the paths are the renders' own, so the log line is public-safe.
  const holds = newStarterHolds(renderOld, renderNew, (path) => presentAtHead(targetDir, path));
  writeFileSync(join(runnerTemp, NEW_STARTERS_REVIEW_NAME), newStartersReport(holds));
  for (const hold of holds) {
    console.log(
      `::warning::new starter ${hold.path} already exists in the repository; held for review`,
    );
  }
}

if (import.meta.main) main();
