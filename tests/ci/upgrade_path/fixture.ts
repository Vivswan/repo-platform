// The upgrade-path harness: a project generated from a synthetic OLD
// build tree, updated to a freshly assembled build the way
// reusable-template-sync does. Each leg test file owns one fixture: both
// builds committed as tags in a private ref namespace of THIS repository
// (copier re-renders the old version from _src_path, so both must live in
// one clone), scratch under the file's afterAll, and the sync's scripts
// run as subprocesses with the workflow's env. Readers here are
// independent of the code under test (yaml/JSON parsers, sha256, git).
//
// Every file gets its own fixture directory AND ref namespace, keyed on
// one mktemp token: linked worktrees share a ref store and /tmp, so
// concurrent runs used to delete each other's build tags mid-flight. The
// namespace's annotated `<namespace>/run` tag (pid, host, start time,
// fixture dir) is how `bun .github/scripts/ci/sweep_harness_namespaces.ts`
// tells a SIGKILLed run's leftovers from a live run next door. NEVER
// delete a namespace by hand.

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { type BoundedSpawnResult, boundedSpawnSync } from "../../shared/bounded_spawn";
import { type TempDirs, tempDirs } from "../../shared/temp_dir";
import { dropLinesContaining, editText, insertAfterLine, linesOf } from "./edits";
import {
  gateManifestEntry,
  HTML_MARKERS,
  htmlSplitEntry,
  MANIFEST_TEMPLATE,
  PENDING_RUNGS,
  plantTemplateFile,
  selected,
} from "./rungs";

export const REPO_ROOT = resolve(import.meta.dir, "../../..");

const hasCopier = Bun.which("copier") !== null;
/** The ci.yml upgrade-path job sets this: a runner without copier fails
 * there instead of skipping every leg green. */
const REQUIRE_COPIER = process.env.REQUIRE_COPIER === "1";
if (!hasCopier && REQUIRE_COPIER) {
  throw new Error("REQUIRE_COPIER=1 but copier is not on PATH (pipx install copier)");
}

/** A leg's describe block: skipped, with the reason in its name, where copier is absent. */
export function describeLeg(name: string, body: () => void): void {
  describe.skipIf(!hasCopier)(
    hasCopier ? name : `${name} (skipped: copier is not on PATH; CI's upgrade-path job runs it)`,
    body,
  );
}

/** A leg's test: copier renders and the sync's scripts take seconds each,
 * well past bun's default per-test timeout. */
export const LEG_TIMEOUT_MS = 600_000;
export function legTest(name: string, body: () => void): void {
  test(name, body, LEG_TIMEOUT_MS);
}

const COPIER_TIMEOUT_MS = 270_000;
export const CI_IDENTITY = ["-c", "user.name=ci", "-c", "user.email=ci@localhost"];
export const SYNC_IDENTITY = "repo-platform-sync <repo-platform-sync@users.noreply.github.com>";
/** Copier's inline conflict marker, built rather than spelled so the
 * source never carries a literal marker line. */
export const COPIER_CONFLICT_MARKER = `${"<".repeat(7)} before updating`;
export const MARKERS = {
  html: {
    begin: "<!-- BEGIN REPO-PLATFORM MANAGED -->",
    end: "<!-- END REPO-PLATFORM MANAGED -->",
  },
  hash: { begin: "# BEGIN REPO-PLATFORM MANAGED", end: "# END REPO-PLATFORM MANAGED" },
} as const;

export const BUILD_TAG_NAMES = ["old", "new", "split", "probe1", "probe2"] as const;
export type BuildTagName = (typeof BUILD_TAG_NAMES)[number];
export const RUN_TAG_NAME = "run";
/** Every tag a namespace may carry; the sweeper's list is pinned to it. */
export const NAMESPACE_TAG_NAMES = [RUN_TAG_NAME, ...BUILD_TAG_NAMES] as const;

const RUN_DIR_PREFIX = "upgrade-path.";

// ---------------------------------------------------------------- processes

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

/** The live environment minus git's per-invocation variables (a hook run
 * exports GIT_DIR/GIT_INDEX_FILE, which would redirect every fixture git
 * call at the real repository). */
export function harnessEnv(
  extra: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_")) env[key] = value;
  }
  return { ...env, ...extra };
}

