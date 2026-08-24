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
// The license (LICENSE.md, or a custom repo's own spelling) leaves the
// render when a repo selects the custom-license module;
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
// diff), retired cleanup never lists the path (LICENSE.md is in both
// renders), and there is no HEAD copy to restore -
// but the fleet license is mandatory without the custom-license module, so
// it is re-seeded from the target build ref (which must be resolvable in
// the cwd's git repository).
//
// Invoked by reusable-template-sync.yml's "Preserve repo-owned files" step
// and by ci/upgrade_path_test.sh.
//
// Env: RECOVER; TARGET_DIR (default target); TARGET_REF and MODULES (for
// the fleet-license re-seed); RUNNER_TEMP (license-transition flag file);
// TARGET_DISPLAY / TARGET (log label, in that order; defaults to
// TARGET_DIR).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { env, error, notice, requireEnv } from "../shared/gha.ts";
import { parseModules } from "../shared/modules.ts";

const targetDir = env("TARGET_DIR", "target");
const label = env("TARGET_DISPLAY") || env("TARGET") || targetDir;
const recover = env("RECOVER") === "recopy";
const modules = parseModules(env("MODULES")) ?? [];

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

// Only on the custom-license module: there the repo's own license is
// repo-owned - LICENSE.md by convention, with the extensionless spelling
// tolerated until every repo's rename lands. Without the module the
// license is template-managed, and a de-rendered old spelling (the
// extensionless LICENSE before the LICENSE.md rename) must stay deleted.
if (!recover && modules.includes("custom-license")) {
  for (const name of ["LICENSE", "LICENSE.md"]) {
    if (inHead(name) && !existsSync(join(targetDir, name))) {
      restoreFromHead(name);
      notice(
        `${label}: ${name} left the template render (custom-license module) but is repo-owned; kept as-is.`,
      );
    }
  }
}

const fleetLicense = "template/{% if 'custom-license' not in modules %}LICENSE.md{% endif %}.jinja";
if (
  !recover &&
  !existsSync(join(targetDir, "LICENSE.md")) &&
  !inHead("LICENSE.md") &&
  !modules.includes("custom-license")
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
    const username = answers.github_username;
    if (typeof username !== "string" || username === "") {
      error(
        `${label}: cannot re-seed the fleet license; .copier-answers.yml records no github_username`,
      );
      process.exit(1);
    }
    // Callback replacement: a literal holder string would have its $
    // sequences expanded.
    const rendered = show.stdout
      .toString()
      .replaceAll("{{ copyright_holder }}", () => holder)
      .replaceAll("{{ github_username }}", () => username);
    if (rendered.includes("{{") || rendered.includes("{%")) {
      error(`${label}: cannot re-seed the fleet license; unrendered template expressions remain`);
      process.exit(1);
    }
    writeFileSync(join(targetDir, "LICENSE.md"), rendered);
    notice(
      `${label}: LICENSE.md was deleted but the fleet license is mandatory without the custom-license module; re-seeded from ${targetRef}.`,
    );
  }
}

// A license file this update deletes never reaches the PR as a conflict:
// copier resolves delete-vs-modify by dropping the file, so content below
// its local-section marker (third-party notices) silently leaves the
// repo, and the update can otherwise look clean. The deletion is flagged
// for open_pr.ts, which holds the PR for human review however the run was
// dispatched - the restore and re-seed blocks above have already put back
// every license the sync preserves, so anything still missing here is a
// real deletion.
const transitions = ["LICENSE", "LICENSE.md"].filter(
  (name) => inHead(name) && !existsSync(join(targetDir, name)),
);
writeFileSync(
  join(requireEnv("RUNNER_TEMP"), "license-transition.txt"),
  transitions.map((name) => `${name}\n`).join(""),
);
if (transitions.length > 0) {
  notice(
    `${label}: this update deletes ${transitions.join(" and ")}; the PR stays manual-review so a human can check the deleted file for local notices worth keeping (prior licensing needs none - git history is the record).`,
  );
}
