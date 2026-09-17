import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  CHECKER_SURFACE,
  checkerChanged,
} from "../../../.github/scripts/sync/writer/judged_commit.ts";
import { MANIFEST_NAME } from "../../../.github/scripts/sync/writer/manifest.ts";
import { sha256 } from "../../../actions/shared/values.ts";
import { boundedSpawnSync } from "../../shared/bounded_spawn";
import { fixtureGit, fixtureGitEnv } from "../../shared/fixture_git";
import { tempDirs } from "../../shared/temp_dir";
import { snapshotTree } from "../../shared/tree_snapshot";
import { spawnUpstream } from "../../shared/upstream_server";

const temp = tempDirs();
const REPO_ROOT = new URL("../../..", import.meta.url).pathname;
const SYNC = join(REPO_ROOT, ".github/scripts/sync/writer/sync.ts");
const FIXTURES = join(REPO_ROOT, "tests/ci/sync_end_to_end/fixtures");
const upstream = await spawnUpstream(join(FIXTURES, "upstream"));
afterAll(() => upstream.stop());
const REGISTRATION =
  "modules: [bun]\nproject: {name: Demo, slug: demo, description: A demo}\n" +
  "except: [CLAUDE.md, .github/agents.md, .github/copilot-instructions.md]\n";

interface Platform {
  root: string;
  /** The e2e fixture tree as committed. */
  base: string;
  /** A docs file: off the checker and written nowhere. */
  docs: string;
  /** A docs-site theme file under actions/: off the checker and written nowhere. */
  theme: string;
  /** A byte changed under the checker. */
  checker: string;
  /** A byte changed under files/, which the sync writes. */
  files: string;
  /** A dependency version moved: the lockfile alone. */
  lock: string;
}

