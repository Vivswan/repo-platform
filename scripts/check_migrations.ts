#!/usr/bin/env bun
// Forgotten-migration tripwire: a template change that stops rendering a
// previously RELEASED landing path (a rename or retirement), changes the
// condition under which it renders (a gate flip - some selections retire
// the file even though the path survives), or flips its ownership class
// (entering or leaving _skip_if_exists) must ship a migration script named
// for the release being left behind (migrations/README.md). Compares the
// newest templates/vX.Y.Z build tag against the working tree's composed
// template and fails naming each transition and the expected
// migrations/<latest-version>.ts filename when that script is absent.
//
// Release state is determined against ORIGIN, not just local tags: a
// shallow or tagless checkout must not read as "nothing released". The
// check fails loudly when origin's templates/v* tags cannot be listed, and
// passes trivially only when origin agrees none exist.
//
// The comparison keys on landing paths (filename gates and the .jinja
// suffix stripped) PLUS each path's gate signature, so a file moving
// between render conditions is a transition even though the path exists in
// both versions. _skip_if_exists matching reuses scripts/generate.ts's
// gitwildmatch-faithful matchers - the same semantics copier applies - and
// a skip-listed path leaving the render is a distinct transition from a
// managed retirement: the sync deletes nothing, but the client's
// customized copy is stranded (the exact shape of a generated-once
// RENAME), so it demands a migration decision all the same.
//
// Usage:
//   bun scripts/check_migrations.ts

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { capture } from "../.github/scripts/shared/proc.ts";
import { protectedPaths } from "../.github/scripts/sync/retired_paths.ts";
import { compare, parse as parseVersion, type Version } from "../migrations/run.ts";
import { build } from "./compose_template.ts";
import { skipIfExistsMatchers } from "./generate.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");

/** An emitted template path reduced to what a downstream repo sees: the
 *  landing path (gate tags and the .jinja suffix stripped) and the gate
 *  signature - the whitespace-normalized `{% if %}` expressions along the
 *  path, joined in order ("" = rendered unconditionally). */
export function renderedPath(emitted: string): { landing: string; signature: string } {
  const stem = emitted.endsWith(".jinja") ? emitted.slice(0, -".jinja".length) : emitted;
  const gates: string[] = [];
  const landing = stem.replace(
    /\{%\s*if\s+(.*?)\s*%\}|\{%\s*endif\s*%\}/g,
    (_, expr: string | undefined) => {
      if (expr !== undefined) gates.push(expr.replace(/\s+/g, " "));
      return "";
    },
  );
  return { landing, signature: gates.join(" && ") };
}

/** The path a downstream repo carries for an emitted template path. */
export function landingPath(emitted: string): string {
  return renderedPath(emitted).landing;
}

/** landing path -> its sorted, deduplicated gate signatures for one
 *  template version (distinct emitted paths can land the same name only
 *  when their gates differ, so the map keeps every signature). */
