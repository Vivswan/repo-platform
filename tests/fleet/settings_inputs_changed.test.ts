// The settings-inputs leg's decision, proven against real git: the roster
// (grammar, owner-derived data inputs, the scripts' import closure), the
// base resolution (the build tip's stamped source over the push's own
// `before`, the coalescing case that motivates it, the tip already
// stamped with the judged sha, the no-stamp fallbacks), the range diff
// (multi-commit pushes, a two-parent merge, a rename away from a watched
// path), the refusals, and the GITHUB_OUTPUT line settings-fleet reads.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  SETTINGS_INPUT_PATHS,
  settingsInputsTouched,
} from "../../.github/scripts/fleet/settings_inputs_changed.ts";
import { commitStampWrite } from "../../.github/scripts/shared/commit_stamp.ts";
import { SETTINGS_LAYER_ORDER } from "../../scripts/lib/module_manifests.ts";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { fixtureGit } from "../shared/fixture_git";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();

const ZEROS = "0".repeat(40);
// git's empty tree, the base a branch-creating push is diffed from.
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

describe("settingsInputsTouched", () => {
  test("the path grammar: * stays inside a segment, ** crosses segments, the rest is literal", () => {
    expect(
      settingsInputsTouched([
        "README.md",
        ".github/settings.yml",
        ".github/settings-override.yml",
        ".github/scripts/fleet/settings_inputs_changed.ts",
        ".github/scripts/shared/deep/nested.ts",
        ".github/scripts/sync/modules.ts",
        ".github/scripts/sync/other.ts",
        "templates/uv/settings-public.yml",
        "templates/rust/settings-private.yml",
        "templates/uv/nested/settings.yml",
        "templates/uv/module.yml",
        "scripts/lib/module_manifests.ts",
        "scripts/lib/module_manifests.test.ts",
        ".repo-platform-answers.yml",
        "repos.yml",
        "docs/settings.md",
      ]),
    ).toEqual([
      ".github/settings.yml",
      ".github/settings-override.yml",
      ".github/scripts/fleet/settings_inputs_changed.ts",
      ".github/scripts/shared/deep/nested.ts",
      ".github/scripts/sync/modules.ts",
      "templates/uv/settings-public.yml",
      "templates/rust/settings-private.yml",
      "templates/uv/module.yml",
      "scripts/lib/module_manifests.ts",
      ".repo-platform-answers.yml",
      "repos.yml",
    ]);
  });

  test("every literal entry names a file this repository carries - a typo or a retired file goes red here", () => {
    const root = join(import.meta.dir, "../..");
    const literals = SETTINGS_INPUT_PATHS.filter((pattern) => !pattern.includes("*"));
    expect(literals.length).toBeGreaterThan(0);
    expect(literals.filter((rel) => !existsSync(join(root, rel)))).toEqual([]);
  });

  test("every data input the owners name is on the roster - dropping a layer or the registry goes red here", () => {
    // Derived from the owners, not restated: the module layer filenames
    // from module_manifests.ts, and every settings-layer, registry, and
    // operator-answers path the renderer, the merger, the registry, and
    // the writer workflow spell out. Plus the writer workflow itself and
    // the post-green legs that call it.
    const root = join(import.meta.dir, "../..");
    const owners = [
      ".github/scripts/fleet/render_managed_settings.ts",
      ".github/scripts/fleet/merge_settings_layers.ts",
      ".github/scripts/fleet/repos_registry.ts",
      ".github/workflows/settings-repos.yml",
    ];
    const named = new Set<string>();
    for (const rel of owners) {
      for (const match of readFileSync(join(root, rel), "utf-8").matchAll(
        /(?:\.github\/settings[A-Za-z-]*|\.repo-platform-answers|repos)\.yml/g,
      )) {
        named.add(match[0]);
      }
    }
    for (const layer of SETTINGS_LAYER_ORDER) named.add(`templates/uv/${layer}`);
    named.add("templates/uv/module.yml");
    named.add(".github/workflows/settings-repos.yml");
    named.add(".github/workflows/post-green.yml");
    expect([...named].sort()).toEqual(
      [
        ".github/settings.yml",
        ".github/settings-baseline.yml",
        ".github/settings-override.yml",
        ".github/settings-private.yml",
        ".github/settings-public.yml",
        ".github/workflows/post-green.yml",
        ".github/workflows/settings-repos.yml",
        ".repo-platform-answers.yml",
        "repos.yml",
        "templates/uv/module.yml",
        "templates/uv/settings-private.yml",
        "templates/uv/settings-public.yml",
        "templates/uv/settings.yml",
      ].sort(),
    );
    expect([...named].filter((rel) => settingsInputsTouched([rel]).length === 0)).toEqual([]);
  });

  test("the whole import closure of the apply's scripts is on the roster - a new out-of-directory import cannot wait for the nightly heal", () => {
    // Seeded from every script settings-repos.yml itself runs plus every
    // fleet/ script (the selection spawns its stages there rather than
    // importing them); whatever those import, transitively, is a settings
    // input too. The roster is authored, so this closure walk - bun's own
    // import scanner, so side-effect and dynamic imports count like
    // static ones - is what keeps it honest.
    const root = join(import.meta.dir, "../..");
    const fleetDir = join(root, ".github/scripts/fleet");
    const workflow = readFileSync(join(root, ".github/workflows/settings-repos.yml"), "utf-8");
    const invoked = [...workflow.matchAll(/\bbun (\.github\/scripts\/[A-Za-z0-9_./-]+\.ts)/g)].map(
      (match) => join(root, match[1]),
    );
    expect(invoked.length).toBeGreaterThan(5);
    const closure = new Set<string>();
    const walk = (file: string) => {
      const rel = relative(root, file);
      if (closure.has(rel)) return;
      closure.add(rel);
      for (const { path } of relativeImports(readFileSync(file, "utf-8"))) {
        const target = resolve(dirname(file), path);
        walk(target.endsWith(".ts") ? target : `${target}.ts`);
      }
    };
    for (const file of invoked) walk(file);
    for (const name of readdirSync(fleetDir)) {
      if (name.endsWith(".ts")) walk(join(fleetDir, name));
    }
    expect(closure.size).toBeGreaterThan(20);
    const uncovered = [...closure].filter((rel) => settingsInputsTouched([rel]).length === 0);
    expect(uncovered).toEqual([]);
  });

  test("the closure walk's scanner sees every runtime import form and ignores packages and type-only imports", () => {
    // The control for the closure test: a scanner that missed a form
    // would pass a shorter closure in silence. A type-only import is
    // erased at runtime, so it is no settings input.
    const source = [
      'import { a } from "./a.ts";',
      'import type { B } from "../shared/b.ts";',
      'import "./side_effect.ts";',
      'const c = await import("./c.ts");',
      'import { parse } from "yaml";',
      'import { z } from "zod";',
    ].join("\n");
    expect(relativeImports(source).map((entry) => entry.path)).toEqual([
      "./a.ts",
      "./side_effect.ts",
      "./c.ts",
    ]);
  });
});

