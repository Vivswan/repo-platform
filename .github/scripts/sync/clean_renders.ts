#!/usr/bin/env bun
// Materializes the two clean template renders a sync run consumes, once,
// in $RUNNER_TEMP: render-old (the recorded pre-update ref with the
// answers recorded before this update) and render-new (the target ref
// with the live module/private/description data). One materialization
// guarantees every consumer (the split-file rebuild, retired-file cleanup)
// sees the same bytes the update rendered.
//
// Idempotent WITHIN one RUNNER_TEMP: with both render directories present
// the call is a no-op, so consumers can call ensureRenders unconditionally.
// Renders build in scratch directories and rename into place once both
// succeeded, so a crash never publishes a partial render. Callers own
// RUNNER_TEMP freshness (CI gives a per-job directory; the harness and
// rehearse create fresh scratch dirs): a reused directory would serve
// renders from whatever inputs built them.
//
// Env: OLD_SHA, TARGET_REF, MODULES, PRIVATE, DESCRIPTION, HOMEPAGE,
// TOPICS, SRC_PATH, RUNNER_TEMP; TARGET_DIR (default target).

import { existsSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { env, requireEnv } from "../shared/gha.ts";
import { capture, must } from "../shared/proc.ts";
import { ANSWERS_PATH } from "./answers_file.ts";

/** Run a command; on failure forward a captured child's stdout (workflow
 * ::error:: commands parse from stdout, so swallowing it would silence the
 * failure detail) and exit with its code. The pipe mode captures stderr too
 * (proc.ts's hang bound needs the pipe) and re-emits it whole, success or
 * failure - buffered rather than streamed, same content. writeSync, not
 * the process streams: an async stream write racing process.exit (here or
 * in a caller like retired_cleanup's fail paths) truncates at the pipe
 * buffer (~64 KiB). */
export function run(command: string[], options: { stdout?: "pipe" } = {}): string {
  if (options.stdout !== "pipe") {
    must(command);
    return "";
  }
  const proc = capture(command);
  writeSync(2, proc.stderr);
  if (proc.exitCode !== 0) {
    // Program name only: the argv tail can carry target-derived values.
    if (proc.timedOut) console.error(`${command[0]} timed out (proc.ts hang bound)`);
    writeSync(1, proc.stdout);
    process.exit(proc.exitCode);
  }
  return proc.stdout;
}

export interface CleanRenders {
  renderOld: string;
  renderNew: string;
  /** The pre-update .github/.copier-answers.yml capture (also on disk for
   * the later steps that read it). */
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

  // The old render uses the answers recorded BEFORE this update: HEAD is
  // the last pre-copier commit (the _src_path normalization and any
  // migration rung committed ahead of copier; normalization changes only
  // the underscore metadata render_data drops). Captured even on the no-op
  // path so consumers never depend on call order; the renders are NOT
  // re-captured there, so a HEAD move between two calls in one RUNNER_TEMP
  // would skew answers-old.yml against render-old. No sync step moves HEAD
  // between materialize and consume; if one did, retired-paths noise is loud.
  const answersOldText = run(["git", "-C", targetDir, "show", `HEAD:${ANSWERS_PATH}`], {
    stdout: "pipe",
  });
  writeFileSync(join(runnerTemp, "answers-old.yml"), answersOldText);

  if (existsSync(renderOld) && existsSync(renderNew)) {
    console.log("clean renders already materialized; nothing to do");
    return { renderOld, renderNew, answersOldText };
  }
  // Render into scratch directories and publish both with renames at the
  // end: the consumers' existence probe must never see a directory copier
  // is still filling, and a crash mid-render leaves no final directory
  // behind. A leftover from a previous crash (scratch, or a lone final
  // directory from a pre-rename failure) is deleted first - copier will
  // not render into a non-empty directory, and a half-materialized pair
  // must never be consumed as if complete.
  const scratchOld = `${renderOld}.rendering`;
  const scratchNew = `${renderNew}.rendering`;
  for (const dir of [renderOld, renderNew, scratchOld, scratchNew]) {
    rmSync(dir, { recursive: true, force: true });
  }

  // The new render applies the live module/private/description data on
  // top of the recorded answers.
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
    "--private",
    requireEnv("PRIVATE"),
    "--description",
    env("DESCRIPTION"),
    "--homepage",
    env("HOMEPAGE"),
    "--topics",
    env("TOPICS"),
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
    scratchOld,
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
    scratchNew,
  ]);
  renameSync(scratchOld, renderOld);
  renameSync(scratchNew, renderNew);
  return { renderOld, renderNew, answersOldText };
}

if (import.meta.main) {
  ensureRenders();
}
