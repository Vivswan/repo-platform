// m0001: the security policy's move from the repository root to
// .github/SECURITY.md - the rung's verdicts and notes against scratch
// checkouts (the rename left staged for the runner's commit), plus the
// runner CLI over a build history in which the rung appears.

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import rung from "../../../.github/scripts/sync/migrations/m0001_security_policy_to_github.ts";
import type { Rung } from "../../../.github/scripts/sync/run_migrations.ts";
import {
  MIGRATIONS_NAME,
  MIGRATIONS_REVIEW_NAME,
} from "../../../.github/scripts/sync/section_files.ts";
import { git, ladderFixtures } from "../../shared/migration_fixtures.ts";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();
const { platform, repo, runLadder } = ladderFixtures(temp);

// The runner's contract, pinned at the type level: the rung file imports
// nothing from the runner, so this is where the two shapes meet.
const typed: Rung = rung;

const SOURCE = readFileSync(
  join(import.meta.dir, "../../../.github/scripts/sync/migrations", `${rung.id}.ts`),
  "utf-8",
);

const REGION =
  "<!-- BEGIN REPO-PLATFORM MANAGED -->\n# Security policy\n<!-- END REPO-PLATFORM MANAGED -->\n";
// The repository-owned half is the whole point of the move: it must ride
// the rename byte-for-byte, trailing whitespace and all.
const POLICY = `${REGION}\nScope note: repo-owned tail  \n`;

const apply = (dir: string) => typed.apply({ dir, oldSha: "old", newSha: "new" });

const MOVE_NOTE =
  "> [!NOTE]\n> SECURITY POLICY MOVE: this update moves `SECURITY.md` to\n> `.github/SECURITY.md`, byte-for-byte - the repository's own content outside\n> the managed region rides the move verbatim, and GitHub reads the policy\n> from `.github/` exactly as it did from the root. One-time transition:\n> the repository root keeps only repo content plus `.repo-platform.yml`;\n> community health files live under `.github/`.";
const MIRROR_ADVICE =
  "> This repository's `.repo-platform.yml` declares a `mirrors` source at the\n> retired path: change `source: SECURITY.md` to\n> `source: .github/SECURITY.md`. Until then the mirror step refuses that entry\n> and holds the PR.";
const STALE_MIRROR =
  "modules: [bun]\nmirrors:\n  - source: SECURITY.md\n    targets: [copies/SECURITY.md]\n";

