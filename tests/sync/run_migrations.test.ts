// run_migrations.ts: the walk over build history (pending = rung files
// that appear after the recorded build, each from the newest commit that
// carries them), the outcome contract a loaded rung must meet, the
// per-rung commit, the two PR-body reports, and the CLI's contract over a
// scratch platform whose tagged build chain adds and prunes rung files.
// Rung-specific behavior lives with each rung's own test
// (tests/sync/migrations/<id>.test.ts).

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyPending,
  applyRung,
  fetchRungs,
  ignoredPaths,
  loadRung,
  type PendingRung,
  pendingRungs,
  type Rung,
  rungFiles,
  runRungs,
  writeReports,
} from "../../.github/scripts/sync/run_migrations.ts";
import {
  MIGRATIONS_NAME,
  MIGRATIONS_REVIEW_NAME,
} from "../../.github/scripts/sync/section_files.ts";
import { git, ladderFixtures, rungSource } from "../shared/migration_fixtures.ts";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();
const { platform, repo, runLadder, runLadderWithOldSha } = ladderFixtures(temp);

const reports = (dir: string) => ({
  info: readFileSync(join(dir, MIGRATIONS_NAME), "utf-8"),
  review: readFileSync(join(dir, MIGRATIONS_REVIEW_NAME), "utf-8"),
});

const sha = (dir: string, ref: string) => git(dir, "rev-parse", `${ref}^{commit}`).trim();

/** old(m0001) -> b1(+m0002 v1) -> b2(m0002 v2, +m0003) -> new(m0002
 * pruned): the shape the walk exists for. */
function chain() {
  const a = rungSource("m0001_a");
  return platform([
    { tag: "old", rungs: { "m0001_a.ts": a } },
    { tag: "b1", rungs: { "m0001_a.ts": a, "m0002_b.ts": rungSource("m0002_b", { stamp: "v1" }) } },
    {
      tag: "b2",
      rungs: {
        "m0001_a.ts": a,
        "m0002_b.ts": rungSource("m0002_b", { stamp: "v2" }),
        "m0003_c.ts": rungSource("m0003_c"),
      },
    },
    { tag: "new", rungs: { "m0001_a.ts": a, "m0003_c.ts": rungSource("m0003_c") } },
  ]);
}