/** Runs argv, never throwing on a nonzero exit (a timeout still throws). */
function tryRun(argv: string[], options: RunOptions = {}): BoundedSpawnResult {
  return boundedSpawnSync(argv, {
    cwd: options.cwd ?? REPO_ROOT,
    env: harnessEnv(options.env),
    timeoutMs: options.timeoutMs ?? 60_000,
  });
}

/** Runs argv and returns its stdout; a nonzero exit throws with both streams. */
export function run(argv: string[], options: RunOptions = {}): string {
  const result = tryRun(argv, options);
  if (result.exitCode !== 0) {
    throw new Error(
      `${argv.join(" ")} exited ${result.exitCode}\n--- stdout\n${result.stdout}\n--- stderr\n${result.stderr}`,
    );
  }
  return result.stdout;
}

/** `git -C cwd ...args`, stdout trimmed. */
export function git(cwd: string, ...args: string[]): string {
  return run(["git", "-C", cwd, ...args]).trimEnd();
}

/** `git add --all` plus a commit as the ci identity. */
export function commitAll(cwd: string, message: string): void {
  git(cwd, "add", "--all");
  git(cwd, ...CI_IDENTITY, "commit", "-q", "-m", message);
}

/** `git status --porcelain` with its exit code checked BEFORE its
 * emptiness is trusted: a failed status prints nothing, which a bare
 * emptiness check would read as a clean tree. */
export function isCleanTree(dir: string): boolean {
  return git(dir, "status", "--porcelain") === "";
}

/** The workflow's copier copy: a project at `ref` with the given answers. */
export function copierCopy(
  dest: string,
  ref: string,
  answers: {
    projectName: string;
    description: string;
    modules: string[];
    private: boolean;
    extra?: Record<string, string>;
  },
): void {
  const data = [
    `project_name=${answers.projectName}`,
    `description=${answers.description}`,
    `modules=[${answers.modules.join(", ")}]`,
    `private=${answers.private}`,
    ...Object.entries(answers.extra ?? {}).map(([key, value]) => `${key}=${value}`),
  ];
  run(
    [
      "copier",
      "copy",
      REPO_ROOT,
      dest,
      "--vcs-ref",
      ref,
      "--defaults",
      "--trust",
      ...data.flatMap((d) => ["-d", d]),
    ],
    { timeoutMs: COPIER_TIMEOUT_MS },
  );
}

/** A project rendered at `ref` and committed on main. */
export function renderProject(
  dest: string,
  ref: string,
  answers: Parameters<typeof copierCopy>[2],
  message = "chore: init",
): void {
  copierCopy(dest, ref, answers);
  git(dest, "init", "-q", "-b", "main");
  commitAll(dest, message);
}

// -------------------------------------------------------------- the fixture

export interface Build {
  readonly tag: string;
  readonly sha: string;
  /** The assembled tree the build was committed from. */
  readonly tree: string;
}

export interface Fixture {
  readonly temp: TempDirs;
  readonly runDir: string;
  readonly namespace: string;
  readonly old: Build;
  readonly new: Build;
  /** `<runDir>/<name>`, not created (copier creates its destination). */
  path(name: string): string;
  /** `<runDir>/<name>`, created empty (a RUNNER_TEMP or work directory). */
  mkdir(name: string): string;
  /** Commits `tree` as a build chained on `parent` (the real build branch
   * is append-only, and copier versions these refs by commit count) and
   * tags it `<namespace>/<name>`. */
  commitBuildTree(tree: string, name: BuildTagName, parent: Build | null): Build;
  /** A copy of the fresh build's tree to perturb into another build. */
  copyNewTree(name: string): string;
}

export interface UpgradePathHarness {
  /** The file's fixture, built on first use (both builds committed). */
  fixture(): Fixture;
}

/** Call at a test file's top level: binds the scratch and the namespace
 * cleanup to that file's afterAll. The namespace is recorded the moment it
 * is opened, before its first ref, so a fixture whose build fails halfway
 * still has its tags removed. */
