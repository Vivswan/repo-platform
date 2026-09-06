import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import {
  actionDirNames,
  assembleBranchTree,
  canonicalize,
  copyActions,
  copyFleetWorkflows,
  destOverlapsRepo,
  EXCLUDED_DIRS,
  FLEET_WORKFLOWS,
  MIGRATIONS_SRC_REL,
  PINNED_SCRIPT_DIRS,
  parseArgs,
  SHARED_DIR,
  TEST_FILE_SUFFIX,
  UsageError,
} from "../../.github/scripts/build-branches/branch_tree";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();

const REPO = "/home/user/repo-platform";
const REPO_ROOT = join(import.meta.dir, "../..");

/** Every path under dir (directories included), symlinks not followed. */
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() && !entry.isSymbolicLink() ? [path, ...walk(path)] : [path];
  });

/** The files under dir as sorted paths relative to it. */
const listing = (dir: string): string[] => {
  const files = (sub: string): string[] =>
    readdirSync(sub, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? files(join(sub, entry.name)) : [join(sub, entry.name)],
    );
  return files(dir)
    .map((path) => relative(dir, path))
    .sort();
};

describe("parseArgs", () => {
  test("exactly one of --dest DIR or --check selects the target", () => {
    expect(parseArgs(["--dest", "/x/tree"])).toEqual({ kind: "dest", dest: "/x/tree" });
    expect(parseArgs(["--check"])).toEqual({ kind: "check" });
  });

  test("every other shape is refused before anything is touched, naming the fault", () => {
    // Both flag orders matter: `--dest --check` once read `--check` as the
    // destination and would have replaced a directory of that name.
    const refused: [string[], string][] = [
      [[], "one of --dest DIR or --check is required"],
      [["--check", "--dest", "/x"], "mutually exclusive"],
      [["--dest", "/x", "--check"], "mutually exclusive"],
      [["--dest", "--check"], "argument --dest: expected one argument"],
      [["--dest"], "argument --dest: expected one argument"],
      [["--dest", "/x", "extra"], "unrecognized argument: extra"],
    ];
    for (const [argv, message] of refused) {
      expect(() => parseArgs(argv)).toThrow(UsageError);
      expect(() => parseArgs(argv)).toThrow(message);
    }
  });
});

describe("destOverlapsRepo", () => {
  // The three clauses of the guard - root, ancestor, descendant - each keep
  // a row, and the false rows pin the edges a naive prefix test gets wrong.
  test.each([
    [REPO, true, "the repository root itself"],
    ["/", true, "the filesystem root is an ancestor ('/' + '/' must not read as '//')"],
    ["/home", true, "a distant ancestor"],
    ["/home/user", true, "the immediate parent"],
    [`${REPO}/template`, true, "a path inside the repository"],
    ["/home/user/repo-platform-scratch", false, "a sibling sharing the name as a prefix"],
    ["/tmp/build-tree", false, "an unrelated path"],
    ["/home/other", false, "a sibling of an ancestor"],
  ])("destOverlapsRepo(%p) is %p: %s", (dest, expected) => {
    expect(destOverlapsRepo(dest, REPO)).toBe(expected);
  });
});

describe("canonicalize", () => {
  test("dereferences a symlinked parent so an alias of the repo still overlaps", () => {
    const root = temp.dir("bt-");
    const repo = join(root, "real", "repo");
    mkdirSync(repo, { recursive: true });
    symlinkSync(join(root, "real"), join(root, "alias"));
    const aliased = canonicalize(join(root, "alias", "repo"));
    expect(destOverlapsRepo(aliased, canonicalize(repo))).toBe(true);
  });

  test("re-attaches a not-yet-existing tail unresolved", () => {
    const root = temp.dir("bt-");
    expect(canonicalize(join(root, "no", "such", "dir"))).toBe(
      join(canonicalize(root), "no", "such", "dir"),
    );
  });
});

