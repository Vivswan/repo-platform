import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parseFilesConfig } from "../../../actions/plan/files_config.ts";
import { MANIFEST_NAME } from "../../../actions/shared/platform.ts";
import { sha256 } from "../../../actions/shared/values.ts";
import { boundedSpawnSync } from "../../shared/bounded_spawn";
import { fixtureGit, fixtureGitEnv } from "../../shared/fixture_git";
import { tempDirs } from "../../shared/temp_dir";
import { snapshotTree } from "../../shared/tree_snapshot";
import { spawnStubUpstream } from "../../shared/upstream_server";

const temp = tempDirs();
const REPO_ROOT = new URL("../../..", import.meta.url).pathname;
// The check runs the real files.yml, whose refs are fetched: every upstream file is a stub and never the network.
const upstream = await spawnStubUpstream(
  parseFilesConfig(readFileSync(join(REPO_ROOT, "files.yml"), "utf-8")),
  temp.dir("check-upstream-"),
);
afterAll(() => upstream.stop());
const CHECK = join(REPO_ROOT, "actions/validate-managed-files/check.ts");
const SYNC = join(REPO_ROOT, ".github/scripts/sync/writer/sync.ts");
const BUILD = "abcdef0123456789abcdef0123456789abcdef01";
const REGISTRATION = "modules: [bun]\nproject: {name: Demo, slug: demo, description: A demo}\n";
/** A managed file of the bun module, small enough to diff whole. */
const MANAGED = ".typography-allow";

/** A repository this checkout's writer synced at BUILD, so the check has nothing to report. */
function synced(registration = REGISTRATION): string {
  const target = temp.dir("check-target-");
  writeFileSync(join(target, ".repo-platform.yml"), registration);
  const run = sync(target);
  expect(run.stderr).toBe("");
  expect(run.exitCode).toBe(0);
  return target;
}