describe("pendingRungs: the walk over build history", () => {
  const dir = chain();
  const at = (tag: string) => sha(dir, tag);
  const pending = (oldRef: string | null) =>
    pendingRungs(dir, oldRef === null ? null : at(oldRef), at("new")).map((p) => [
      p.id,
      ["old", "b1", "b2", "new"].find((tag) => at(tag) === p.commit),
    ]);

  test.each([
    {
      reason: "a rung pruned before the tip still runs, from the newest commit that carried it",
      old: "old",
      expected: [
        ["m0002_b", "b2"],
        ["m0003_c", "new"],
      ],
    },
    {
      reason: "a rung on the recorded tree is crossed for good",
      old: "b1",
      expected: [["m0003_c", "new"]],
    },
    { reason: "identical trees run nothing", old: "new", expected: [] },
    {
      reason: "no usable base is the delivered tree alone: a pruned rung never runs",
      old: null,
      expected: [
        ["m0001_a", "new"],
        ["m0003_c", "new"],
      ],
    },
  ])("$reason", ({ old, expected }) => {
    expect(pending(old)).toEqual(expected);
  });

  test("a rung on the recorded tree that was pruned and re-added later never runs again", () => {
    const a = rungSource("m0001_a");
    const readded = platform([
      { tag: "old", rungs: { "m0001_a.ts": a } },
      { tag: "b1", rungs: {} },
      { tag: "new", rungs: { "m0001_a.ts": a } },
    ]);
    expect(pendingRungs(readded, sha(readded, "old"), sha(readded, "new"))).toEqual([]);
  });

  test("filename order, whatever order the commits added the files in", () => {
    const later = platform([
      { tag: "old", rungs: {} },
      { tag: "b1", rungs: { "m0002_b.ts": rungSource("m0002_b") } },
      {
        tag: "new",
        rungs: { "m0002_b.ts": rungSource("m0002_b"), "m0001_a.ts": rungSource("m0001_a") },
      },
    ]);
    expect(pendingRungs(later, sha(later, "old"), sha(later, "new")).map((p) => p.id)).toEqual([
      "m0001_a",
      "m0002_b",
    ]);
  });

  test("two rung files sharing a number in one build commit throw: ladder order is ambiguous", () => {
    const twins = platform([
      { tag: "old", rungs: {} },
      {
        tag: "new",
        rungs: { "m0002_a.ts": rungSource("m0002_a"), "m0002_b.ts": rungSource("m0002_b") },
      },
    ]);
    expect(() => pendingRungs(twins, sha(twins, "old"), sha(twins, "new"))).toThrow(
      new Error(
        `the build commit ${sha(twins, "new").slice(0, 12)} carries two rungs numbered 0002 (m0002_a.ts, m0002_b.ts); ladder order is ambiguous`,
      ),
    );
  });

  test.each([
    {
      reason: "an unresolvable base",
      old: "0123456789abcdef0123456789abcdef01234567",
      error: "git rev-list failed",
    },
    { reason: "a stray path under migrations/", old: "old", error: "which is not a rung file" },
  ])("$reason throws instead of reading as nothing pending", ({ old, error }) => {
    const stray = platform([
      { tag: "old", rungs: {} },
      { tag: "new", rungs: { "README.md": "not a rung\n" } },
    ]);
    expect(() =>
      pendingRungs(stray, old === "old" ? sha(stray, "old") : old, sha(stray, "new")),
    ).toThrow(error);
  });

  test("rungFiles lists a commit's rung files and only those", () => {
    expect(rungFiles(dir, at("b2"))).toEqual(["m0001_a.ts", "m0002_b.ts", "m0003_c.ts"]);
    expect(rungFiles(dir, at("old"))).toEqual(["m0001_a.ts"]);
    expect(() => rungFiles(dir, "no-such-ref")).toThrow("git ls-tree failed");
  });
});

describe("loadRung and applyRung: the rung contract", () => {
  const load = (source: string, id = "m0001_a") => {
    const dir = platform([{ tag: "new", rungs: { [`${id}.ts`]: source } }]);
    const pending: PendingRung = { file: `${id}.ts`, id, commit: sha(dir, "new") };
    return loadRung(fetchRungs(dir, [pending], temp.dir("rung-scratch-"))[0]);
  };

  test("a rung loads from its build commit's blob, not from the checkout", () => {
    const rung = load(rungSource("m0001_a", { stamp: "from-history" }));
    const target = repo({});
    expect(rung.id).toBe("m0001_a");
    expect(applyRung(rung, { dir: target, oldSha: null, newSha: "n" }, false)).toEqual({
      kind: "verdict",
      verdict: { kind: "planted", note: null },
    });
    expect(readFileSync(join(target, ".github/m0001_a.txt"), "utf-8")).toBe(
      "null|n|from-history\n",
    );
  });

  test.each([
    { reason: "no default export", source: 'export const x = { id: "m0001_a", apply() {} };\n' },
    { reason: "an id that is not the filename", source: rungSource("m0009_z") },
    { reason: "no apply", source: 'export default { id: "m0001_a" };\n' },
  ])("$reason is a hard error naming the file and commit", ({ source }) => {
    expect(() => load(source)).toThrow("does not default-export a rung");
  });

  test.each([
    {
      reason: "a throw",
      body: '    throw new Error("boom");',
      message: "threw: boom",
    },
    {
      reason: "a bare string",
      body: '    return "moved";',
      message: "returned a value that is neither a verdict nor the error arm",
    },
    {
      reason: "a verdict with a malformed note",
      body: '    return { kind: "verdict", verdict: { kind: "x", note: "text only" } };',
      message: "returned a value that is neither a verdict nor the error arm",
    },
    {
      reason: "the error arm, passed through",
      body: '    return { kind: "error", message: "refused by the rung" };',
      message: "refused by the rung",
    },
  ])("$reason becomes the error arm", ({ body, message }) => {
    const rung = load(rungSource("m0001_a", { body }));
    expect(applyRung(rung, { dir: repo({}), oldSha: null, newSha: "n" }, false)).toEqual({
      kind: "error",
      message,
    });
  });

  test("a hidden target gets the value-free form of a thrown message", () => {
    const rung = load(
      rungSource("m0001_a", { body: '    throw new Error("/private/path leaked");' }),
    );
    expect(applyRung(rung, { dir: repo({}), oldSha: null, newSha: "n" }, true)).toEqual({
      kind: "error",
      message: expect.stringMatching(/^threw \(detail hidden: private repository\)/),
    });
    expect(
      applyRung(rung, { dir: repo({}), oldSha: null, newSha: "n" }, true).message,
    ).not.toContain("leaked");
  });
});