// actions/ on the build branch is what lets the fleet pin an action @build:
// sources and dependency manifests ship, every EXCLUDED_DIRS name is cut, and
// a tree with nothing to publish fails here rather than 404ing every fleet run.
function actionsFixture(): string {
  const root = temp.dir("branch-actions-");
  const action = join(root, "actions", "check-typography");
  mkdirSync(join(action, "node_modules", "monaco-editor"), { recursive: true });
  mkdirSync(join(action, "lib"), { recursive: true });
  writeFileSync(join(action, "action.yml"), "name: Check Typography\n");
  writeFileSync(join(action, "package.json"), "{}\n");
  writeFileSync(join(action, "bun.lock"), "\n");
  writeFileSync(join(action, "lib", "helper.ts"), "export {};\n");
  writeFileSync(join(action, "lib", `helper${TEST_FILE_SUFFIX}`), "export {};\n");
  writeFileSync(join(action, "node_modules", "monaco-editor", "index.js"), "module.exports={};\n");
  // One file under every excluded name, spelled here rather than read from
  // EXCLUDED_DIRS so a name dropped from the set fails the listing below.
  for (const excluded of ["dist", ".turbo"]) {
    mkdirSync(join(action, excluded), { recursive: true });
    writeFileSync(join(action, excluded, "artifact.js"), "module.exports={};\n");
  }
  return root;
}