function commit(root: string, message: string): string {
  fixtureGit(root, ["add", "-A"]);
  fixtureGit(root, ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-q", "-m", message]);
  return fixtureGit(root, ["rev-parse", "HEAD"]);
}

function put(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

/** Six commits of a scratch platform, one change each, in the order the fields list them. */
function platform(): Platform {
  const root = temp.dir("stamp-platform-");
  cpSync(FIXTURES, root, { recursive: true });
  put(root, "bun.lock", "lock v1\n");
  put(root, "actions/validate-managed-files/check.ts", "// the checker\n");
  fixtureGit(root, ["init", "-q", "-b", "main"]);
  const base = commit(root, "base");
  put(root, "docs/notes.md", "notes\n");
  const docs = commit(root, "docs");
  put(root, "actions/pages-site/theme/style.css", "body { color: teal }\n");
  const theme = commit(root, "theme");
  put(root, "actions/validate-managed-files/check.ts", "// the checker, changed\n");
  const checker = commit(root, "checker");
  put(root, "files/base/LICENSE.txt", "a different license\n");
  const files = commit(root, "files");
  put(root, "bun.lock", "lock v2\n");
  const lock = commit(root, "lock");
  return { root, base, docs, theme, checker, files, lock };
}

function target(): string {
  const dir = temp.dir("stamp-target-");
  writeFileSync(join(dir, ".repo-platform.yml"), REGISTRATION);
  return dir;
}

/** The operator checks the build out before the writer reads it, so the tree under files/ is the build's own. */
function sync(platformRoot: string, targetDir: string, build: string) {
  fixtureGit(platformRoot, ["checkout", "-q", build]);
  return boundedSpawnSync(
    [
      "bun",
      SYNC,
      "--files",
      join(platformRoot, "files.yml"),
      "--tree",
      join(platformRoot, "files"),
      "--target",
      targetDir,
      "--build",
      build,
      "--repository",
      "OwnerOrg/demo",
      "--private",
      "false",
      "--upstream",
      upstream.host,
    ],
    { cwd: REPO_ROOT, env: fixtureGitEnv(), timeoutMs: 60_000 },
  );
}

function recorded(targetDir: string): unknown {
  const manifest = JSON.parse(readFileSync(join(targetDir, MANIFEST_NAME), "utf-8")) as {
    files: Record<string, Record<string, unknown>>;
  };
  return manifest.files[MANIFEST_NAME].commit;
}

interface Second {
  reason: string;
  /** The commit the first sync records, then the build of the second. */
  builds: (p: Platform) => [string, string];
  /** A change to the target between the two syncs. */
  between?: (targetDir: string) => void;
  stamp: (p: Platform) => string;
  /** Whether the second sync leaves every byte but the manifest as it stood just before it ran. */
  treeKept: boolean;
}

describe("the manifest's commit under the stamp rule", () => {
  let p: Platform;
  beforeAll(() => {
    p = platform();
  });

  test("a manifest without the field takes the build", () => {
    const t = target();
    const run = sync(p.root, t, p.base);
    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(recorded(t)).toBe(p.base);
  });

  test.each<Second>([
    {
      reason: "a build that changed only docs keeps the commit and changes no byte",
      builds: (p) => [p.base, p.docs],
      stamp: (p) => p.base,
      treeKept: true,
    },
    {
      reason: "a build that changed only the docs-site theme under actions/ keeps the commit",
      builds: (p) => [p.base, p.theme],
      stamp: (p) => p.base,
      treeKept: true,
    },
    {
      reason: "a build that changed the checker alone moves the commit though it wrote nothing",
      builds: (p) => [p.theme, p.checker],
      stamp: (p) => p.checker,
      treeKept: true,
    },
    {
      reason: "a build that changed a byte under files/ moves the commit to it",
      builds: (p) => [p.checker, p.files],
      stamp: (p) => p.files,
      treeKept: false,
    },
    {
      reason: "a build that moved the lockfile alone keeps the commit",
      builds: (p) => [p.files, p.lock],
      stamp: (p) => p.files,
      treeKept: true,
    },
    {
      reason:
        "a local edit the sync replaces moves the commit though the platform wrote the same bytes",
      builds: (p) => [p.base, p.docs],
      between: (t) => writeFileSync(join(t, "LICENSE.md"), "edited locally\n"),
      stamp: (p) => p.docs,
      treeKept: false,
    },
    {
      reason: "a record released by the registration moves the commit with no file written",
      builds: (p) => [p.base, p.docs],
      between: (t) =>
        writeFileSync(
          join(t, ".repo-platform.yml"),
          REGISTRATION.replace("[CLAUDE.md", "[LICENSE.md, CLAUDE.md"),
        ),
      stamp: (p) => p.docs,
      treeKept: true,
    },
  ])("$reason", ({ builds, between, stamp, treeKept }) => {
    const [first, second] = builds(p);
    const t = target();
    expect(sync(p.root, t, first).exitCode).toBe(0);
    expect(recorded(t)).toBe(first);
    between?.(t);
    const before = snapshotTree(t);
    // Control: the first sync wrote the tree, so the snapshot has the manifest in it.
    expect(before.has(MANIFEST_NAME)).toBe(true);
    const run = sync(p.root, t, second);
    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(recorded(t)).toBe(stamp(p));
    const after = snapshotTree(t);
    // A kept stamp keeps the manifest's bytes too; a moved one leaves the manifest out of the comparison.
    if (stamp(p) !== first) {
      before.delete(MANIFEST_NAME);
      after.delete(MANIFEST_NAME);
    }
    if (treeKept) expect(after).toEqual(before);
    else expect(after).not.toEqual(before);
  });

  test("a shallow build checkout fetches the recorded commit before the diff", () => {
    const shallow = temp.dir("stamp-shallow-");
    fixtureGit(p.root, ["checkout", "-q", p.files]);
    fixtureGit(dirname(shallow), ["clone", "-q", "--depth", "1", `file://${p.root}`, shallow]);
    // Control: the recorded commit is not in the shallow clone before the writer runs.
    expect(fixtureGit(shallow, ["rev-parse", "--is-shallow-repository"])).toBe("true");
    const missing = boundedSpawnSync(
      ["git", "-C", shallow, "rev-parse", "--verify", "--quiet", `${p.base}^{commit}`],
      { env: fixtureGitEnv() },
    );
    expect(missing.exitCode).toBe(1);
    const t = target();
    expect(sync(p.root, t, p.base).exitCode).toBe(0);
    const run = sync(shallow, t, p.files);
    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(recorded(t)).toBe(p.files);
    expect(fixtureGit(shallow, ["rev-parse", "--verify", `${p.base}^{commit}`])).toBe(p.base);
  });

  test("a recorded commit the build checkout cannot fetch fails the run before anything is written", () => {
    const t = target();
    expect(sync(p.root, t, p.base).exitCode).toBe(0);
    const before = snapshotTree(t);
    const manifest = readFileSync(join(t, MANIFEST_NAME), "utf-8");
    const foreign = "f".repeat(40);
    writeFileSync(join(t, MANIFEST_NAME), manifest.replace(p.base, foreign));
    const run = sync(p.root, t, p.docs);
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain(
      `::error::the manifest records commit ${foreign.slice(0, 12)}, which the build checkout cannot fetch`,
    );
    before.set(MANIFEST_NAME, sha256(manifest.replace(p.base, foreign)));
    expect(snapshotTree(t)).toEqual(before);
  });

  test("checkerChanged reads the checker surface alone from the platform checkout's history", () => {
    expect(checkerChanged(p.root, p.base, p.theme)).toBe(false);
    expect(checkerChanged(p.root, p.theme, p.checker)).toBe(true);
    expect(checkerChanged(p.root, p.checker, p.lock)).toBe(false);
  });
});

const CHECK = "actions/validate-managed-files/check.ts";

/** Every file reached from `entry` through relative imports, named or side-effect, as paths relative to the repository root. */
function importClosure(entry: string): string[] {
  const seen = new Set<string>();
  const visit = (path: string) => {
    if (seen.has(path)) return;
    seen.add(path);
    const source = readFileSync(join(REPO_ROOT, path), "utf-8");
    for (const [, spec] of source.matchAll(/(?:from|import)\s+"(\.[^"]+)"/g)) {
      visit(relative(REPO_ROOT, resolve(REPO_ROOT, dirname(path), spec)));
    }
  };
  visit(entry);
  return [...seen].sort();
}

const rootsOf = (path: string) =>
  CHECKER_SURFACE.filter((root) => (root.endsWith("/") ? path.startsWith(root) : path === root));

describe("the checker surface", () => {
  test("is the list docs/sync.md documents, each path the kind its spelling says", () => {
    const line = readFileSync(join(REPO_ROOT, "docs/sync.md"), "utf-8")
      .split("\n")
      .find((l) => l.includes("`CHECKER_SURFACE`"));
    expect(line).toBeDefined();
    const spans = [...(line ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    // The paths are the code spans before the one naming the constant.
    const named = spans.indexOf("CHECKER_SURFACE");
    expect(named).toBeGreaterThan(0);
    expect(spans.slice(0, named)).toEqual([...CHECKER_SURFACE]);
    for (const path of CHECKER_SURFACE) {
      expect(lstatSync(join(REPO_ROOT, path)).isDirectory()).toBe(path.endsWith("/"));
    }
  });

  test("is exactly the roots of check.ts's import closure, one per file and none empty", () => {
    const closure = importClosure(CHECK);
    expect(closure.length).toBeGreaterThan(1);
    for (const path of closure) expect(existsSync(join(REPO_ROOT, path))).toBe(true);
    const roots = closure.map((path) => [path, rootsOf(path)] as const);
    expect(roots.filter(([, found]) => found.length !== 1)).toEqual([]);
    expect(new Set(roots.flatMap(([, found]) => found))).toEqual(new Set(CHECKER_SURFACE));
  });
});