describe("runRungs, commitStaged, writeReports", () => {
  const fake = (id: string, outcome: () => unknown, stage?: (dir: string) => void) => {
    const calls: string[] = [];
    const rung = {
      id,
      apply: (target: { dir: string }) => {
        calls.push(target.dir);
        stage?.(target.dir);
        return outcome();
      },
    } as unknown as Rung;
    return { rung, calls };
  };
  const verdict = (kind: string, note: { text: string; review: boolean } | null = null) => ({
    kind: "verdict",
    verdict: { kind, note },
  });
  const pendingOf = (...rungs: Rung[]) =>
    rungs.map((rung) => ({ file: `${rung.id}.ts`, id: rung.id, commit: "c" }));
  const loader = (...rungs: Rung[]) => {
    const byId = new Map(rungs.map((rung) => [rung.id, rung]));
    return (entry: PendingRung) => byId.get(entry.id) as Rung;
  };
  const options = { hidden: false, ignoredBefore: new Set<string>() };

  test("runs in order, commits each rung's staged changes as the sync identity, routes notes, stops at the first error", () => {
    const dir = repo({});
    const a = fake(
      "m0001_a",
      () => verdict("moved", { text: "> a moved", review: false }),
      (d) => {
        writeFileSync(join(d, "a.txt"), "a\n");
        git(d, "add", "a.txt");
      },
    );
    const b = fake("m0002_b", () =>
      verdict("in-place", { text: "> b needs a look", review: true }),
    );
    const c = fake("m0003_c", () => ({ kind: "error", message: "c refused" }));
    const d = fake("m0004_d", () => verdict("x"));
    const outcome = runRungs(
      { dir, oldSha: "o", newSha: "n" },
      pendingOf(a.rung, b.rung, c.rung, d.rung),
      loader(a.rung, b.rung, c.rung, d.rung),
      options,
    );
    expect(outcome).toEqual({
      applied: [
        {
          id: "m0001_a",
          kind: "moved",
          note: { text: "> a moved", review: false },
          committed: true,
        },
        {
          id: "m0002_b",
          kind: "in-place",
          note: { text: "> b needs a look", review: true },
          committed: false,
        },
      ],
      error: { id: "m0003_c", message: "c refused" },
    });
    expect(d.calls).toEqual([]);
    expect(git(dir, "log", "--format=%an %s")).toBe(
      "repo-platform-sync chore: run migration m0001_a\nt target state\n",
    );
    expect(git(dir, "log", "-1", "--name-status", "--format=")).toBe("A\ta.txt\n");
    expect(git(dir, "status", "--porcelain")).toBe("");
    const out = temp.dir("reports-");
    writeReports(out, outcome);
    expect(reports(out)).toEqual({ info: "> a moved\n", review: "> b needs a look\n" });
  });

  test.each([
    {
      reason: "an unstaged edit",
      files: { "keep.txt": "k\n" },
      touch: (d: string) => writeFileSync(join(d, "keep.txt"), "changed\n"),
    },
    {
      reason: "a new ignored file (invisible to plain porcelain)",
      files: { ".gitignore": "scratch.log\n" },
      touch: (d: string) => writeFileSync(join(d, "scratch.log"), "debris\n"),
    },
    {
      reason:
        "a new file under an ignored directory that already held one (porcelain collapses the directory)",
      files: { ".gitignore": "scratch/\n" },
      before: { "scratch/a.log": "old\n" },
      touch: (d: string) => writeFileSync(join(d, "scratch/b.log"), "debris\n"),
    },
  ])("a rung that left $reason behind is the error arm, named", ({ files, before, touch }) => {
    const dir = repo(files);
    for (const [rel, content] of Object.entries(before ?? {})) {
      mkdirSync(join(dir, rel, ".."), { recursive: true });
      writeFileSync(join(dir, rel), content);
    }
    const sloppy = fake("m0001_a", () => verdict("moved"), touch);
    const outcome = runRungs(
      { dir, oldSha: "o", newSha: "n" },
      pendingOf(sloppy.rung),
      loader(sloppy.rung),
      // The snapshot the runner itself takes, so a listing that collapsed
      // the directory would read the sibling as nothing new.
      { hidden: false, ignoredBefore: new Set(ignoredPaths(dir)) },
    );
    expect(outcome).toEqual({
      applied: [],
      error: {
        id: "m0001_a",
        message: expect.stringContaining("1 unstaged, untracked, or ignored path(s)"),
      },
    });
    expect(git(dir, "rev-list", "--count", "HEAD").trim()).toBe("1");
  });

  test("an ignored file present before the ladder is not the rung's leftover", () => {
    const dir = repo({ ".gitignore": "scratch.log\n" });
    writeFileSync(join(dir, "scratch.log"), "pre-existing\n");
    const idle = fake("m0001_a", () => verdict("in-place"));
    const outcome = runRungs(
      { dir, oldSha: "o", newSha: "n" },
      pendingOf(idle.rung),
      loader(idle.rung),
      { hidden: false, ignoredBefore: new Set(ignoredPaths(dir)) },
    );
    expect(outcome).toEqual({
      applied: [{ id: "m0001_a", kind: "in-place", note: null, committed: false }],
      error: null,
    });
  });

  test("silent verdicts write two empty reports (present, so an absent file never reads as no run)", () => {
    const out = temp.dir("reports-");
    writeReports(out, {
      applied: [{ id: "m0001_a", kind: "in-place", note: null, committed: false }],
      error: null,
    });
    expect(reports(out)).toEqual({ info: "", review: "" });
  });
});