describe("copyActions", () => {
  test("publishes source and manifests, never installed dependencies or build output", () => {
    const root = actionsFixture();
    const dest = temp.dir("branch-actions-dest-");
    const files = copyActions(root, dest);

    // The whole published tree: the manifests ship because the action
    // installs from them when it runs, nested source survives the filter,
    // and nothing under an EXCLUDED_DIRS name or ending in .test.ts lands.
    expect(listing(join(dest, "actions", "check-typography"))).toEqual([
      "action.yml",
      "bun.lock",
      "lib/helper.ts",
      "package.json",
    ]);
    expect(files).toBe(4);
  });

  test("refuses a tree with no actions at all", () => {
    const empty = temp.dir("branch-actions-empty-");
    const dest = temp.dir("branch-actions-dest-");
    // No actions/ directory: the checkout is wrong, and shipping anyway
    // would break the fleet rather than this run.
    expect(() => copyActions(empty, dest)).toThrow("no actions/ directory");

    mkdirSync(join(empty, "actions"), { recursive: true });
    expect(() => copyActions(empty, dest)).toThrow("holds no action directories");
  });

  test("refuses a directory with sources but no action.yml, naming it, BEFORE copying", () => {
    // Broken state, not a retirement: retiring an action deletes its whole
    // directory. Publishing sources without a manifest would succeed here
    // and then 404 every fleet `uses: .../<name>@build` at resolve time.
    const root = actionsFixture();
    const orphan = join(root, "actions", "orphaned-action");
    mkdirSync(orphan, { recursive: true });
    writeFileSync(join(orphan, "runtime.ts"), "export {};\n");
    const dest = temp.dir("branch-actions-dest-");
    expect(() => copyActions(root, dest)).toThrow("actions/orphaned-action");
    expect(() => copyActions(root, dest)).toThrow("no action.yml");
    // The guard fires before the first copy: even the VALID sibling action
    // must not have landed.
    expect(existsSync(join(dest, "actions"))).toBe(false);
  });

  test("the shared library zone ships without an action.yml, but satisfies no roster", () => {
    // actions/shared/ is imported by path (the actions' relative imports,
    // copier's stamp hook), never resolved as an action, so it is the one
    // directory exempt from the action.yml guard - and a tree holding ONLY
    // it still counts as having no actions to publish.
    const root = actionsFixture();
    mkdirSync(join(root, "actions", SHARED_DIR), { recursive: true });
    writeFileSync(join(root, "actions", SHARED_DIR, "grammar.ts"), "export {};\n");
    const dest = temp.dir("branch-actions-dest-");
    expect(copyActions(root, dest)).toBe(5);
    expect(existsSync(join(dest, "actions", SHARED_DIR, "grammar.ts"))).toBe(true);

    const sharedOnly = temp.dir("branch-actions-shared-only-");
    mkdirSync(join(sharedOnly, "actions", SHARED_DIR), { recursive: true });
    writeFileSync(join(sharedOnly, "actions", SHARED_DIR, "grammar.ts"), "export {};\n");
    expect(() => copyActions(sharedOnly, dest)).toThrow("holds no action directories");
  });

  test("a package nested inside an action ships whole, its installed dependencies excluded", () => {
    // The report action carries its validator as a nested package: script,
    // lockfile and bun pin publish with the action, and the exclusion
    // filter applies at every depth, not only at the action root.
    const root = actionsFixture();
    const nested = join(root, "actions", "check-typography", "validator");
    mkdirSync(join(nested, "node_modules", "yaml"), { recursive: true });
    writeFileSync(join(nested, "run.ts"), "export {};\n");
    writeFileSync(join(nested, "package.json"), "{}\n");
    writeFileSync(join(nested, "bun.lock"), "\n");
    writeFileSync(join(nested, ".bun-version"), "1.4.0\n");
    writeFileSync(join(nested, "node_modules", "yaml", "index.js"), "module.exports={};\n");
    const dest = temp.dir("branch-actions-dest-");
    expect(copyActions(root, dest)).toBe(8);
    expect(listing(join(dest, "actions", "check-typography"))).toEqual([
      "action.yml",
      "bun.lock",
      "lib/helper.ts",
      "package.json",
      "validator/.bun-version",
      "validator/bun.lock",
      "validator/package.json",
      "validator/run.ts",
    ]);
  });

  test("a directory holding only ignored leftovers is invisible; one tracked stray file is the broken state", () => {
    // After a pull that retired an action, its ignored node_modules/ stays
    // behind in every checkout that had installed it: not an action, not an
    // error. The control: one real file there and the manifest guard fires.
    const root = actionsFixture();
    const ghost = join(root, "actions", "ghost");
    mkdirSync(join(ghost, "node_modules", "yaml"), { recursive: true });
    writeFileSync(join(ghost, "node_modules", "yaml", "index.js"), "module.exports={};\n");
    mkdirSync(join(ghost, "dist"));
    writeFileSync(join(ghost, "dist", "bundle.js"), "module.exports={};\n");
    writeFileSync(join(ghost, `run${TEST_FILE_SUFFIX}`), "export {};\n");
    expect(actionDirNames(root)).toEqual(["check-typography"]);
    const dest = temp.dir("branch-actions-dest-");
    expect(copyActions(root, dest)).toBe(4);
    expect(existsSync(join(dest, "actions", "ghost"))).toBe(false);

    writeFileSync(join(ghost, "run.ts"), "export {};\n");
    expect(actionDirNames(root)).toEqual(["check-typography", "ghost"]);
    expect(() => copyActions(root, dest)).toThrow("actions/ghost");
    expect(() => copyActions(root, dest)).toThrow("no action.yml");
  });

  test("an ANCESTOR directory named node_modules does not filter the copy away", () => {
    // The exclusion filter tests segments relative to the action root: a
    // checkout parked under some node_modules/ ancestor must still publish.
    const parent = temp.dir("branch-actions-ancestor-");
    const root = join(parent, "node_modules", "repo");
    mkdirSync(join(root, "actions", "demo"), { recursive: true });
    writeFileSync(join(root, "actions", "demo", "action.yml"), "name: Demo\n");
    const dest = temp.dir("branch-actions-dest-");
    expect(copyActions(root, dest)).toBe(1);
    expect(existsSync(join(dest, "actions", "demo", "action.yml"))).toBe(true);
  });
});

