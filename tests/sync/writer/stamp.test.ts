import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  DELIVERED_SURFACE,
  deliveredSurfaceChanged,
} from "../../../.github/scripts/shared/delivered_surface.ts";
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
  /** A change outside the delivered surface (a docs file). */
  docs: string;
  /** A byte changed under files/. */
  files: string;
  /** A dependency version moved: the lockfile alone. */
  lock: string;
}

function commit(root: string, message: string): string {
  fixtureGit(root, ["add", "-A"]);
  fixtureGit(root, ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-q", "-m", message]);
  return fixtureGit(root, ["rev-parse", "HEAD"]);
}

/** Four commits of a scratch platform: the fixture tree, a docs-only change, a source edit under files/, a lockfile bump. */
function platform(): Platform {
  const root = temp.dir("stamp-platform-");
  cpSync(FIXTURES, root, { recursive: true });
  writeFileSync(join(root, "bun.lock"), "lock v1\n");
  fixtureGit(root, ["init", "-q", "-b", "main"]);
  const base = commit(root, "base");
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "docs/notes.md"), "notes\n");
  const docs = commit(root, "docs");
  writeFileSync(join(root, "files/base/LICENSE.txt"), "a different license\n");
  const files = commit(root, "files");
  writeFileSync(join(root, "bun.lock"), "lock v2\n");
  const lock = commit(root, "lock");
  return { root, base, docs, files, lock };
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

  test("a build that left the delivered surface untouched keeps the recorded commit and changes no byte", () => {
    const t = target();
    expect(sync(p.root, t, p.base).exitCode).toBe(0);
    const before = snapshotTree(t);
    // Control: the first sync wrote the tree, so the snapshot has the manifest in it.
    expect(before.has(MANIFEST_NAME)).toBe(true);
    const run = sync(p.root, t, p.docs);
    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(recorded(t)).toBe(p.base);
    expect(snapshotTree(t)).toEqual(before);
  });

  test("a build that changed a byte under files/ moves the commit to it", () => {
    const t = target();
    expect(sync(p.root, t, p.base).exitCode).toBe(0);
    expect(readFileSync(join(t, "LICENSE.md"), "utf-8")).not.toBe("a different license\n");
    const run = sync(p.root, t, p.files);
    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(recorded(t)).toBe(p.files);
    expect(readFileSync(join(t, "LICENSE.md"), "utf-8")).toBe("a different license\n");
  });

  test("a build that moved the lockfile alone moves the commit too", () => {
    const t = target();
    expect(sync(p.root, t, p.files).exitCode).toBe(0);
    const run = sync(p.root, t, p.lock);
    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(recorded(t)).toBe(p.lock);
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

  test("deliveredSurfaceChanged answers from the platform checkout's git history", () => {
    expect(deliveredSurfaceChanged(p.root, p.base, p.docs)).toBe(false);
    expect(deliveredSurfaceChanged(p.root, p.base, p.files)).toBe(true);
    expect(deliveredSurfaceChanged(p.root, p.docs, p.files)).toBe(true);
    expect(deliveredSurfaceChanged(p.root, p.files, p.lock)).toBe(true);
  });
});

describe("the delivered surface", () => {
  test("is the list docs/sync.md documents", () => {
    const line = readFileSync(join(REPO_ROOT, "docs/sync.md"), "utf-8")
      .split("\n")
      .find((l) => l.includes("`DELIVERED_SURFACE`"));
    expect(line).toBeDefined();
    const spans = [...(line ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    // The paths are the code spans before the one naming the constant.
    const named = spans.indexOf("DELIVERED_SURFACE");
    expect(named).toBeGreaterThan(0);
    expect(spans.slice(0, named)).toEqual([...DELIVERED_SURFACE]);
  });

  test("every path exists in this checkout as the kind its spelling says", () => {
    for (const path of DELIVERED_SURFACE) {
      expect(lstatSync(join(REPO_ROOT, path)).isDirectory()).toBe(path.endsWith("/"));
    }
  });
});
