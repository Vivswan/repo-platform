#!/usr/bin/env bun
// Materializes the two clean template renders a sync run consumes, once,
// in $RUNNER_TEMP: render-old (the template at the recorded pre-update
// ref, with the answers recorded before this update) and render-new (the
// target ref, with the live module/channel/private/description data).
// Invoked from the repo-platform checkout root by
// reusable-template-sync.yml's "Materialize clean renders" step; the
// split-file rebuild (preserve_local_content.ts --render-dir) consumes
// render-new and render-old, retired-file cleanup (retired_cleanup.ts)
// diffs the pair. One materialization guarantees every consumer sees the
// same bytes the update rendered - same answers capture, same
// render_data.ts plumbing.
//
// Idempotent WITHIN one RUNNER_TEMP: when both render directories already
// exist the call is a no-op, so retired_cleanup.ts (and older callers like
// rehearse.ts and ci/upgrade_path_test.sh legs written before this split)
// can call ensureRenders unconditionally. A single leftover directory (a
// crash between the two copier calls) is deleted and both are rebuilt.
// Callers own RUNNER_TEMP freshness: CI provides a per-job directory, the
// harness and rehearse create fresh scratch dirs per run - a reused
// directory would serve renders from whatever inputs built them.
//
// Env: OLD_SHA, TARGET_REF, MODULES, CHANNEL, PRIVATE, DESCRIPTION,
// SRC_PATH, RUNNER_TEMP; TARGET_DIR (default target).

import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { env, requireEnv } from "../shared/gha.ts";

/** Run a command; on failure forward a captured child's stdout (workflow
 * ::error:: commands parse from stdout, so swallowing it would silence the
 * failure detail) and exit with its code. */
export function run(command: string[], options: { stdout?: "pipe" } = {}): string {
  const proc = Bun.spawnSync(command, {
    stdio: ["inherit", options.stdout === "pipe" ? "pipe" : "inherit", "inherit"],
  });
  if (proc.exitCode !== 0) {
    if (options.stdout === "pipe") process.stdout.write(proc.stdout?.toString() ?? "");
    process.exit(proc.exitCode ?? 1);
  }
  return options.stdout === "pipe" ? (proc.stdout?.toString() ?? "") : "";
}

export interface CleanRenders {
  renderOld: string;
  renderNew: string;
  /** The pre-update .copier-answers.yml capture (also on disk for the
   * later steps that read it). */
  answersOldText: string;
}

/** Materialize render-old and render-new under RUNNER_TEMP (no-op when
 * both already exist - the workflow materializes once and every later
 * step consumes). */
export function ensureRenders(): CleanRenders {
  const runnerTemp = requireEnv("RUNNER_TEMP");
  const targetDir = env("TARGET_DIR", "target");
  const renderOld = join(runnerTemp, "render-old");
  const renderNew = join(runnerTemp, "render-new");

  // The old render uses the answers recorded BEFORE this update (HEAD
  // still points at the pre-update commit); captured even on the no-op
  // path so consumers of answers-old.yml never depend on call order.
  const answersOldText = run(["git", "-C", targetDir, "show", "HEAD:.copier-answers.yml"], {
    stdout: "pipe",
  });
  writeFileSync(join(runnerTemp, "answers-old.yml"), answersOldText);

  if (existsSync(renderOld) && existsSync(renderNew)) {
    console.log("clean renders already materialized; nothing to do");
    return { renderOld, renderNew, answersOldText };
  }
  // Exactly one directory: a previous materialization died between the two
  // copier calls. Rebuild the pair from scratch - copier will not render
  // into a non-empty directory, and a half-materialized pair must never be
  // consumed as if complete.
  for (const dir of [renderOld, renderNew]) {
    rmSync(dir, { recursive: true, force: true });
  }

  // The new render applies the live module/channel/private/description
  // data on top of the recorded answers.
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
    renderOld,
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
    renderNew,
  ]);
  return { renderOld, renderNew, answersOldText };
}

if (import.meta.main) {
  ensureRenders();
}