describe("assembleBranchTree", () => {
  // One real assembly shared by the layout and extraction-safety tests
  // (compose runs once; the tree is read-only afterwards).
  const dest = temp.dir("branch-tree-real-");
  assembleBranchTree(dest);

  test("the branch root carries exactly the unified layout, actions/ mirroring the checkout", () => {
    // The stamp hook is no root byte-copy any more: it ships inside
    // actions/shared/ at the same relative path copier.yml's hooks name.
    expect(readdirSync(dest).sort()).toEqual([
      ".github",
      "README.md",
      "actions",
      "copier.yml",
      "migrations",
      "template",
    ]);
    // Every action directory of this checkout ships (the shared zone
    // included) and nothing else does.
    expect(readdirSync(join(dest, "actions")).sort()).toEqual(actionDirNames(REPO_ROOT));
    // No installed dependency or build output under any action.
    const excluded = walk(join(dest, "actions")).filter((path) =>
      relative(dest, path)
        .split("/")
        .some((segment) => EXCLUDED_DIRS.has(segment)),
    );
    expect(excluded).toEqual([]);
    // The anchors the fleet resolves by path: the composed copier tree, an
    // action manifest, and the shared zone the validator's relative imports
    // and the stamp hook resolve against on the extracted branch.
    for (const anchor of [
      join("template", "AGENTS.md.jinja"),
      join("actions", "check-typography", "action.yml"),
      join("actions", SHARED_DIR, "grammar.ts"),
      join("actions", SHARED_DIR, "stamp_manifest.ts"),
    ]) {
      expect(existsSync(join(dest, anchor))).toBe(true);
    }
  });

  test("migrations/ is the source directory's rung files, byte for byte", () => {
    // A rung is its own marker and runs from the build commit that carries
    // it, so the branch must ship exactly the source files: a missing rung
    // would run for nobody, an altered one would not be the reviewed code.
    const src = join(REPO_ROOT, MIGRATIONS_SRC_REL);
    const shipped = readdirSync(join(dest, "migrations")).sort();
    expect(shipped).toEqual(readdirSync(src).sort());
    expect(shipped.length).toBeGreaterThan(0);
    for (const name of shipped) {
      expect(readFileSync(join(dest, "migrations", name))).toEqual(readFileSync(join(src, name)));
    }
  test("actions/ holds only actions: every directory but the shared zone carries an action.yml, and the validator ships nested in the report action", () => {
    const actions = actionDirNames(REPO_ROOT);
    const manifestFree = actions.filter(
      (name) => !existsSync(join(REPO_ROOT, "actions", name, "action.yml")),
    );
    expect(manifestFree).toEqual([SHARED_DIR]);
    // The retired script directory is gone (the report action's presence is
    // the control); its content ships as the action's validator/ - lockfile
    // and pin included, no manifest, no dependencies, no tests.
    expect(actions).not.toContain("validate-template");
    expect(actions).toContain("validate-template-report");
    const validator = join(dest, "actions", "validate-template-report", "validator");
    expect(
      [
        "validate_generated_files.ts",
        "bun.lock",
        ".bun-version",
        "package.json",
        "action.yml",
        "node_modules",
        `validate_generated_files${TEST_FILE_SUFFIX}`,
      ].map((name) => existsSync(join(validator, name))),
    ).toEqual([true, true, true, true, false, false, false]);
    expect(walk(join(dest, "actions")).filter((path) => path.endsWith(TEST_FILE_SUFFIX))).toEqual(
      [],
    );
    // The control: the checkout does carry validator tests for the filter to drop.
    expect(
      walk(join(REPO_ROOT, "actions", "validate-template-report", "validator")).filter((path) =>
        path.endsWith(TEST_FILE_SUFFIX),
      ),
    ).not.toEqual([]);
  });

  test("no assembled path carries a jinja expression (tarball extraction safety)", () => {
    // THE invariant that lets one branch serve both copier and `uses:`
    // refs: a uses: ref downloads the whole branch tarball, and
    // extraction dies on path segments like
    // "{% if 'agents' in modules %}CLAUDE.md{% endif %}". The WHOLE real
    // tree is the input here - template/ included, which is exactly the
    // part the retired split-branch design existed to keep out. All
    // three jinja delimiters count: a {# comment #} or {{ var }} segment
    // is just as unextractable as a {% if %} gate.
    const offenders = walk(dest).filter((path) =>
      ["{%", "{{", "{#"].some((delimiter) => path.includes(delimiter)),
    );
    expect(offenders).toEqual([]);
  });

  test("every symlink on the branch resolves inside the tree (no dangling links)", () => {
    // The runner's tarball staging dies on a DANGLING symlink anywhere in
    // the downloaded tree, so branch links keep their .jinja targets (the
    // rendered repo gets the stripped target from the stamp hook).
    const links = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isSymbolicLink()) return [path];
        return entry.isDirectory() ? links(path) : [];
      });
    const dangling = links(dest).filter((path) => !existsSync(path));
    expect(dangling).toEqual([]);
  });

  test("the fleet-facing reusable workflows ship at .github/workflows", () => {
    // A reusable-workflow `uses:` fetches the FILE at the named ref, so
    // fleet-ci.yml@build and fleet-ci's ./reusable-codeql.yml call both
    // resolve against THIS tree; losing one 404s every fleet CI run.
    for (const name of FLEET_WORKFLOWS) {
      expect(existsSync(join(dest, ".github", "workflows", name))).toBe(true);
    }
    // Nothing beyond the roster: any extra workflow on the branch is an
    // unreviewed delivery surface.
    expect(readdirSync(join(dest, ".github", "workflows")).sort()).toEqual(
      [...FLEET_WORKFLOWS].sort(),
    );
  });
});