describe("m0001_security_policy_to_github", () => {
  test("a root-vintage SECURITY.md is moved byte-for-byte, tail included, and left staged for the runner", () => {
    const dir = repo({ "SECURITY.md": POLICY, "README.md": "readme\n" });
    expect(apply(dir)).toEqual({
      kind: "verdict",
      verdict: { kind: "moved", note: { text: MOVE_NOTE, review: false } },
    });
    expect(existsSync(join(dir, "SECURITY.md"))).toBe(false);
    expect(readFileSync(join(dir, ".github/SECURITY.md"), "utf-8")).toBe(POLICY);
    expect(git(dir, "status", "--porcelain")).toBe("R  SECURITY.md -> .github/SECURITY.md\n");
    expect(git(dir, "rev-list", "--count", "HEAD").trim()).toBe("1");
  });

  test("idempotent: a second run over the committed move is in-place and stages nothing", () => {
    const dir = repo({ "SECURITY.md": POLICY });
    apply(dir);
    git(dir, "-c", "user.name=t", "-c", "user.email=t@x", "commit", "-qm", "moved");
    expect(apply(dir)).toEqual({ kind: "verdict", verdict: { kind: "in-place", note: null } });
    expect(git(dir, "status", "--porcelain")).toBe("");
  });

  test.each([
    {
      label: "moved, stale mirror source",
      files: { "SECURITY.md": POLICY, ".repo-platform.yml": STALE_MIRROR },
      kind: "moved",
      note: { text: `${MOVE_NOTE}\n>\n${MIRROR_ADVICE}`, review: false },
    },
    {
      label: "moved, another mirror source",
      files: {
        "SECURITY.md": POLICY,
        ".repo-platform.yml":
          "modules: [bun]\nmirrors:\n  - source: LICENSE.md\n    targets: [x.md]\n",
      },
      kind: "moved",
      note: { text: MOVE_NOTE, review: false },
    },
    {
      label: "already moved, stale mirror source",
      files: { ".github/SECURITY.md": POLICY, ".repo-platform.yml": STALE_MIRROR },
      kind: "in-place",
      note: { text: `> [!NOTE]\n${MIRROR_ADVICE}`, review: false },
    },
    {
      label: "missing, stale mirror source",
      files: { ".repo-platform.yml": STALE_MIRROR },
      kind: "missing",
      note: { text: `> [!NOTE]\n${MIRROR_ADVICE}`, review: false },
    },
    {
      label: "already moved, an unreadable declaration: nothing to say",
      files: { ".github/SECURITY.md": POLICY, ".repo-platform.yml": "mirrors: [\n" },
      kind: "in-place",
      note: null,
    },
    {
      label: "at neither path (the update renders it fresh): nothing to say",
      files: { "README.md": "readme\n" },
      kind: "missing",
      note: null,
    },
  ])("verdict and note are exact: $label", ({ files, kind, note }) => {
    const dir = repo(files);
    expect(apply(dir)).toEqual({ kind: "verdict", verdict: { kind, note } });
    if (kind !== "moved") expect(git(dir, "status", "--porcelain")).toBe("");
  });

  test("a policy at both paths is the error arm (the sync must not guess which wins)", () => {
    const dir = repo({ "SECURITY.md": "root copy\n", ".github/SECURITY.md": POLICY });
    expect(apply(dir)).toMatchObject({ kind: "error", message: expect.stringContaining("BOTH") });
    expect(readFileSync(join(dir, "SECURITY.md"), "utf-8")).toBe("root copy\n");
    expect(git(dir, "status", "--porcelain")).toBe("");
  });

  // Either endpoint as something other than a regular file: lstat, not
  // stat, so a symlink pointing at a perfectly good file is still not the
  // policy - the carry would write through it.
  test.each([
    {
      shape: "a directory at the root path",
      files: { "SECURITY.md/nested": "a directory, not the policy\n" },
      link: null,
    },
    {
      shape: "a directory at the destination",
      files: { "SECURITY.md": POLICY, ".github/SECURITY.md/nested": "a directory\n" },
      link: null,
    },
    {
      shape: "a symlink at the root path",
      files: { "real-policy.md": POLICY },
      link: ["real-policy.md", "SECURITY.md"],
    },
    {
      shape: "a symlink at the destination",
      files: { ".github/target-of-link.md": POLICY, "SECURITY.md": POLICY },
      link: ["target-of-link.md", ".github/SECURITY.md"],
    },
  ])("$shape is the error arm: nothing moves, nothing is read through", ({ files, link }) => {
    const dir = repo(files);
    if (link !== null) {
      symlinkSync(link[0], join(dir, link[1]));
      git(dir, "add", "-A");
      git(dir, "-c", "user.name=t", "-c", "user.email=t@x", "commit", "-qm", "symlinked endpoint");
    }
    const before = git(dir, "ls-files", "-s");
    expect(apply(dir)).toMatchObject({
      kind: "error",
      message: expect.stringContaining("regular file"),
    });
    expect(git(dir, "status", "--porcelain")).toBe("");
    expect(git(dir, "ls-files", "-s")).toBe(before);
  });

  // The destination's parent is target-controlled too. `git mv` into a
  // symlinked directory exits 0 and writes wherever the link points, so
  // the refusal must come before the move; a file-shaped .github is the
  // same broken parent.
  test.each([
    {
      shape: "a symlink to a directory outside the checkout",
      plant: (root: string, dir: string) => {
        mkdirSync(join(root, "outside"));
        symlinkSync("../outside", join(dir, ".github"));
      },
      outside: [] as string[] | null,
    },
    {
      shape: "a regular file",
      plant: (_root: string, dir: string) =>
        writeFileSync(join(dir, ".github"), "not a directory\n"),
      outside: null,
    },
  ])(
    ".github as $shape is the error arm: nothing moved, nothing written outside",
    ({ plant, outside }) => {
      const root = temp.dir("m0001-parent-");
      const dir = join(root, "target");
      mkdirSync(dir);
      writeFileSync(join(dir, "SECURITY.md"), POLICY);
      plant(root, dir);
      git(dir, "init", "-q", "-b", "main");
      git(dir, "-c", "user.name=t", "-c", "user.email=t@x", "add", "-A");
      git(dir, "-c", "user.name=t", "-c", "user.email=t@x", "commit", "-qm", "broken .github");
      expect(apply(dir)).toMatchObject({
        kind: "error",
        message: expect.stringContaining(".github is not a real directory"),
      });
      expect(readFileSync(join(dir, "SECURITY.md"), "utf-8")).toBe(POLICY);
      expect(git(dir, "status", "--porcelain")).toBe("");
      if (outside !== null) expect(readdirSync(join(root, "outside"))).toEqual(outside);
    },
  );
});

