#!/usr/bin/env bun
// Deletes files the template retired from the target's working tree.
// Invoked from the repo-platform checkout root by reusable-template-sync.yml's
// "Remove files the template retired" step and by ci/upgrade_path_test.sh;
// deletion candidates come from retired_paths.ts (see its header for the
// safety rules).
//
// Env: OLD_SHA, TARGET_REF, MODULES, CHANNEL, PRIVATE, DESCRIPTION,
// SRC_PATH, RUNNER_TEMP; TARGET_DIR (default target).

import { appendFileSync, existsSync, lstatSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { env, requireEnv } from "../shared/gha.ts";

const runnerTemp = requireEnv("RUNNER_TEMP");
const targetDir = env("TARGET_DIR", "target");

function run(command: string[], options: { stdout?: "pipe" } = {}): string {
  const proc = Bun.spawnSync(command, {
    stdio: ["inherit", options.stdout === "pipe" ? "pipe" : "inherit", "inherit"],
  });
  if (proc.exitCode !== 0) process.exit(proc.exitCode ?? 1);
  return options.stdout === "pipe" ? (proc.stdout?.toString() ?? "") : "";
}

// The old render uses the answers recorded BEFORE this update (HEAD still
// points at the pre-update commit); the new render applies the live
// module/channel/private/description data on top.
writeFileSync(
  join(runnerTemp, "answers-old.yml"),
  run(["git", "-C", targetDir, "show", "HEAD:.copier-answers.yml"], { stdout: "pipe" }),
);
run([
  "bun",
  ".github/scripts/sync/render_data.ts",
  "--answers-old",
  join(runnerTemp, "answers-old.yml"),
  "--out-old",
  join(runnerTemp, "data-old.yml"),
  "--out-new",
  join(runnerTemp, "data-new.yml"),
  "--modules",
  requireEnv("MODULES"),
  "--channel",
  requireEnv("CHANNEL"),
  "--private",
  requireEnv("PRIVATE"),
  "--description",
  env("DESCRIPTION"),
]);

const srcPath = requireEnv("SRC_PATH");
run([
  "copier",
  "copy",
  "--vcs-ref",
  requireEnv("OLD_SHA"),
  "--defaults",
  "--trust",
  "--data-file",
  join(runnerTemp, "data-old.yml"),
  srcPath,
  join(runnerTemp, "render-old"),
]);
run([
  "copier",
  "copy",
  "--vcs-ref",
  requireEnv("TARGET_REF"),
  "--defaults",
  "--trust",
  "--data-file",
  join(runnerTemp, "data-new.yml"),
  srcPath,
  join(runnerTemp, "render-new"),
]);
writeFileSync(
  join(runnerTemp, "retired-paths.json"),
  run(
    [
      "bun",
      ".github/scripts/sync/retired_paths.ts",
      "--old-render",
      join(runnerTemp, "render-old"),
      "--new-render",
      join(runnerTemp, "render-new"),
      "--old-copier",
      join(runnerTemp, "copier-old.yml"),
      "--new-copier",
      join(runnerTemp, "copier-new.yml"),
    ],
    { stdout: "pipe" },
  ),
);

const retired = JSON.parse(
  await Bun.file(join(runnerTemp, "retired-paths.json")).text(),
) as string[];
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