describe("copyFleetWorkflows", () => {
  // The other direction of the shipping guard: the branch is pushed with a
  // PAT (whose pushes CAN trigger workflows), so "nothing can run on the
  // build branch" holds only while every shipped workflow is
  // workflow_call-only. A non-inert trigger must fail the compose loudly,
  // naming the file and the trigger.
  /** A checkout whose rostered workflows each carry distinct content (so a
   *  copy that swaps or rewrites one is visible), fleet-ci's given. */
  function fixture(fleetCiContent: string): { root: string; contents: Record<string, string> } {
    const root = temp.dir("branch-workflows-");
    const wf = join(root, ".github", "workflows");
    mkdirSync(wf, { recursive: true });
    const contents: Record<string, string> = {};
    for (const name of FLEET_WORKFLOWS) {
      contents[name] =
        name === "fleet-ci.yml" ? fleetCiContent : `# ${name}\non:\n  workflow_call:\njobs: {}\n`;
      writeFileSync(join(wf, name), contents[name]);
    }
    return { root, contents };
  }

  test("ships the whole roster of workflow_call-only workflows byte-for-byte", () => {
    const { root, contents } = fixture("on:\n  workflow_call:\n    inputs: {}\njobs: {}\n");
    const dest = temp.dir("branch-workflows-dest-");
    copyFleetWorkflows(root, dest);
    // The whole shipped set, name to bytes: the fleet runs the file at the
    // ref, so a dropped, swapped, or rewritten workflow is an unreviewed
    // edit of fleet CI.
    const shipped = join(dest, ".github", "workflows");
    const published = Object.fromEntries(
      readdirSync(shipped).map((name) => [name, readFileSync(join(shipped, name), "utf8")]),
    );
    expect(published).toEqual(contents);
  });

  test("refuses a workflow with any trigger beyond workflow_call, naming file and trigger", () => {
    const { root } = fixture("on:\n  workflow_call:\n  push:\n    branches: [main]\njobs: {}\n");
    const dest = temp.dir("branch-workflows-dest-");
    expect(() => copyFleetWorkflows(root, dest)).toThrow(/fleet-ci\.yml.*'push'/);
  });

  test("refuses a workflow with no triggers at all (nothing provable is nothing shippable)", () => {
    const { root } = fixture("jobs: {}\n");
    const dest = temp.dir("branch-workflows-dest-");
    expect(() => copyFleetWorkflows(root, dest)).toThrow("declares no triggers");
  });

  test("refuses a tree missing a rostered workflow, naming it", () => {
    const { root } = fixture("on:\n  workflow_call:\njobs: {}\n");
    rmSync(join(root, ".github", "workflows", "reusable-codeql.yml"));
    const dest = temp.dir("branch-workflows-dest-");
    expect(() => copyFleetWorkflows(root, dest)).toThrow("reusable-codeql.yml is missing");
  });
});