export function renderMap(emitted: Iterable<string>): Map<string, string[]> {
  const collected = new Map<string, Set<string>>();
  for (const path of emitted) {
    const { landing, signature } = renderedPath(path);
    const signatures = collected.get(landing) ?? new Set<string>();
    signatures.add(signature);
    collected.set(landing, signatures);
  }
  return new Map([...collected].map(([landing, signatures]) => [landing, [...signatures].sort()]));
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

/** Tag names from `git ls-remote --tags` output: the refs/tags/ prefix
 *  stripped and the ^{} peeled duplicates dropped. */
export function remoteTagNames(lsRemoteStdout: string): string[] {
  const names = new Set<string>();
  for (const line of lsRemoteStdout.split("\n")) {
    const ref = line.split("\t")[1];
    if (ref === undefined || ref.endsWith("^{}")) continue;
    if (ref.startsWith("refs/tags/")) names.add(ref.slice("refs/tags/".length));
  }
  return [...names];
}

/** Still-rendered landing paths whose _skip_if_exists status differs
 *  between the two versions: an ownership flip (template-managed <->
 *  generated-once repo-owned) changes what the sync may overwrite or
 *  delete, so it needs a migration like a rename does. */
export function ownershipFlips(
  oldPaths: ReadonlySet<string>,
  newPaths: ReadonlySet<string>,
  skipOld: readonly RegExp[],
  skipNew: readonly RegExp[],
): string[] {
  return [...oldPaths]
    .filter(
      (path) =>
        newPaths.has(path) &&
        skipOld.some((matcher) => matcher.test(path)) !==
          skipNew.some((matcher) => matcher.test(path)),
    )
    .sort();
}

export type Transition = {
  path: string;
  kind: "retired" | "generated-once-removed" | "gate-changed" | "ownership-flip";
  detail?: string;
};

function describeSignatures(signatures: readonly string[]): string {
  return signatures
    .map((signature) => (signature === "" ? "unconditional" : `(${signature})`))
    .join(" or ");
}

/** Every transition between the two versions that demands a migration:
 *  managed paths that left the render (retired), _skip_if_exists paths
 *  that left the render (generated-once-removed - the sync deletes
 *  nothing, but a rename strands the client's customized copy), paths
 *  rendered under a different gate signature (gate-changed - selections
 *  that rendered it before may retire it), and still-rendered paths whose
 *  skip status changed (ownership-flip). Only the always-protected paths
 *  are exempt: the check must fire for a transition under ANY selection. */
export function collectTransitions(
  oldRender: ReadonlyMap<string, string[]>,
  newRender: ReadonlyMap<string, string[]>,
  skipOld: readonly RegExp[],
  skipNew: readonly RegExp[],
): Transition[] {
  const exempt = protectedPaths([]);
  const skipAny = (path: string) =>
    skipOld.some((matcher) => matcher.test(path)) || skipNew.some((matcher) => matcher.test(path));
  const retired: Transition[] = [];
  const generatedOnce: Transition[] = [];
  const gateChanged: Transition[] = [];
  for (const [path, oldSignatures] of [...oldRender].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (exempt.has(path)) continue;
    const newSignatures = newRender.get(path);
    if (newSignatures === undefined) {
      if (skipAny(path)) generatedOnce.push({ path, kind: "generated-once-removed" });
      else retired.push({ path, kind: "retired" });
      continue;
    }
    if (oldSignatures.join("\n") !== newSignatures.join("\n")) {
      gateChanged.push({
        path,
        kind: "gate-changed",
        detail: `was ${describeSignatures(oldSignatures)}, now ${describeSignatures(newSignatures)}`,
      });
    }
  }
  const flips = ownershipFlips(
    new Set(oldRender.keys()),
    new Set(newRender.keys()),
    skipOld,
    skipNew,
  )
    .filter((path) => !exempt.has(path))
    .map((path): Transition => ({ path, kind: "ownership-flip" }));
  return [...retired, ...generatedOnce, ...gateChanged, ...flips];
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
  const what: Record<Transition["kind"], (t: Transition) => string> = {
    retired: ({ path }) =>
      `templates/v${version} rendered '${path}' but the current template does not`,
    "generated-once-removed": ({ path }) =>
      `templates/v${version} rendered '${path}', which left the render while listed in _skip_if_exists (in either version's list) - the sync deletes nothing, so a rename strands the client's customized copy`,
    "gate-changed": ({ path, detail }) =>
      `'${path}' renders under a different condition than in templates/v${version} (${detail}) - selections that rendered it before may retire it with this update`,
    "ownership-flip": ({ path }) =>
      `'${path}' changed ownership class since templates/v${version} (entered or left _skip_if_exists)`,
  };
  return transitions.map(
    (transition) =>
      `${what[transition.kind](transition)}; synced repos cross this transition blind without migrations/${version}.ts. ` +
      "Add the migration (plus an upgrade_path_test.sh case and a PR-body note - " +
      "see migrations/README.md), or revert the transition.",
  );
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function skipMatchers(text: string, label: string): RegExp[] {
  try {
    return skipIfExistsMatchers(text);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    fail(`${label}: ${detail.replace(/^copier\.yml: /, "")}`);
  }
}

/** The newest release tag, consulting BOTH local tags and origin's - a
 *  shallow or tagless checkout must not silently read as "nothing
 *  released". Failure to list origin's tags fails the check loudly; a
 *  tag known only remotely is fetched before use. */
function resolveLatestRelease(): { tag: string; version: string } | null {
  const local = capture(["git", "tag", "--list", "templates/v*"], { cwd: REPO_ROOT });
  if (local.exitCode !== 0) fail(`git tag --list failed: ${local.stderr.trim()}`);
  const remote = capture(["git", "ls-remote", "--tags", "origin", "refs/tags/templates/v*"], {
    cwd: REPO_ROOT,
  });
  if (remote.exitCode !== 0) {
    fail(
      `cannot determine the release state: listing origin's templates/v* tags failed (${remote.stderr.trim()}). ` +
        "The tripwire must see the release history to compare against; restore remote access " +
        "(or fetch the templates/v* tags), then re-run.",
    );
  }
  const latest = latestReleaseTag([
    ...local.stdout.split("\n").filter((tag) => tag !== ""),
    ...remoteTagNames(remote.stdout),
  ]);
  if (latest === null) return null;
  const resolvable = () =>
    capture(["git", "rev-parse", "--verify", "--quiet", `refs/tags/${latest.tag}^{commit}`], {
      cwd: REPO_ROOT,
    }).exitCode === 0;
  if (!resolvable()) {
    capture(
      ["git", "fetch", "--quiet", "origin", `+refs/tags/${latest.tag}:refs/tags/${latest.tag}`],
      { cwd: REPO_ROOT },
    );
    if (!resolvable()) {
      fail(
        `origin has ${latest.tag} but it cannot be fetched into this checkout, so the released ` +
          "template tree is unavailable to compare against. Fetch the tag manually, then re-run.",
      );
    }
  }
  return latest;
}

function main(): number {
  const latest = resolveLatestRelease();
  if (latest === null) {
    console.log("migrations check ok: no templates/vX.Y.Z release tag exists locally or on origin");
    return 0;
  }

  // The tag is a build-branch tree: the rendered template sits under
  // template/. -z framing, because gated filenames carry quote characters
  // git's default output would C-escape.
  const lsTree = capture(["git", "ls-tree", "-r", "--name-only", "-z", latest.tag], {
    cwd: REPO_ROOT,
  });
  if (lsTree.exitCode !== 0) fail(`git ls-tree ${latest.tag} failed: ${lsTree.stderr.trim()}`);
  const oldRender = renderMap(
    lsTree.stdout
      .split("\0")
      .filter((path) => path.startsWith("template/"))
      .map((path) => path.slice("template/".length)),
  );

  const newRender = renderMap(build().keys());

  const oldCopier = capture(["git", "show", `${latest.tag}:copier.yml`], { cwd: REPO_ROOT });
  if (oldCopier.exitCode !== 0) {
    fail(`git show ${latest.tag}:copier.yml failed: ${oldCopier.stderr.trim()}`);
  }
  const skipOld = skipMatchers(oldCopier.stdout, `${latest.tag}:copier.yml`);
  const skipNew = skipMatchers(readFileSync(join(REPO_ROOT, "copier.yml"), "utf-8"), "copier.yml");

  const transitions = collectTransitions(oldRender, newRender, skipOld, skipNew);
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