describe("applyPending and the CLI", () => {
  test("a dirty target checkout is refused before any rung runs", () => {
    const dir = chain();
    const target = repo({});
    writeFileSync(join(target, "stray.txt"), "uncommitted\n");
    expect(() =>
      applyPending({
        platformDir: dir,
        targetDir: target,
        oldSha: sha(dir, "old"),
        newSha: "new",
        runnerTemp: temp.dir("ladder-"),
        hidden: false,
      }),
    ).toThrow("1 uncommitted path(s)");
    expect(existsSync(join(target, ".github/m0002_b.txt"))).toBe(false);
  });

  test("the fetched rung sources are removed after a run, on the verdict and error paths alike", () => {
    const dir = chain();
    const ok = runLadder(dir, repo({}), "old");
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toContain("migration m0002_b -> planted (committed)");
    expect(existsSync(join(ok.temp, "migrations"))).toBe(false);
    const refusing = platform([
      { tag: "old", rungs: {} },
      {
        tag: "new",
        rungs: {
          "m0001_a.ts": rungSource("m0001_a", {
            body: '    return { kind: "error", message: "refused" };',
          }),
        },
      },
    ]);
    const failed = runLadder(refusing, repo({}), "old");
    expect(failed.exitCode).not.toBe(0);
    expect(failed.stdout).toContain("::error::Vivswan/demo: migration m0001_a: refused");
    expect(existsSync(join(failed.temp, "migrations"))).toBe(false);
  });

  test("THE history run: a pruned rung runs from the commit that last carried it, committed and reported", () => {
    const dir = chain();
    const target = repo({});
    const result = runLadder(dir, target, "old");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Vivswan/demo: migration m0002_b -> planted (committed)");
    expect(result.stdout).toContain("Vivswan/demo: migration m0003_c -> planted (committed)");
    expect(result.stdout).not.toContain("m0001_a");
    // The v2 copy (b2's) ran, with the walk's two shas as the target saw them.
    expect(readFileSync(join(target, ".github/m0002_b.txt"), "utf-8")).toBe(
      `${sha(dir, "old")}|${sha(dir, "new")}|v2\n`,
    );
    expect(git(target, "log", "--format=%an %s")).toBe(
      "repo-platform-sync chore: run migration m0003_c\nrepo-platform-sync chore: run migration m0002_b\nt target state\n",
    );
    expect(reports(result.temp)).toEqual({ info: "", review: "" });
  });

  test("identical trees run nothing and write empty reports", () => {
    const dir = chain();
    const target = repo({});
    const result = runLadder(dir, target, "new");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no pending migrations");
    expect(result.stdout).not.toContain("migration m");
    expect(git(target, "rev-list", "--count", "HEAD").trim()).toBe("1");
    expect(reports(result.temp)).toEqual({ info: "", review: "" });
  });

  test("no usable base runs every rung on the delivered tree and says so", () => {
    const dir = chain();
    const target = repo({});
    const result = runLadder(dir, target, "");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no usable base");
    expect(result.stdout).toContain("migration m0001_a -> planted");
    expect(result.stdout).toContain("migration m0003_c -> planted");
    expect(result.stdout).not.toContain("m0002_b");
    expect(readFileSync(join(target, ".github/m0001_a.txt"), "utf-8")).toBe(
      `null|${sha(dir, "new")}|\n`,
    );
  });

  test("an OLD_SHA that is not a full sha or empty is refused before any tree is read", () => {
    const result = runLadderWithOldSha(chain(), repo({}), "origin/build");
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain(
      "::error::Vivswan/demo: OLD_SHA must be a full 40-hex commit sha or empty",
    );
  });

  test("an UNSET OLD_SHA is a wiring mistake, never the no-base signal: nothing runs", () => {
    const dir = chain();
    const target = repo({});
    const result = runLadderWithOldSha(dir, target, undefined);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("::error::Vivswan/demo: OLD_SHA is not set");
    expect(result.stdout).not.toContain("no usable base");
    expect(existsSync(join(target, ".github/m0001_a.txt"))).toBe(false);
    expect(git(target, "rev-list", "--count", "HEAD").trim()).toBe("1");
  });

  test("ignoredPaths lists ignored files only: an untracked unignored file is dirtyPaths' business", () => {
    const dir = repo({ ".gitignore": "*.log\n" });
    writeFileSync(join(dir, "a.log"), "ignored\n");
    writeFileSync(join(dir, "tmp.txt"), "untracked\n");
    expect(ignoredPaths(dir)).toEqual(["a.log"]);
  });

  test("a build commit carrying a non-rung path under migrations/ fails the step with ::error:: on stdout", () => {
    const dir = platform([
      { tag: "old", rungs: {} },
      { tag: "new", rungs: { "notes.txt": "stray\n" } },
    ]);
    const result = runLadder(dir, repo({}), "old");
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("::error::Vivswan/demo: the build commit");
    expect(result.stdout).toContain("migrations/notes.txt, which is not a rung file");
  });

  test("a rung's error arm fails the step after the reports for the rungs that ran are written", () => {
    const dir = platform([
      { tag: "old", rungs: {} },
      {
        tag: "new",
        rungs: {
          "m0001_a.ts": rungSource("m0001_a", { note: { text: "> a ran", review: false } }),
          "m0002_b.ts": rungSource("m0002_b", {
            body: '    return { kind: "error", message: "refused" };',
          }),
        },
      },
    ]);
    const result = runLadder(dir, repo({}), "old");
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain(
      "::notice::Vivswan/demo: migration m0001_a -> planted (committed) (the PR body carries the note)",
    );
    expect(result.stdout).toContain("::error::Vivswan/demo: migration m0002_b: refused");
    expect(reports(result.temp)).toEqual({ info: "> a ran\n", review: "" });
  });
});