export function upgradePathHarness(): UpgradePathHarness {
  const temp = tempDirs();
  let namespace: string | null = null;
  let built: Fixture | null = null;
  afterAll(() => {
    if (namespace === null) return;
    // Build tags first, the owner record last: a cleanup that dies halfway
    // leaves a namespace the sweeper can still attribute.
    const failures: string[] = [];
    for (const name of [...BUILD_TAG_NAMES, RUN_TAG_NAME]) {
      const tag = `${namespace}/${name}`;
      if (
        tryRun(["git", "-C", REPO_ROOT, "rev-parse", "-q", "--verify", `refs/tags/${tag}`])
          .exitCode !== 0
      )
        continue;
      const deleted = tryRun(["git", "-C", REPO_ROOT, "tag", "-d", tag]);
      if (deleted.exitCode !== 0) failures.push(`${tag}: ${deleted.stderr.trim()}`);
    }
    if (failures.length > 0)
      throw new Error(`build tags could not be removed:\n${failures.join("\n")}`);
  });
  return {
    fixture() {
      if (built === null) {
        const opened = openNamespace(temp);
        namespace = opened.namespace;
        built = buildFixture(temp, opened);
      }
      return built;
    },
  };
}

interface Namespace {
  readonly runDir: string;
  readonly namespace: string;
}

/** The run's fixture directory and ref namespace, with the owner record
 * as the namespace's FIRST ref: the sweeper deletes a namespace only when
 * this pid is dead on this host. */
function openNamespace(temp: TempDirs): Namespace {
  const runDir = temp.dir(RUN_DIR_PREFIX);
  // branch_tree.ts refuses a destination beneath the repository, so a
  // TMPDIR inside the checkout fails here, before any namespace exists.
  if (runDir === REPO_ROOT || runDir.startsWith(`${REPO_ROOT}/`)) {
    throw new Error(`TMPDIR resolves inside the repo checkout (${runDir}); point it outside`);
  }
  const namespace = `ci-build-${basename(runDir).slice(RUN_DIR_PREFIX.length)}`;
  git(
    REPO_ROOT,
    ...CI_IDENTITY,
    "tag",
    "-a",
    `${namespace}/${RUN_TAG_NAME}`,
    "HEAD",
    "-m",
    `pid=${process.pid} host=${hostname()} started=${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")} dir=${runDir}`,
  );
  return { runDir, namespace };
}

function buildFixture(temp: TempDirs, { runDir, namespace }: Namespace): Fixture {
  const path = (name: string) => join(runDir, name);
  const mkdir = (name: string) => {
    mkdirSync(path(name), { recursive: true });
    return path(name);
  };
  const commitBuildTree = (tree: string, name: BuildTagName, parent: Build | null): Build => {
    const tag = `${namespace}/${name}`;
    const index = path(`index-${name}`);
    const indexed = { env: { GIT_INDEX_FILE: index } };
    run(["git", "-C", REPO_ROOT, `--work-tree=${tree}`, "add", "-A"], indexed);
    const treeSha = run(["git", "-C", REPO_ROOT, "write-tree"], indexed).trim();
    const sha = git(
      REPO_ROOT,
      ...CI_IDENTITY,
      "commit-tree",
      treeSha,
      ...(parent === null ? [] : ["-p", parent.sha]),
      "-m",
      `build(ci): ${tag}`,
    );
    git(REPO_ROOT, "tag", tag, sha);
    return { tag, sha, tree };
  };
  const oldTree = path("old-tree");
  assembleBuildTree(oldTree);
  modelOldBuild(oldTree);
  const old = commitBuildTree(oldTree, "old", null);
  const newTree = path("next");
  assembleBuildTree(newTree);
  const fresh = commitBuildTree(newTree, "new", old);
  return {
    temp,
    runDir,
    namespace,
    old,
    new: fresh,
    path,
    mkdir,
    commitBuildTree,
    copyNewTree(name) {
      const copy = path(name);
      cpSync(newTree, copy, { recursive: true, verbatimSymlinks: true });
      return copy;
    },
  };
}

function assembleBuildTree(dest: string): void {
  run(["bun", ".github/scripts/build-branches/branch_tree.ts", "--dest", dest]);
}

/** The synthetic old build: the current templates assembled by the current
 * tooling, minus each pending rung (its pre-transition shape planted
 * instead), plus the shapes the legs model - files the new build no longer
 * renders, files it renders for the first time, and a managed workflow on
 * a retired interface. */