/** The relative runtime imports of one TypeScript source, every form
 *  (static, side-effect, dynamic), package and type-only imports
 *  dropped. */
function relativeImports(source: string): { path: string }[] {
  // The scripts open with a shebang, which the transpiler does not take.
  return new Bun.Transpiler({ loader: "ts" })
    .scanImports(source.replace(/^#!.*\n/, ""))
    .filter(({ path }) => path.startsWith("."));
}

describe("main", () => {
  const script = join(import.meta.dir, "../../.github/scripts/fleet/settings_inputs_changed.ts");
  const root = temp.dir("settings-inputs-changed-");

  function git(cwd: string, args: string[]): string {
    return fixtureGit(cwd, ["-c", "user.name=t", "-c", "user.email=t@x.test", ...args]);
  }

  function commit(cwd: string, files: Record<string, string>, message: string): string {
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(dirname(join(cwd, rel)), { recursive: true });
      writeFileSync(join(cwd, rel), content);
    }
    git(cwd, ["add", "-A"]);
    git(cwd, ["commit", "-q", "-m", message]);
    return git(cwd, ["rev-parse", "HEAD"]);
  }

  // The authoring repo: main's history plus a side branch, the fixture
  // every clone below is taken from. The leg's checkout sees the build
  // branch as refs/remotes/origin/build, so each scenario is a clone of a
  // bare origin carrying (or lacking) that branch.
  const source = join(root, "source");
  mkdirSync(source);
  git(source, ["init", "-q", "-b", "main"]);
  const rootCommit = commit(source, { "README.md": "hello\n" }, "root");
  const docsA = commit(source, { "docs/a.md": "# a\n" }, "docs a");
  const settingsB = commit(source, { ".github/settings.yml": "repository: {}\n" }, "settings b");
  const docsC = commit(source, { "docs/c.md": "# c\n" }, "docs c");
  const moduleCommit = commit(source, { "templates/uv/module.yml": "name: uv\n" }, "module");
  git(source, ["mv", ".github/settings.yml", "docs/old-settings.yml"]);
  git(source, ["commit", "-q", "-m", "rename away"]);
  const renameCommit = git(source, ["rev-parse", "HEAD"]);
  // A two-parent merge whose SECOND parent carries the watched change.
  git(source, ["checkout", "-q", "-b", "feature", renameCommit]);
  commit(source, { "templates/uv/settings.yml": "labels: []\n" }, "feature layer");
  git(source, ["checkout", "-q", "main"]);
  git(source, ["merge", "-q", "--no-ff", "-m", "merge feature", "feature"]);
  const mergeCommit = git(source, ["rev-parse", "HEAD"]);
  // A side branch off the root: a base that is no ancestor of main's tip.
  git(source, ["checkout", "-q", "-b", "side", rootCommit]);
  const sideCommit = commit(source, { "side.txt": "s\n" }, "side");
  git(source, ["checkout", "-q", "main"]);

  /** A clone whose origin carries main plus, when `stamps` is given, a
   *  build branch of one orphan commit per stamp (oldest first), each
   *  stamped like publish.ts stamps. */
  function cloneWithBuild(name: string, stamps: string[] | null): string {
    const bare = join(root, `${name}.git`);
    git(root, ["clone", "-q", "--bare", source, bare]);
    if (stamps !== null) {
      const scratch = join(root, `${name}-build`);
      git(root, ["clone", "-q", bare, scratch]);
      git(scratch, ["checkout", "-q", "--orphan", "build"]);
      git(scratch, ["rm", "-rfq", "."]);
      for (const [index, stamped] of stamps.entries()) {
        writeFileSync(join(scratch, "tree.txt"), `${index}\n`);
        git(scratch, ["add", "-A"]);
        // An empty entry is an unstamped build commit.
        const stamp =
          stamped === "" ? "" : `\n\n${commitStampWrite("https://x.test", "o/r", stamped)}`;
        git(scratch, ["commit", "-q", "-m", `build${stamp}\nrun: https://x.test/run`]);
      }
      git(scratch, ["push", "-q", "origin", "build"]);
    }
    const clone = join(root, name);
    git(root, ["clone", "-q", bare, clone]);
    return clone;
  }

  const unpublished = cloneWithBuild("unpublished", null);
  const publishedA = cloneWithBuild("published-a", [docsA]);
  const publishedAC = cloneWithBuild("published-a-c", [docsA, docsC]);
  const tamperedStamp = cloneWithBuild("tampered", [sideCommit]);
  // A long unstamped run above the one real stamp: the walk must reach it.
  const deepStamp = cloneWithBuild("deep", [docsA, ...Array.from({ length: 30 }, () => "")]);
  const stampless = cloneWithBuild("stampless", [""]);

  function run(
    cwd: string,
    sha: string,
    before: string,
  ): { exitCode: number; stdout: string; output: string } {
    const outputFile = join(root, `out-${Bun.hash(cwd + sha + before).toString(16)}.txt`);
    writeFileSync(outputFile, "");
    const proc = boundedSpawnSync(["bun", script], {
      cwd,
      env: { ...process.env, SOURCE_SHA: sha, BEFORE_SHA: before, GITHUB_OUTPUT: outputFile },
    });
    return { ...proc, output: readFileSync(outputFile, "utf-8") };
  }

  const short = (sha: string) => sha.slice(0, 12);

  test("the coalescing case: a superseded settings push is covered from the stamped base, not from the push's own before", () => {
    // ci.yml keeps one pending main run: push A ran (its build stamped
    // A), settings push B was pending, docs push C replaced it. C's own
    // range B..C misses B's layer; the stamped base A..C carries it.
    const stamped = run(publishedA, docsC, settingsB);
    expect(stamped.exitCode).toBe(0);
    expect(stamped.output).toBe("changed=true\n");
    expect(stamped.stdout).toContain(
      `::notice::${short(docsA)}..${short(docsC)} touched settings inputs (.github/settings.yml)`,
    );
    expect(stamped.stdout).not.toContain("nothing published before this run");
    // The old logic, shown red: the same run against an origin with no
    // build branch falls back to B..C and applies nothing.
    const pushOnly = run(unpublished, docsC, settingsB);
    expect(pushOnly.exitCode).toBe(0);
    expect(pushOnly.output).toBe("changed=false\n");
    expect(pushOnly.stdout).toContain(
      `::notice::no build stamp older than ${short(docsC)} exists (nothing published before this run); diffing the push alone, from ${short(settingsB)}`,
    );
    expect(pushOnly.stdout).toContain(
      `::notice::${short(settingsB)}..${short(docsC)} touched no settings input`,
    );
  });

  test.each([
    {
      reason: "a build tip already stamped with the judged sha (this run's publish landed first)",
      cwd: publishedAC,
    },
    {
      reason: "thirty unstamped build commits above the one real stamp (no walk bound)",
      cwd: deepStamp,
    },
  ])("$reason still reaches the older stamp", ({ cwd }) => {
    const result = run(cwd, docsC, settingsB);
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("changed=true\n");
    expect(result.stdout).toContain(
      `::notice::${short(docsA)}..${short(docsC)} touched settings inputs (.github/settings.yml)`,
    );
    expect(result.stdout).not.toContain("nothing published before this run");
  });

  test.each([
    {
      reason: "a one-commit push touching only an unlisted path",
      sha: docsA,
      before: rootCommit,
      output: "changed=false\n",
      stdout: `${short(rootCommit)}..${short(docsA)} touched no settings input`,
    },
    {
      reason: "a one-commit push touching a segment-globbed manifest path",
      sha: moduleCommit,
      before: docsC,
      output: "changed=true\n",
      stdout: `${short(docsC)}..${short(moduleCommit)} touched settings inputs (templates/uv/module.yml)`,
    },
    {
      reason: "a multi-commit push whose settings change sits below a docs-only tip",
      sha: docsC,
      before: docsA,
      output: "changed=true\n",
      stdout: `${short(docsA)}..${short(docsC)} touched settings inputs (.github/settings.yml)`,
    },
    {
      reason: "a layer renamed away from its watched path counts as a change to that path",
      sha: renameCommit,
      before: moduleCommit,
      output: "changed=true\n",
      stdout: `${short(moduleCommit)}..${short(renameCommit)} touched settings inputs (.github/settings.yml)`,
    },
    {
      reason:
        "a two-parent merge whose second parent changes a watched path, diffed from the prior tip",
      sha: mergeCommit,
      before: renameCommit,
      output: "changed=true\n",
      stdout: `${short(renameCommit)}..${short(mergeCommit)} touched settings inputs (templates/uv/settings.yml)`,
    },
    {
      reason:
        "a branch-creating push (all-zero base) without a listed file reads against the empty tree",
      sha: rootCommit,
      before: ZEROS,
      output: "changed=false\n",
      stdout: `${short(EMPTY_TREE)}..${short(rootCommit)} touched no settings input`,
    },
    {
      reason: "a branch-creating push carrying a layer counts every file as changed",
      sha: settingsB,
      before: ZEROS,
      output: "changed=true\n",
      stdout: `${short(EMPTY_TREE)}..${short(settingsB)} touched settings inputs (.github/settings.yml)`,
    },
  ])("without a build stamp, $reason", ({ sha, before, output, stdout }) => {
    const result = run(unpublished, sha, before);
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe(output);
    expect(result.stdout).toContain("nothing published before this run");
    expect(result.stdout).toContain(`::notice::${stdout}`);
  });

  test.each([
    {
      reason:
        "a push base that is no ancestor of the judged commit (a foreign or force-pushed payload)",
      cwd: unpublished,
      sha: moduleCommit,
      before: sideCommit,
      error:
        `the push base ${short(sideCommit)} is not an ancestor of ${short(moduleCommit)}: the range means ` +
        "nothing (a force-push, a foreign payload, or a tampered build stamp) - publish a green main " +
        "commit by hand (dispatch post-green.yml with sha=<green main commit>) to reset the base",
    },
    {
      reason: "a build stamp naming a commit off main (tampered), even with a sound before",
      cwd: tamperedStamp,
      sha: moduleCommit,
      before: docsC,
      error: `the build tip's stamped source ${short(sideCommit)} is not an ancestor of ${short(moduleCommit)}`,
    },
    {
      reason:
        "a build branch with no stamp anywhere (not published by publish.ts), never a silent fallback",
      cwd: stampless,
      sha: moduleCommit,
      before: docsC,
      error: "the build branch carries no stamped source in its whole history",
    },
    {
      reason: "a push base equal to the judged commit (an empty range)",
      cwd: unpublished,
      sha: moduleCommit,
      before: moduleCommit,
      error: `the push base ${short(moduleCommit)} is the judged commit itself: an empty range says nothing about the push`,
    },
    {
      reason: "a truncated judged sha",
      cwd: unpublished,
      sha: moduleCommit.slice(0, 12),
      before: docsC,
      error: "SOURCE_SHA is not a full commit sha",
    },
    {
      reason: "a malformed base",
      cwd: unpublished,
      sha: moduleCommit,
      before: "main",
      error: "BEFORE_SHA is not a full commit sha",
    },
  ])("$reason is refused with no output line", ({ cwd, sha, before, error }) => {
    const result = run(cwd, sha, before);
    expect(result.exitCode).toBe(1);
    expect(result.output).toBe("");
    expect(result.stdout).toContain(`::error::${error}`);
  });

  test("a base the checkout cannot see is refused, never read as a change-free or change-full push", () => {
    // A depth-1 checkout lacks the push base; diffing against a missing
    // commit must fail loudly rather than degrade either way.
    const shallow = join(root, "shallow");
    git(root, ["clone", "-q", "--depth", "1", `file://${source}`, shallow]);
    const result = run(shallow, mergeCommit, renameCommit);
    expect(result.exitCode).toBe(1);
    expect(result.output).toBe("");
    expect(result.stdout).toContain(
      `::error::the push base ${short(renameCommit)} is not in this checkout: fetch the full history`,
    );
  });
});
