#!/usr/bin/env bun
// Forgotten-migration tripwire: a template change that stops rendering a
// previously RELEASED landing path (a rename or retirement) or flips a
// still-rendered path's ownership class (entering or leaving
// _skip_if_exists) must ship a migration script named for the release
// being left behind (migrations/README.md). Compares the newest
// templates/vX.Y.Z build tag against the working tree's composed template
// and fails naming each such path and the expected
// migrations/<latest-version>.ts filename when that script is absent.
// With no release tag reachable nothing has shipped, so nothing can need
// migrating and the check passes trivially.
//
// Landing paths, not emitted paths: filename gates
// ({% if ... %}name{% endif %}) and the .jinja suffix are stripped so the
// comparison sees the path a downstream repo actually carries, whichever
// modules it selects. A _skip_if_exists path that leaves the render is a
// distinct transition from a managed retirement: the sync deletes nothing
// (retired_paths.ts exempts it from cleanup), but the client's customized
// copy is stranded - the exact shape of a generated-once RENAME - so it
// demands a migration decision all the same.
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

/** Still-rendered landing paths whose _skip_if_exists status differs
 *  between the two versions: an ownership flip (template-managed <->
 *  generated-once repo-owned) changes what the sync may overwrite or
 *  delete, so it needs a migration like a rename does. */
export function ownershipFlips(
  oldPaths: ReadonlySet<string>,
  newPaths: ReadonlySet<string>,
  skipOld: readonly string[],
  skipNew: readonly string[],
): string[] {
  const oldGlobs = skipOld.map((pattern) => new Bun.Glob(pattern));
  const newGlobs = skipNew.map((pattern) => new Bun.Glob(pattern));
  return [...oldPaths]
    .filter(
      (path) =>
        newPaths.has(path) &&
        oldGlobs.some((glob) => glob.match(path)) !== newGlobs.some((glob) => glob.match(path)),
    )
    .sort();
}

export type Transition = {
  path: string;
  kind: "retired" | "ownership-flip" | "generated-once-removed";
};

/** Every transition between the two versions that demands a migration:
 *  managed paths that left the render (retired), _skip_if_exists paths
 *  that left the render (generated-once-removed - the sync deletes
 *  nothing, but a rename strands the client's customized copy), and
 *  still-rendered paths whose skip status changed (ownership-flip).
 *  retiredPaths runs with modules=[] so only the always-protected paths
 *  are exempt: the check must fire for a path retired under ANY
 *  selection. */
export function collectTransitions(
  oldPaths: ReadonlySet<string>,
  newPaths: ReadonlySet<string>,
  skipOld: readonly string[],
  skipNew: readonly string[],
): Transition[] {
  const managed = retiredPaths(oldPaths, newPaths, [...skipOld, ...skipNew], []);
  const managedSet = new Set(managed);
  const generatedOnce = retiredPaths(oldPaths, newPaths, [], []).filter(
    (path) => !managedSet.has(path),
  );
  return [
    ...managed.map((path): Transition => ({ path, kind: "retired" })),
    ...generatedOnce.map((path): Transition => ({ path, kind: "generated-once-removed" })),
    ...ownershipFlips(oldPaths, newPaths, skipOld, skipNew).map(
      (path): Transition => ({ path, kind: "ownership-flip" }),
    ),
  ];
}

/** One error per transition when the migration for the release being left
 *  behind is missing; empty when nothing changed or the script exists (its
 *  adequacy is the upgrade-path test's job, not this check's). */
export function migrationErrors(
  transitions: readonly Transition[],
  version: string,
  migrationExists: boolean,
): string[] {
  if (transitions.length === 0 || migrationExists) return [];
  const what: Record<Transition["kind"], (path: string) => string> = {
    retired: (path) => `templates/v${version} rendered '${path}' but the current template does not`,
    "generated-once-removed": (path) =>
      `templates/v${version} rendered '${path}' as a generated-once (_skip_if_exists) file and the current template does not render it at all - the sync deletes nothing, so a rename strands the client's customized copy`,
    "ownership-flip": (path) =>
      `'${path}' changed ownership class since templates/v${version} (entered or left _skip_if_exists)`,
  };
  return transitions.map(
    ({ path, kind }) =>
      `${what[kind](path)}; synced repos cross this transition blind without migrations/${version}.ts. ` +
      "Add the migration (plus an upgrade_path_test.sh case and a PR-body note - " +
      "see migrations/README.md), or revert the transition.",
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
  const skipOld = skipPatterns(oldCopier.stdout, `${latest.tag}:copier.yml`);
  const skipNew = skipPatterns(readFileSync(join(REPO_ROOT, "copier.yml"), "utf-8"), "copier.yml");

  const transitions = collectTransitions(oldPaths, newPaths, skipOld, skipNew);
  const migration = join(REPO_ROOT, "migrations", `${latest.version}.ts`);
  const errors = migrationErrors(transitions, latest.version, existsSync(migration));
  if (errors.length > 0) {
    for (const message of errors) console.error(`error: ${message}`);
    return 1;
  }
  console.log(
    transitions.length > 0
      ? `migrations check ok: migrations/${latest.version}.ts exists for ${transitions.length} transition(s) since ${latest.tag}`
      : `migrations check ok: no landing-path transitions since ${latest.tag}`,
  );
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