function modelOldBuild(tree: string): void {
  const manifestTemplate = join(tree, MANIFEST_TEMPLATE);
  // Before the community health files moved to the account's .github
  // defaults: a managed CODE_OF_CONDUCT.md and a split CONTRIBUTING.md
  // rendered on public repositories only, and an issue-form starter under
  // the _skip_if_exists pattern rendered with the issue-templates module
  // (the pre-move root SECURITY.md is m0001's model). Each file's gate is
  // modelled as the old template generated it: an _exclude entry plus a
  // manifest gate. Retirement plus the removed-splits hold carry the
  // transition; no rung.
  const form = ".github/ISSUE_TEMPLATE/bug_report.yml";
  const gated: { rel: string; landed: string; content: string; entry: string; gate: string }[] = [
    {
      rel: ".github/CODE_OF_CONDUCT.md.jinja",
      landed: ".github/CODE_OF_CONDUCT.md",
      content:
        "<!-- This file is managed by {{ github_username }}/repo-platform. -->\n# Code of conduct\n",
      entry: '".github/CODE_OF_CONDUCT.md": {"class": "managed", "hash": null}',
      gate: "not private",
    },
    {
      rel: "CONTRIBUTING.md.jinja",
      landed: "CONTRIBUTING.md",
      content: `${HTML_MARKERS.begin}\n# Contributing\n${HTML_MARKERS.end}\n`,
      entry: htmlSplitEntry("CONTRIBUTING.md"),
      gate: "not private",
    },
    {
      rel: form,
      landed: form,
      content: "name: Bug report\ndescription: Something isn't working\nbody: []\n",
      entry: `"${form}": {"class": "starter"}`,
      gate: selected("issue-templates"),
    },
  ];
  for (const file of gated) {
    plantTemplateFile(tree, file.rel, file.content, file.entry);
    gateManifestEntry(tree, file.landed, file.gate);
  }
  // The generator anchors a root-level exclude with a leading slash.
  const excludePattern = (landed: string): string => (landed.includes("/") ? landed : `/${landed}`);
  editText(join(tree, "copier.yml"), (text) =>
    insertAfterLine(
      insertAfterLine(
        text,
        (line) => line === "_skip_if_exists:",
        [`  - ${dirname(form)}/*.yml`],
        "model the old fixture's issue-form skip pattern",
      ),
      (line) => line.startsWith("  # BEGIN GENERATED: conditional-excludes"),
      gated.map(
        (file) => `  - "{% if not (${file.gate}) %}${excludePattern(file.landed)}{% endif %}"`,
      ),
      "model the old fixture's community health file gates",
    ),
  );
  for (const [id, rung] of Object.entries(PENDING_RUNGS)) {
    const rungFile = join(tree, "migrations", `${id}.ts`);
    if (!existsSync(rungFile)) {
      throw new Error(
        `the fresh build tree carries no rung file for ${id} (is the rung still on the ladder?)`,
      );
    }
    rmSync(rungFile);
    rung.model(tree);
  }
  // A template-managed file the new build does not render: the retirement
  // case retired_cleanup.ts exists for.
  writeFileSync(join(tree, "template/.github/retired-sentinel.txt"), "retired sentinel\n");
  // Before the Copilot gate moved into the ruleset: a managed
  // rerun-copilot-gate.yml the new build renders no more (plain, not
  // jinja: copier copies it verbatim, which is all the retirement needs).
  writeFileSync(
    join(tree, "template/.github/workflows/rerun-copilot-gate.yml"),
    "name: Rerun Copilot Gate\non: [pull_request_review]\n",
  );
  // Before the release pipeline moved into the fleet workflows: a managed
  // release.yml the new build renders no more, retired by the cleanup.
  writeFileSync(
    join(tree, "template/.github/workflows/release.yml"),
    "name: Release\non: [workflow_call]\n",
  );
  // Before pr-title became its own natively-required workflow (the check
  // was a fleet-ci job) and before the post-green starter existed: the
  // update must land the one and seed the other, each with its manifest
  // append line.
  for (const workflow of ["pr-title.yml", "post-green.yml"]) {
    rmSync(join(tree, "template/.github/workflows", `${workflow}.jinja`));
    editText(manifestTemplate, (text) => dropLinesContaining(text, `workflows/${workflow}`));
  }
  // Before the versioned-pages cutover: pages.yml spoke reusable-pages'
  // retired production/staging interface. Plain content by design - the
  // era's copier questions are gone, so the retired values ride verbatim.
  writeFileSync(join(tree, "template/.github/workflows/pages.yml.jinja"), LEGACY_PAGES_TEMPLATE);
}

