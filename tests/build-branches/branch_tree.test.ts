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
import { parse as parseYaml } from "yaml";
import {
  actionDirNames,
  assembleBranchTree,
  canonicalize,
  copyActions,
  copyFleetWorkflows,
  destOverlapsRepo,
  EXCLUDED_DIRS,
  FILES_CONFIG,
  FILES_DIR,
  FLEET_WORKFLOWS,
  parseArgs,
  RESERVED_LABELS_FILE,
  reservedLabelNames,
  SHARED_DIR,
  TEST_FILE_SUFFIX,
  UsageError,
} from "../../.github/scripts/build-branches/branch_tree";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();

const REPO = "/home/user/repo-platform";
const REPO_ROOT = join(import.meta.dir, "../..");

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() && !entry.isSymbolicLink() ? [path, ...walk(path)] : [path];
  });

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
  test.each([
    [REPO, true, "the repository root itself"],
    ["/", true, "the filesystem root is an ancestor ('/' + '/' must not read as '//')"],
    ["/home", true, "a distant ancestor"],
    ["/home/user", true, "the immediate parent"],
    [`${REPO}/files`, true, "a path inside the repository"],
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

    // The manifests ship because the action installs from them when it runs.
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
    expect(existsSync(join(dest, "actions"))).toBe(false);
  });

  test("the shared library zone ships without an action.yml, but satisfies no roster", () => {
    // actions/shared/ is imported by path (the actions' relative imports),
    // never resolved as an action, so it is the one directory exempt from
    // the action.yml guard - and a tree holding ONLY it still counts as
    // having no actions to publish.
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

  test("an action's subdirectories ship whole, excluded directories filtered at every depth", () => {
    const root = actionsFixture();
    const nested = join(root, "actions", "check-typography", "validator");
    mkdirSync(join(nested, "node_modules", "yaml"), { recursive: true });
    writeFileSync(join(nested, "run.ts"), "export {};\n");
    writeFileSync(join(nested, "node_modules", "yaml", "index.js"), "module.exports={};\n");
    const dest = temp.dir("branch-actions-dest-");
    expect(copyActions(root, dest)).toBe(5);
    expect(listing(join(dest, "actions", "check-typography"))).toEqual([
      "action.yml",
      "bun.lock",
      "lib/helper.ts",
      "package.json",
      "validator/run.ts",
    ]);
  });

  test("a directory holding only ignored leftovers is invisible; one tracked stray file is the broken state", () => {
    // After a pull that retired an action, its ignored node_modules/ stays
    // behind in every checkout that had installed it: not an action, not an
    // error.
    const root = actionsFixture();
    const ghost = join(root, "actions", "ghost");
    mkdirSync(join(ghost, "node_modules", "yaml"), { recursive: true });
    writeFileSync(join(ghost, "node_modules", "yaml", "index.js"), "module.exports={};\n");
    mkdirSync(join(ghost, "dist"));
    writeFileSync(join(ghost, "dist", "bundle.js"), "module.exports={};\n");
    writeFileSync(join(ghost, `run${TEST_FILE_SUFFIX}`), "export {};\n");
    mkdirSync(join(root, "actions", "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(root, "actions", "node_modules", "pkg", "index.js"), "module.exports={};\n");
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
  // One real assembly shared by the layout tests (the tree is read-only
  // afterwards).
  const dest = temp.dir("branch-tree-real-");
  assembleBranchTree(dest);

  test("the branch root carries exactly the delivery layout, actions/ mirroring the checkout", () => {
    expect(readdirSync(dest).sort()).toEqual([
      ".github",
      "README.md",
      "actions",
      "files",
      "files.yml",
      "reserved-labels.yml",
    ]);
    expect(readdirSync(join(dest, "actions")).sort()).toEqual(actionDirNames(REPO_ROOT));
    const excluded = walk(join(dest, "actions")).filter((path) =>
      relative(dest, path)
        .split("/")
        .some((segment) => EXCLUDED_DIRS.has(segment)),
    );
    expect(excluded).toEqual([]);
    // The anchors the fleet resolves by path: an action manifest, the
    // shared zone the actions' relative imports resolve against on the
    // extracted branch, and the writer's data beside them.
    for (const anchor of [
      join("actions", "check-typography", "action.yml"),
      join("actions", SHARED_DIR, "grammar.ts"),
      join("files", "base", ".github", "workflows", "ci.yml"),
    ]) {
      expect(existsSync(join(dest, anchor))).toBe(true);
    }
  });

  test("files.yml and files/ are the sync writer's data, byte for byte", () => {
    // The operator reads both from the build commit it syncs, and the plan
    // action reads files.yml beside itself: a missing or altered source
    // would write the wrong bytes into every managed repo or plan every
    // fleet run wrongly.
    expect(readFileSync(join(dest, FILES_CONFIG))).toEqual(
      readFileSync(join(REPO_ROOT, FILES_CONFIG)),
    );
    const shipped = listing(join(dest, FILES_DIR));
    expect(shipped).toEqual(listing(join(REPO_ROOT, FILES_DIR)));
    expect(shipped.length).toBeGreaterThan(20);
    for (const rel of shipped) {
      expect(readFileSync(join(dest, FILES_DIR, rel))).toEqual(
        readFileSync(join(REPO_ROOT, FILES_DIR, rel)),
      );
    }
  });

  test("reserved-labels.yml is the managed label roster, lowercased and deduped", () => {
    // The plan action refuses a registration label on this list; a short
    // roster would let a tracking stream take over a managed label.
    const shipped = parseYaml(readFileSync(join(dest, RESERVED_LABELS_FILE), "utf8"));
    expect(shipped).toEqual(reservedLabelNames(REPO_ROOT));
    expect(shipped).toContain("bug");
    expect(shipped).toContain("autorelease: pending");
    expect(shipped).toContain("javascript");
    expect(new Set(shipped).size).toBe(shipped.length);
    for (const name of shipped) expect(name).toBe(name.toLowerCase());
  });

  test("actions/ holds only actions: every directory but the shared zone carries an action.yml, no dependencies, no tests", () => {
    const actions = actionDirNames(REPO_ROOT);
    const manifestFree = actions.filter(
      (name) => !existsSync(join(REPO_ROOT, "actions", name, "action.yml")),
    );
    expect(manifestFree).toEqual([SHARED_DIR]);
    expect(actions).toContain("validate-managed-files");
    const validator = join(dest, "actions", "validate-managed-files");
    expect(
      ["action.yml", "bun.lock", ".bun-version", "package.json", "node_modules"].map((name) =>
        existsSync(join(validator, name)),
      ),
    ).toEqual([true, true, true, true, false]);
    expect(walk(join(dest, "actions")).filter((path) => path.endsWith(TEST_FILE_SUFFIX))).toEqual(
      [],
    );
    // The control is planted, not read off the checkout (which carries no
    // colocated test): the same copy drops a test file under a fixture
    // action, so the empty listing above is a verdict, not a vacuous walk.
    const planted = temp.dir("branch-actions-planted-");
    const probe = join(planted, "actions", "probe");
    mkdirSync(join(probe, "lib"), { recursive: true });
    writeFileSync(join(probe, "action.yml"), "name: Probe\n");
    writeFileSync(join(probe, "lib", `probe${TEST_FILE_SUFFIX}`), "export {};\n");
    const plantedDest = temp.dir("branch-actions-planted-dest-");
    copyActions(planted, plantedDest);
    expect(
      walk(join(planted, "actions")).filter((path) => path.endsWith(TEST_FILE_SUFFIX)),
    ).toHaveLength(1);
    expect(listing(join(plantedDest, "actions", "probe"))).toEqual(["action.yml"]);
  });

  test("no assembled path carries a placeholder or expression (tarball extraction safety)", () => {
    // A uses: ref downloads the whole branch tarball, and extraction dies
    // on path segments carrying braces; the writer substitutes
    // placeholders in file CONTENT only, so no path may carry one.
    const offenders = walk(dest).filter((path) =>
      ["{%", "{{", "{#"].some((delimiter) => path.includes(delimiter)),
    );
    expect(offenders).toEqual([]);
  });

  test("every symlink on the branch resolves inside the tree (no dangling links)", () => {
    // The runner's tarball staging dies on a DANGLING symlink anywhere in
    // the downloaded tree.
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
  // workflow_call-only.
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