function sync(target: string) {
  return boundedSpawnSync(
    [
      "bun",
      SYNC,
      "--files",
      join(REPO_ROOT, "files.yml"),
      "--tree",
      join(REPO_ROOT, "files"),
      "--target",
      target,
      "--build",
      BUILD,
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

/** The scratch copy lands under TMPDIR, so an empty one after the run proves the copy was removed. */
function check(target: string, scratch = temp.dir("check-scratch-")) {
  const run = boundedSpawnSync(
    [
      "bun",
      CHECK,
      "--target",
      target,
      "--repository",
      "OwnerOrg/demo",
      "--private",
      "false",
      "--build",
      BUILD,
      "--upstream",
      upstream.host,
    ],
    { cwd: REPO_ROOT, env: { ...fixtureGitEnv(), TMPDIR: scratch }, timeoutMs: 60_000 },
  );
  return { ...run, leftovers: readdirSync(scratch) };
}

describe("check.ts over a repository synced by this checkout's writer", () => {
  let target: string;
  beforeAll(() => {
    target = synced();
  });

  test("a synced repository is identical: exit 0, nothing written, the scratch copy gone", () => {
    const before = snapshotTree(target);
    const run = check(target);
    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe(`the repository is what ${BUILD.slice(0, 12)} writes\n`);
    expect(snapshotTree(target)).toEqual(before);
    expect(run.leftovers).toEqual([]);
  });

  test("one changed byte in a managed file: exit 1 naming the path with its diff, the repository untouched", () => {
    const edited = synced();
    appendFileSync(join(edited, MANAGED), "x");
    const before = snapshotTree(edited);
    const run = check(edited);
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain(`${MANAGED}: differs from what ${BUILD.slice(0, 12)} writes\n`);
    expect(run.stdout).toContain(`--- ${MANAGED}\n+++ ${MANAGED}\n`);
    expect(run.stdout).not.toContain(MANIFEST_NAME);
    expect(snapshotTree(edited)).toEqual(before);
    expect(run.leftovers).toEqual([]);
  });
});

describe("check.ts reports what the writer would hold", () => {
  test.each([
    ["a symbolic link", (path: string) => symlinkSync("LICENSE.md", path)],
    [
      "a directory",
      (path: string) => {
        mkdirSync(path);
        writeFileSync(join(path, "inner"), "x\n");
      },
    ],
  ])("%s where a file is declared: exit 1 with the hold, the bytes untouched", (_what, plant) => {
    const target = synced();
    rmSync(join(target, MANAGED));
    plant(join(target, MANAGED));
    const before = snapshotTree(target);
    const run = check(target);
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toMatch(new RegExp(`^${MANAGED.replace(".", "\\.")} held: `, "m"));
    expect(snapshotTree(target)).toEqual(before);
    expect(run.leftovers).toEqual([]);
  });
});

describe("check.ts never writes through a link in the target", () => {
  test("a tracked directory swapped for a relative link: the link is copied, its files are not, a file beyond it is untouched", () => {
    const outer = temp.dir("check-escape-");
    const target = join(outer, "repo");
    mkdirSync(target);
    writeFileSync(join(target, ".repo-platform.yml"), REGISTRATION);
    expect(sync(target).exitCode).toBe(0);
    mkdirSync(join(target, "notes"));
    writeFileSync(join(target, "notes/f"), "tracked\n");
    fixtureGit(target, ["init", "-q", "-b", "main"]);
    fixtureGit(target, ["add", "-A"]);
    fixtureGit(target, ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-q", "-m", "seed"]);
    renameSync(join(target, "notes"), join(outer, "source"));
    symlinkSync("../source", join(target, "notes"));
    // Control: the index still lists notes/f under the link, the input that made the copy write through it.
    expect(
      fixtureGit(target, ["ls-files", "--cached", "--others", "--exclude-standard"]),
    ).toContain("notes/f");
    // The scratch's ../source is a different directory from the target's; a write through the link lands here.
    const scratch = temp.dir("check-scratch-");
    mkdirSync(join(scratch, "source"));
    writeFileSync(join(scratch, "source/f"), "sentinel\n");
    const run = check(target, scratch);
    expect(readFileSync(join(scratch, "source/f"), "utf-8")).toBe("sentinel\n");
    expect(readFileSync(join(outer, "source/f"), "utf-8")).toBe("tracked\n");
    expect(run.exitCode).toBe(0);
    expect(run.leftovers).toEqual(["source"]);
  });
});

describe("check.ts on a presence change with no text to show", () => {
  test("a stale zero-byte managed file the writer would retire: the verdict line alone", () => {
    const target = synced();
    const path = "docs/empty.md";
    mkdirSync(join(target, "docs"));
    writeFileSync(join(target, path), "");
    const manifest = readFileSync(join(target, MANIFEST_NAME), "utf-8");
    writeFileSync(
      join(target, MANIFEST_NAME),
      manifest.replace(
        '  "files": {\n',
        `  "files": {\n    ${JSON.stringify(path)}: {"class": "managed", "hash": "${sha256("")}"},\n`,
      ),
    );
    const run = check(target);
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain(`${path}: ${BUILD.slice(0, 12)} would remove it\n`);
    expect(run.stdout).not.toContain(
      `${path}: ${BUILD.slice(0, 12)} would remove it\n(the bytes differ where the decoded text does not)`,
    );
  });
});

describe("check.ts compares bytes, not decoded text", () => {
  test("an invalid UTF-8 byte where the writer wrote U+FFFD is red", () => {
    const target = synced(REGISTRATION.replace("A demo", "A demo \uFFFD"));
    const path = "AGENTS.md";
    const written = readFileSync(join(target, path));
    const at = written.indexOf(Buffer.from("\uFFFD"));
    // Controls: the writer rendered the description's U+FFFD, and the swapped bytes decode to the same text.
    expect(at).toBeGreaterThan(-1);
    const swapped = Buffer.concat([
      written.subarray(0, at),
      Buffer.from([0xff]),
      written.subarray(at + 3),
    ]);
    expect(swapped.equals(written)).toBe(false);
    expect(swapped.toString("utf-8")).toBe(written.toString("utf-8"));
    writeFileSync(join(target, path), swapped);
    const run = check(target);
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain(
      `${path}: differs from what ${BUILD.slice(0, 12)} writes\n(the bytes differ where the decoded text does not)\n`,
    );
  });
});

describe("check.ts over a repository the sync would change", () => {
  test("a registration change that would write a new file is red", () => {
    const target = synced();
    writeFileSync(
      join(target, ".repo-platform.yml"),
      REGISTRATION.replace("modules: [bun]", "modules: [bun, fuzzer]"),
    );
    const run = check(target);
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain(
      `.github/workflows/nightly-fuzz.yml: ${BUILD.slice(0, 12)} would create it\n` +
        "--- .github/workflows/nightly-fuzz.yml\n+++ .github/workflows/nightly-fuzz.yml\n",
    );
    expect(run.leftovers).toEqual([]);
  });

  test("a manifest without the commit field is red on the manifest line alone", () => {
    const target = synced();
    const manifest = readFileSync(join(target, MANIFEST_NAME), "utf-8");
    writeFileSync(join(target, MANIFEST_NAME), manifest.replace(`, "commit": "${BUILD}"`, ""));
    const run = check(target);
    expect(run.exitCode).toBe(1);
    // Finding lines only: a diff's lines open with a space, +, -, or @@.
    expect(run.stdout.split("\n").filter((line) => /^[^ +@-]/.test(line))).toEqual([
      `${MANIFEST_NAME}: differs from what ${BUILD.slice(0, 12)} writes`,
    ]);
  });

  test("a record the writer cannot read: exit 2 with the writer's message", () => {
    const target = synced();
    const manifest = readFileSync(join(target, MANIFEST_NAME), "utf-8");
    writeFileSync(
      join(target, MANIFEST_NAME),
      manifest.replace('"class": "managed", "hash": "', '"class": "bespoke", "hash": "'),
    );
    const run = check(target);
    expect(run.exitCode).toBe(2);
    expect(run.stdout).toContain("1 manifest record is not a shape the writer records");
    expect(run.leftovers).toEqual([]);
  });

  test("a plain tree inside another checkout that ignores it is walked whole, not read through that checkout's index", () => {
    const outer = temp.dir("check-outer-");
    fixtureGit(outer, ["init", "-q", "-b", "main"]);
    writeFileSync(join(outer, ".gitignore"), "/nested/\n");
    const target = join(outer, "nested");
    mkdirSync(target);
    writeFileSync(join(target, ".repo-platform.yml"), REGISTRATION);
    expect(sync(target).exitCode).toBe(0);
    // Control: the outer checkout lists none of the nested tree.
    expect(fixtureGit(target, ["ls-files", "--cached", "--others", "--exclude-standard"])).toBe("");
    const run = check(target);
    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
  });

  test("a git checkout is judged by what git sees: an ignored file at a managed path is missing to the check", () => {
    const target = synced();
    // The repository's own ignore line sits outside the managed region and survives the sync.
    appendFileSync(join(target, ".gitignore"), `/${MANAGED}\n`);
    const plain = check(target);
    expect(plain.exitCode).toBe(0);
    fixtureGit(target, ["init", "-q", "-b", "main"]);
    fixtureGit(target, ["add", "-A"]);
    expect(fixtureGit(target, ["ls-files", "--", MANAGED])).toBe("");
    const tracked = check(target);
    expect(tracked.exitCode).toBe(1);
    expect(tracked.stdout).toContain(`${MANAGED}: ${BUILD.slice(0, 12)} would create it\n`);
  });
});