const LEGACY_PAGES_TEMPLATE = `# This file is managed by {{ github_username }}/repo-platform.
# Local edits may be replaced during template updates.
name: Pages

on:
  push:
    branches: [main]
  release:
    types: [published]
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  deploy:
    uses: {{ github_username }}/repo-platform/.github/workflows/reusable-pages.yml@main
    with:
      setup: {{ pages_setup }}
      install_command: {{ pages_install_command | tojson }}
      build_command: {{ pages_build_command | tojson }}
      dist_dir: {{ pages_dist_dir | tojson }}
      production: main
      staging: false
    permissions:
      contents: read
      pages: write
      id-token: write
`;

// ------------------------------------------------------- the sync's scripts

/** The env reusable-template-sync hands its scripts. */
export interface SyncEnv {
  TARGET_DIR: string;
  TARGET_REF: string;
  RUNNER_TEMP: string;
  MODULES?: string;
  PRIVATE?: "true" | "false";
  DESCRIPTION?: string;
  OLD_SHA?: string;
  SRC_PATH?: string;
  HOMEPAGE?: string;
  TOPICS?: string;
  RECOVER?: string;
  PLATFORM_DIR?: string;
}

const SYNC_SCRIPTS = join(REPO_ROOT, ".github/scripts/sync");

/** The env a sync script call carries: the workflow's variables plus anything else the step sets. */
export type ScriptEnv = Partial<SyncEnv> & Record<string, string | undefined>;

/** `bun .github/scripts/sync/<name>.ts` under `env`, throwing on failure. */
export function syncScript(name: string, env: ScriptEnv, args: string[] = []): string {
  return run(["bun", join(SYNC_SCRIPTS, `${name}.ts`), ...args], {
    env,
    timeoutMs: COPIER_TIMEOUT_MS,
  });
}

/** The same, never throwing on a nonzero exit. */
export function trySyncScript(
  name: string,
  env: ScriptEnv,
  args: string[] = [],
): BoundedSpawnResult {
  return tryRun(["bun", join(SYNC_SCRIPTS, `${name}.ts`), ...args], {
    env,
    timeoutMs: COPIER_TIMEOUT_MS,
  });
}

/** Module selection as the sync computes it: the target's declaration
 * filtered against the new template's choices. modules.ts reports its
 * failures on stdout, so both streams ride the error. */
export function selectModules(repoFile: string, templateCopier: string): string {
  return syncScript("modules", {}, [
    "--repo-file",
    repoFile,
    "--template-copier",
    templateCopier,
  ]).trimEnd();
}

/** The snapshots the retired-file cleanup reads from RUNNER_TEMP. */
export function snapshotCopierYml(runnerTemp: string, oldRef: string, newRef: string): void {
  writeFileSync(join(runnerTemp, "copier-old.yml"), git(REPO_ROOT, "show", `${oldRef}:copier.yml`));
  writeFileSync(join(runnerTemp, "copier-new.yml"), git(REPO_ROOT, "show", `${newRef}:copier.yml`));
}

/** The split-file rebuild's argv for a target and its RUNNER_TEMP. */
export function preserveLocalContentArgs(target: string, runnerTemp: string): string[] {
  return [
    "--summary",
    join(runnerTemp, "local-carryover.md"),
    "--root",
    target,
    "--needs-review",
    join(runnerTemp, "carry-review.txt"),
    "--rebuilt-paths",
    join(runnerTemp, "split-rebuilt-paths.txt"),
    "--render-dir",
    join(runnerTemp, "render-new"),
    "--old-render-dir",
    join(runnerTemp, "render-old"),
  ];
}

/** The conflict resolver's argv, skipping the rebuilt split files when a rebuild ran. */
export function resolveConflictsArgs(
  target: string,
  runnerTemp: string,
  skipRebuilt: boolean,
): string[] {
  return [
    "--summary",
    join(runnerTemp, "dropped-local-hunks.md"),
    "--root",
    target,
    ...(skipRebuilt ? ["--skip", join(runnerTemp, "split-rebuilt-paths.txt")] : []),
  ];
}