// Through the runner CLI, from a build history in which the rung appears
// after the recorded build: the move happens and is committed, the note
// lands in the informational report; the error arm fails the step with
// ::error:: on stdout and moves nothing.
describe("m0001 through run_migrations.ts", () => {
  const history = () =>
    platform([
      { tag: "old", rungs: {} },
      { tag: "new", rungs: { [`${rung.id}.ts`]: SOURCE } },
    ]);

  test("pending: the move happens, is committed alone, and the note lands in the informational report", () => {
    const target = repo({ "SECURITY.md": POLICY });
    const result = runLadder(history(), target, "old");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      `::notice::Vivswan/demo: migration ${rung.id} -> moved (committed) (the PR body carries the note)`,
    );
    expect(existsSync(join(target, "SECURITY.md"))).toBe(false);
    expect(readFileSync(join(target, ".github/SECURITY.md"), "utf-8")).toBe(POLICY);
    expect(git(target, "status", "--porcelain")).toBe("");
    expect(git(target, "log", "-1", "--format=%an %s").trim()).toBe(
      `repo-platform-sync chore: run migration ${rung.id}`,
    );
    expect(git(target, "log", "-1", "--name-status", "--format=")).toBe(
      "R100\tSECURITY.md\t.github/SECURITY.md\n",
    );
    expect(readFileSync(join(result.temp, MIGRATIONS_NAME), "utf-8")).toBe(`${MOVE_NOTE}\n`);
    expect(readFileSync(join(result.temp, MIGRATIONS_REVIEW_NAME), "utf-8")).toBe("");
  });

  test("no usable base still runs the rung: a root-vintage fixture is moved", () => {
    const target = repo({ "SECURITY.md": POLICY });
    const result = runLadder(history(), target, "");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no usable base");
    expect(result.stdout).toContain(`migration ${rung.id} -> moved (committed)`);
    expect(existsSync(join(target, "SECURITY.md"))).toBe(false);
    expect(readFileSync(join(target, ".github/SECURITY.md"), "utf-8")).toBe(POLICY);
  });

  test("a noted verdict that changed nothing is announced without a commit", () => {
    const target = repo({ ".github/SECURITY.md": POLICY, ".repo-platform.yml": STALE_MIRROR });
    const result = runLadder(history(), target, "old");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      `::notice::Vivswan/demo: migration ${rung.id} -> in-place (the PR body carries the note)`,
    );
    expect(git(target, "rev-list", "--count", "HEAD").trim()).toBe("1");
    expect(readFileSync(join(result.temp, MIGRATIONS_NAME), "utf-8")).toBe(
      `> [!NOTE]\n${MIRROR_ADVICE}\n`,
    );
  });

  test("the error arm fails the step with ::error:: on stdout and moves nothing", () => {
    const target = repo({ "SECURITY.md": "root copy\n", ".github/SECURITY.md": POLICY });
    const result = runLadder(history(), target, "old");
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain(
      `::error::Vivswan/demo: migration ${rung.id}: carries a security policy at BOTH`,
    );
    expect(readFileSync(join(target, "SECURITY.md"), "utf-8")).toBe("root copy\n");
    expect(git(target, "rev-list", "--count", "HEAD").trim()).toBe("1");
  });
});
