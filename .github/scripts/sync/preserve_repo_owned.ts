#!/usr/bin/env bun
// Preserves repo-owned files after an update.
//
// settings.yml is repo-owned wherever it exists: deselecting the
// settings-sync module de-renders it, but the sync must never delete a
// repo's settings file - repo-platform's settings-repos run applies it
// remotely (a central settings/repos/<name>.yml wins over it). A recovery
// re-render has no three-way merge to protect local content, so there it
// is restored outright.
//
// LICENSE leaves the render when a repo selects the custom-license module;
// copier deletes the de-rendered file when it was unmodified, which would
// leave the repo with no license at all, so it is restored from the base
// commit. Unlike settings.yml it is NOT restored on recovery: without the
// module LICENSE is fleet-managed and the recovery re-render's overwrite
// is the correct outcome; with the module the recovery re-render does not
// emit LICENSE (recopy deletes nothing), so the repo's own license
// survives untouched.
//
// A committed LICENSE deletion in a repo still on the fleet license is the
// remaining hole: copier honors the deletion (it re-applies the local
// diff), cleanup protects the path, and there is no HEAD copy to restore -
// but the fleet license is mandatory without the custom-license module, so
// it is re-seeded from the target build ref (which must be resolvable in
// the cwd's git repository).
//
// Invoked by reusable-template-sync.yml's "Preserve repo-owned files" step
// and by ci/upgrade_path_test.sh.
//
// Env: RECOVER; TARGET_DIR (default target); TARGET_REF and MODULES (for
// the fleet-license re-seed); TARGET_DISPLAY / TARGET (log label, in that
// order; defaults to TARGET_DIR).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { env, error, notice } from "../shared/gha.ts";

const targetDir = env("TARGET_DIR", "target");
const label = env("TARGET_DISPLAY") || env("TARGET") || targetDir;
const recover = env("RECOVER") === "recopy";

function git(args: string[]): { exitCode: number; stdout: string } {
  const proc = Bun.spawnSync(["git", "-C", targetDir, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: proc.exitCode ?? 1, stdout: proc.stdout.toString() };
}

function inHead(path: string): boolean {
  return git(["cat-file", "-e", `HEAD:${path}`]).exitCode === 0;
}

function restoreFromHead(path: string): void {
  const proc = Bun.spawnSync(["git", "-C", targetDir, "checkout", "HEAD", "--", path], {
    stdio: ["inherit", "inherit", "inherit"],
  });
  if (proc.exitCode !== 0) process.exit(proc.exitCode ?? 1);
}

if (inHead(".github/settings.yml")) {
  if (recover) {
    restoreFromHead(".github/settings.yml");
    notice(
      `${label}: .github/settings.yml is repo-owned; restored as-is after the recovery re-render.`,
    );
  } else if (!existsSync(join(targetDir, ".github/settings.yml"))) {
    restoreFromHead(".github/settings.yml");
    notice(
      `${label}: .github/settings.yml left the template render but is repo-owned; kept as-is.`,
    );
  }
}

if (!recover && inHead("LICENSE") && !existsSync(join(targetDir, "LICENSE"))) {
  restoreFromHead("LICENSE");
  notice(
    `${label}: LICENSE left the template render (custom-license module) but is repo-owned; kept as-is.`,
  );
}

const fleetLicense = "template/{% if 'custom-license' not in modules %}LICENSE{% endif %}.jinja";
if (
  !recover &&
  !existsSync(join(targetDir, "LICENSE")) &&
  !inHead("LICENSE") &&
  !env("MODULES").includes("custom-license")
) {
  const targetRef = env("TARGET_REF");
  if (
    targetRef !== "" &&
    Bun.spawnSync(["git", "cat-file", "-e", `${targetRef}:${fleetLicense}`]).exitCode === 0
  ) {
    const show = Bun.spawnSync(["git", "show", `${targetRef}:${fleetLicense}`], {
      stderr: "inherit",
    });
    if (show.exitCode !== 0) process.exit(show.exitCode ?? 1);
    // The template carries the Required Notice as a jinja variable; render
    // it from the repo's recorded answer rather than seeding template text.
    const answersPath = join(targetDir, ".copier-answers.yml");
    let answers: Record<string, unknown> = {};
    if (existsSync(answersPath)) {
      let doc: unknown;
      try {
        doc = parse(readFileSync(answersPath, "utf-8"));
      } catch {
        doc = undefined;
      }
      if (doc === undefined || doc === null || typeof doc !== "object" || Array.isArray(doc)) {
        error(`${label}: cannot re-seed the fleet license; .copier-answers.yml is unreadable`);
        process.exit(1);
      }
      answers = doc as Record<string, unknown>;
    }
    const holder = answers.copyright_holder;
    if (typeof holder !== "string" || holder === "") {
      error(
        `${label}: cannot re-seed the fleet license; .copier-answers.yml records no copyright_holder`,
      );
      process.exit(1);
    }
    // Callback replacement: a literal holder string would have its $
    // sequences expanded.
    const rendered = show.stdout.toString().replaceAll("{{ copyright_holder }}", () => holder);
    if (rendered.includes("{{") || rendered.includes("{%")) {
      error(`${label}: cannot re-seed the fleet license; unrendered template expressions remain`);
      process.exit(1);
    }
    writeFileSync(join(targetDir, "LICENSE"), rendered);
    notice(
      `${label}: LICENSE was deleted but the fleet license is mandatory without the custom-license module; re-seeded from ${targetRef}.`,
    );
  }
}