export function stampManifest(root: string): void {
  run(["bun", join(REPO_ROOT, "actions/shared/stamp_manifest.ts"), "--root", root]);
}

/** The validator over a rendered project (exit 0 or throw). Its action's
 * dependencies are the repository bootstrap's (bun run check, the ci.yml
 * job's install step), not this harness's. */
export function validateGenerated(root: string): void {
  run(
    [
      "bun",
      join(REPO_ROOT, "actions/validate-template-report/validator/validate_generated_files.ts"),
      root,
    ],
    { timeoutMs: COPIER_TIMEOUT_MS },
  );
}

// ------------------------------------------------------------------ readers

export function readText(path: string): string {
  return readFileSync(path, "utf-8");
}

export function readYaml(path: string): unknown {
  return parseYaml(readText(path));
}

export function readJson(path: string): unknown {
  return JSON.parse(readText(path));
}

/** Whether a file is present at all, a dangling symlink included. */
export function lexists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** `path` exists and is empty (a report that was written with nothing to say). */
export function isEmptyFile(path: string): boolean {
  return existsSync(path) && readFileSync(path).byteLength === 0;
}

export const ANSWERS_FILE = ".github/.copier-answers.yml";
export const MANIFEST_FILE = ".github/repo-platform-manifest.json";

/** The recorded answers of a project's working tree. */
export function answersOf(project: string): Record<string, unknown> {
  return readYaml(join(project, ANSWERS_FILE)) as Record<string, unknown>;
}

/** The recorded answers at HEAD. */
export function answersAtHead(project: string): Record<string, unknown> {
  return parseYaml(git(project, "show", `HEAD:${ANSWERS_FILE}`)) as Record<string, unknown>;
}

/** The recorded `_commit` as the production readers see it: the stamp hook
 * quotes an all-digit sha (PyYAML would read it as an integer), so the
 * string value is the sha either way. */
export function recordedCommit(answers: Record<string, unknown>): string {
  return String(answers._commit);
}

export function recordedSrcPath(answers: Record<string, unknown>): string {
  const path = answers._src_path;
  if (typeof path !== "string" || path === "")
    throw new Error(`${ANSWERS_FILE} records no _src_path`);
  return path;
}

export interface ManifestEntry {
  class: string;
  hash?: string | null;
  commit?: string;
}

/** The ownership manifest's entry for `path`, or undefined when absent. */
export function manifestEntry(project: string, path: string): ManifestEntry | undefined {
  const manifest = readJson(join(project, MANIFEST_FILE)) as {
    files: Record<string, ManifestEntry>;
  };
  return manifest.files[path];
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** The retired-paths list retired_cleanup.ts wrote under RUNNER_TEMP. */
export function retiredPaths(runnerTemp: string): string[] {
  return readJson(join(runnerTemp, "retired-paths.json")) as string[];
}

/** The paths retired_cleanup.ts actually removed. */
export function removedPaths(runnerTemp: string): string[] {
  return linesOf(readText(join(runnerTemp, "removed-paths.txt")));
}

/** The one commit's author, email, and subject: `%an <%ae> %s`. */
export function commitIdentityLine(project: string, ref = "HEAD"): string {
  return git(project, "log", "-1", "--format=%an <%ae> %s", ref);
}

/** The one commit's `--name-status` lines. */
export function commitNameStatus(project: string, ref = "HEAD"): string[] {
  return linesOf(`${git(project, "log", "-1", "--name-status", "--format=", ref)}\n`);
}

/** Every regular file under `root` (the .git directory skipped) that
 * contains `needle`. */
export function filesContaining(root: string, needle: string): string[] {
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && readText(full).includes(needle))
        hits.push(full.slice(root.length + 1));
    }
  };
  walk(root);
  return hits;
}

/** Every file under `root` whose name ends in `suffix`. */
export function filesNamed(root: string, suffix: string): string[] {
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(suffix)) hits.push(full.slice(root.length + 1));
    }
  };
  walk(root);
  return hits;
}

