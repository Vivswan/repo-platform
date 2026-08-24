#!/usr/bin/env bun
// Forgotten-migration tripwire: a template change that stops rendering a
// previously RELEASED landing path (a rename, a retirement, an ownership
// flip) must ship a migration script named for the release being left
// behind (migrations/README.md). Compares the newest templates/vX.Y.Z
// build tag's rendered landing paths against the working tree's composed
// template and fails when a path left the render with no
// migrations/<latest-version>.ts in the tree. With no release tag
// reachable nothing has shipped, so nothing can need migrating and the
// check passes trivially.
//
// Landing paths, not emitted paths: filename gates
// ({% if ... %}name{% endif %}) and the .jinja suffix are stripped so the
// comparison sees the path a downstream repo actually carries, whichever
// modules it selects. Paths matched by either version's _skip_if_exists
// list are generated-once and repo-owned - the sync never deletes them -
// so their leaving the render is filtered out by retired_paths.ts's own
// rules, the same ones the sync's cleanup applies.
//
// Usage:
//   bun scripts/check_migrations.ts

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { capture } from "../.github/scripts/shared/proc.ts";
import { readSkipIfExists, retiredPaths } from "../.github/scripts/sync/retired_paths.ts";
import { compare, parse as parseVersion, type Version } from "../migrations/run.ts";
import { build } from "./compose_template.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");

/** The path a downstream repo carries for an emitted template path: the
 *  .jinja suffix stripped, then every filename-gate tag removed (gate
 *  expressions never contain `%`, so the non-greedy tag match is exact). */
export function landingPath(emitted: string): string {
  const stem = emitted.endsWith(".jinja") ? emitted.slice(0, -".jinja".length) : emitted;
  return stem.replace(/\{%.+?%\}/g, "");
}

/** The newest templates/vX.Y.Z tag by SEMVER order (git's lexical tag
 *  order would put v9 above v10), with the bare version alongside. Tags
 *  of any other shape are ignored. */
export function latestReleaseTag(tags: readonly string[]): { tag: string; version: string } | null {
  let best: { tag: string; version: string; parsed: Version } | null = null;
  for (const tag of tags) {
    if (!tag.startsWith("templates/v")) continue;
    const parsed = parseVersion(tag);
    if (parsed === null) continue;
    if (best === null || compare(parsed, best.parsed) > 0) {
      best = { tag, version: parsed.join("."), parsed };
    }
  }
  return best === null ? null : { tag: best.tag, version: best.version };
}

/** One error per retired landing path when the migration for the release
 *  being left behind is missing; empty when nothing retired or the script
 *  exists (its adequacy is the upgrade-path test's job, not this check's). */
export function migrationErrors(
  retired: readonly string[],
  version: string,
  migrationExists: boolean,
): string[] {
  if (retired.length === 0 || migrationExists) return [];
  return retired.map(
    (path) =>
      `templates/v${version} rendered '${path}' but the current template does not; ` +
      `synced repos cross this transition blind without migrations/${version}.ts. ` +
      "Add the migration (plus an upgrade_path_test.sh case and a PR-body note - " +
      "see migrations/README.md), or restore the path.",
  );
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function skipPatterns(text: string, label: string): string[] {
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch (err) {
    const detail = err instanceof Error ? err.message.split("\n")[0] : String(err);
    fail(`${label}: cannot read as YAML: ${detail}`);
  }
  const { patterns, errors } = readSkipIfExists(data, label);
  if (patterns === null) fail(errors.join("; "));
  return patterns;
}

function main(): number {
  const tags = capture(["git", "tag", "--list", "templates/v*"], { cwd: REPO_ROOT });
  if (tags.exitCode !== 0) fail(`git tag --list failed: ${tags.stderr.trim()}`);
  const latest = latestReleaseTag(tags.stdout.split("\n").filter((tag) => tag !== ""));
  if (latest === null) {
    console.log("migrations check ok: no templates/vX.Y.Z release tag exists yet");
    return 0;
  }

  // The tag is a build-branch tree: the rendered template sits under
  // template/. -z framing, because gated filenames carry quote characters
  // git's default output would C-escape.
  const lsTree = capture(["git", "ls-tree", "-r", "--name-only", "-z", latest.tag], {
    cwd: REPO_ROOT,
  });
  if (lsTree.exitCode !== 0) fail(`git ls-tree ${latest.tag} failed: ${lsTree.stderr.trim()}`);
  const oldPaths = new Set<string>();
  for (const path of lsTree.stdout.split("\0")) {
    if (path.startsWith("template/")) oldPaths.add(landingPath(path.slice("template/".length)));
  }

  const newPaths = new Set([...build().keys()].map(landingPath));

  const oldCopier = capture(["git", "show", `${latest.tag}:copier.yml`], { cwd: REPO_ROOT });
  if (oldCopier.exitCode !== 0) {
    fail(`git show ${latest.tag}:copier.yml failed: ${oldCopier.stderr.trim()}`);
  }
  const skips = [
    ...skipPatterns(oldCopier.stdout, `${latest.tag}:copier.yml`),
    ...skipPatterns(readFileSync(join(REPO_ROOT, "copier.yml"), "utf-8"), "copier.yml"),
  ];

  // Module selection [] means only the always-protected paths are exempt:
  // the check must fire for a path retired under ANY selection.
  const retired = retiredPaths(oldPaths, newPaths, skips, []);
  const migration = join(REPO_ROOT, "migrations", `${latest.version}.ts`);
  const errors = migrationErrors(retired, latest.version, existsSync(migration));
  if (errors.length > 0) {
    for (const message of errors) console.error(`error: ${message}`);
    return 1;
  }
  console.log(
    retired.length > 0
      ? `migrations check ok: migrations/${latest.version}.ts exists for ${retired.length} retired landing path(s) since ${latest.tag}`
      : `migrations check ok: no rendered landing paths retired since ${latest.tag}`,
  );
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