/** No copier leftovers in a project: neither inline conflict markers nor .rej files. */
export function expectNoCopierLeftovers(project: string): void {
  expect(filesContaining(project, COPIER_CONFLICT_MARKER)).toEqual([]);
  expect(filesNamed(project, ".rej")).toEqual([]);
}

/** A rendered workflow's job block, parsed. */
export function workflowJob(path: string, job: string): Record<string, unknown> | undefined {
  const workflow = readYaml(path) as { jobs?: Record<string, Record<string, unknown>> };
  return workflow.jobs?.[job];
}

/** A rendered workflow job's `with:` inputs; a workflow without the job throws. */
export function workflowJobWith(path: string, job: string): Record<string, unknown> {
  const block = workflowJob(path, job);
  if (block === undefined) throw new Error(`${path} renders no job '${job}'`);
  return (block.with ?? {}) as Record<string, unknown>;
}

/** A file's text, or "" when it is absent (a report that may not have been written). */
export function textOrEmpty(path: string): string {
  return existsSync(path) ? readText(path) : "";
}

/** The fleet LICENSE template rendered with the copier defaults. If the
 * template gains a variable this oracle does not substitute, it fails
 * HERE naming the leftover, not later as a confusing mismatch. */
export function renderedFleetLicense(): string {
  const rendered = readText(
    join(
      REPO_ROOT,
      "templates/base/{% if 'custom-license' not in modules %}LICENSE.md{% endif %}.jinja",
    ),
  )
    .replaceAll("{{ copyright_holder }}", "Vivswan Shah (https://github.com/Vivswan)")
    .replaceAll("{{ github_username }}", "Vivswan");
  const leftover = /\{\{[^}]*\}\}|\{%[^}]*%\}|\{\{|\{%/.exec(rendered);
  if (leftover !== null) {
    throw new Error(
      `renderedFleetLicense left an unrendered template expression (${leftover[0]}); teach this oracle the substitution for it`,
    );
  }
  return rendered;
}

export function appendText(path: string, text: string): void {
  writeFileSync(path, readText(path) + text);
}

export function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

// ------------------------------------------------------------ the gh stub

/** A `gh` on PATH that records its argv and serves the two reads
 * open_pr.ts makes, so open_pr's body and arm decisions are observable
 * without a network. The body is the file the create call names with
 * --body-file. */
export function ghStub(dir: string): { bin: string; calls: string } {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const calls = join(dir, "gh-calls.txt");
  writeFileSync(
    join(bin, "gh"),
    [
      "#!/usr/bin/env bun",
      'const { appendFileSync } = require("node:fs");',
      "const args = process.argv.slice(2);",
      'appendFileSync(process.env.GH_CALLS, `gh ${args.join(" ")}\\n`);',
      "const verb = `${args[0]} ${args[1]}`;",
      'if (verb === "pr create" || verb === "pr view") console.log("https://github.com/o/r/pull/1");',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return { bin, calls };
}

/** open_pr.ts under the stub with the sync step's env; every report input
 * defaults to an empty file. Returns its stdout. */
export function openPr(
  runnerTemp: string,
  stub: { bin: string; calls: string },
  target: string,
  reports: Partial<
    Record<"CARRIED_FILE" | "CARRY_REVIEW_FILE" | "REMOVED_PATHS_FILE", string>
  > = {},
): string {
  const empty = join(runnerTemp, "empty.txt");
  writeFileSync(empty, "");
  writeFileSync(join(runnerTemp, "old_commit.txt"), "build@old\n");
  return syncScript("open_pr", {
    GH_CALLS: stub.calls,
    PATH: `${stub.bin}:${process.env.PATH ?? ""}`,
    TARGET: target,
    RUNNER_TEMP: runnerTemp,
    GITHUB_REPOSITORY: "Vivswan/repo-platform",
    GITHUB_OUTPUT: join(runnerTemp, "gh-output.txt"),
    BRANCH: "automation/repo-platform",
    BASE_BRANCH: "main",
    DISPLAY: "build@new",
    RECOVER: "",
    VALIDATION: "passed",
    HIDE_DETAILS: "",
    DRIFT_FILE: empty,
    CARRIED_FILE: empty,
    CARRY_REVIEW_FILE: empty,
    REMOVED_PATHS_FILE: empty,
    MANIFEST_LICENSE_FILE: empty,
    SUMMARY_FILE: empty,
    ...reports,
  });
}
