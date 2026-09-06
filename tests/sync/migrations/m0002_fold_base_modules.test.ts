// m0002: the agents/auto-assign/settings-sync fold - the rung's
// line-level rewrite of .repo-platform.yml's modules list against scratch
// checkouts (the edit left staged for the runner's commit; comments,
// mirrors, and list style untouched), its idempotency, the shapes it
// leaves to module selection, the error arms, and the runner CLI over a
// build history in which the rung appears.

import { describe, expect, test } from "bun:test";
import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import rung from "../../../.github/scripts/sync/migrations/m0002_fold_base_modules.ts";
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

const REGISTRATION = ".repo-platform.yml";
const apply = (dir: string) => typed.apply({ dir, oldSha: "old", newSha: "new" });

// The shape the template renders: a header comment and a JSON-style flow
// list in copier's choice order.
const RENDERED_HEAD =
  "# Generated once by Vivswan/repo-platform and repo-owned from\n# then on: the sync reads this file, it never rewrites it.\n\n";
const RENDERED = `${RENDERED_HEAD}modules: ["agents", "uv", "release-please", "auto-assign", "settings-sync"]\n`;
const RENDERED_AFTER = `${RENDERED_HEAD}modules: ["uv", "release-please"]\n`;

const NOTE = (dropped: string) =>
  [
    "> [!NOTE]",
    "> MODULE FOLD: `agents`, `auto-assign`, and `settings-sync` are no longer",
    "> modules - every managed repository renders their files unconditionally",
    "> (AGENTS.md and its agent-file symlinks, the Copilot review instructions",
    "> and setup starter, auto-assign.yml, settings-sync.yml, and the settings.yml",
    "> starter), and repository settings are applied centrally for every managed",
    "> repository. This update drops the retired name(s) from `.repo-platform.yml`'s",
    "> `modules` list - the rest of the file, comments and any `mirrors` declaration",
    "> included, is untouched - and copier records the shorter selection in",
    "> `.github/.copier-answers.yml`. No rendered file moves or leaves.",
    `> Dropped here: ${dropped}.`,
  ].join("\n");

describe("m0002_fold_base_modules", () => {
  test.each([
    {
      label: "the rendered flow list, header comment kept",
      before: RENDERED,
      after: RENDERED_AFTER,
      note: "`agents`, `auto-assign`, `settings-sync`",
    },
    {
      label: "a flow list with a trailing comment and mixed quoting",
      before: "modules: ['agents', uv, \"settings-sync\"] # keep me\nmirrors: []\n",
      after: "modules: [uv] # keep me\nmirrors: []\n",
      note: "`agents`, `settings-sync`",
    },
    {
      label: "a block list with item comments, a comment line, and a mirrors block",
      before:
        "modules:\n  - agents # agent files\n  # the toolchain\n  - uv\n  - settings-sync\nmirrors:\n  - source: LICENSE.md\n    targets: [copies/LICENSE.md]\n",
      after:
        "modules:\n  # the toolchain\n  - uv\nmirrors:\n  - source: LICENSE.md\n    targets: [copies/LICENSE.md]\n",
      note: "`agents`, `settings-sync`",
    },
    {
      label: "a block list of only folded names empties to [] and keeps the key comment",
      before: "modules: # selection\n  - agents\n  - auto-assign\n\n# tail comment\nmirrors: []\n",
      after: "modules: [] # selection\n\n# tail comment\nmirrors: []\n",
      note: "`agents`, `auto-assign`",
    },
    {
      label: "a flow list of only folded names empties to []",
      before: 'modules: ["settings-sync"]\n',
      after: "modules: []\n",
      note: "`settings-sync`",
    },
  ])("dropped: $label", ({ before, after, note }) => {
    const dir = repo({ [REGISTRATION]: before, "README.md": "readme\n" });
    expect(apply(dir)).toEqual({
      kind: "verdict",
      verdict: { kind: "dropped", note: { text: NOTE(note), review: false } },
    });
    expect(readFileSync(join(dir, REGISTRATION), "utf-8")).toBe(after);
    // Staged, not committed: the runner commits as the sync identity.
    expect(git(dir, "status", "--porcelain")).toBe(`M  ${REGISTRATION}\n`);
    expect(git(dir, "rev-list", "--count", "HEAD").trim()).toBe("1");
  });

  test("idempotent: a second run over the committed rewrite is in-place and stages nothing", () => {
    const dir = repo({ [REGISTRATION]: RENDERED });
    apply(dir);
    git(dir, "-c", "user.name=t", "-c", "user.email=t@x", "commit", "-qm", "dropped");
    expect(apply(dir)).toEqual({ kind: "verdict", verdict: { kind: "in-place", note: null } });
    expect(git(dir, "status", "--porcelain")).toBe("");
    expect(readFileSync(join(dir, REGISTRATION), "utf-8")).toBe(RENDERED_AFTER);
  });

  test.each([
    {
      label: "none of the three declared",
      files: { [REGISTRATION]: 'modules: ["uv", "pages"]\n' },
      kind: "in-place",
    },
    {
      label: "no registration file (selection reports the absence)",
      files: { "README.md": "readme\n" },
      kind: "missing",
    },
    {
      label: "a modules value that is not a list (selection reports the shape)",
      files: { [REGISTRATION]: "modules: agents\n" },
      kind: "unreadable",
    },
    {
      label: "a non-string entry (selection reports the shape)",
      files: { [REGISTRATION]: "modules: [agents, 3]\n" },
      kind: "unreadable",
    },
    {
      label: "unparseable YAML (selection reports the parse error)",
      files: { [REGISTRATION]: "modules: [agents\n" },
      kind: "unreadable",
    },
    {
      // Selection refuses a duplicate; rewriting it to [] would launder it.
      label: "a duplicate entry (selection refuses it)",
      files: { [REGISTRATION]: "modules: [agents, agents]\n" },
      kind: "unreadable",
    },
    {
      label: "an empty entry (selection refuses it)",
      files: { [REGISTRATION]: 'modules: [agents, ""]\n' },
      kind: "unreadable",
    },
  ])("nothing to do, nothing touched: $label", ({ files, kind }) => {
    const dir = repo(files);
    const before = git(dir, "ls-files", "-s");
    expect(apply(dir)).toEqual({ kind: "verdict", verdict: { kind, note: null } });
    expect(git(dir, "status", "--porcelain")).toBe("");
    expect(git(dir, "ls-files", "-s")).toBe(before);
  });

  // Shapes the line edit refuses rather than guesses at: the file is left
  // byte-identical and the arm tells the human what to do.
  test.each([
    {
      label: "a flow list spanning lines",
      text: 'modules: [\n  "agents",\n  "uv"\n]\n',
    },
    {
      label: "an aliased item",
      text: "agent: &agent agents\nmodules: [*agent, uv, settings-sync]\n",
    },
    {
      label: "a tagged scalar item",
      text: "modules: [!!str agents, uv]\n",
    },
  ])("$label is the hand-edit error arm", ({ text }) => {
    const dir = repo({ [REGISTRATION]: text });
    expect(apply(dir)).toEqual({
      kind: "error",
      message: expect.stringContaining("cannot be rewritten mechanically"),
    });
    expect(readFileSync(join(dir, REGISTRATION), "utf-8")).toBe(text);
    expect(git(dir, "status", "--porcelain")).toBe("");
  });

  test("a symlinked registration is the error arm: nothing is written through it", () => {
    const dir = repo({ "real.yml": RENDERED });
    symlinkSync("real.yml", join(dir, REGISTRATION));
    git(dir, "add", "-A");
    git(dir, "-c", "user.name=t", "-c", "user.email=t@x", "commit", "-qm", "symlinked");
    expect(apply(dir)).toEqual({
      kind: "error",
      message: expect.stringContaining("not a regular file"),
    });
    expect(readFileSync(join(dir, "real.yml"), "utf-8")).toBe(RENDERED);
    expect(git(dir, "status", "--porcelain")).toBe("");
  });

  test("an untracked registration cannot be staged: the arm names git's reason", () => {
    const dir = repo({});
    writeFileSync(join(dir, REGISTRATION), RENDERED);
    // The rewrite itself is fine; `git add` of an ignored path fails.
    writeFileSync(join(dir, ".gitignore"), `${REGISTRATION}\n`);
    expect(apply(dir)).toEqual({
      kind: "error",
      message: expect.stringMatching(/^git add \.repo-platform\.yml failed \(exit 1: /),
    });
  });
});

// Through the runner CLI, from a build history in which the rung appears
// after the recorded build: the rewrite is committed alone as the sync
// identity and the note lands in the informational report; a repository
// recorded at a build carrying the rung runs nothing.
describe("m0002 through run_migrations.ts", () => {
  const history = () =>
    platform([
      { tag: "old", rungs: {} },
      { tag: "new", rungs: { [`${rung.id}.ts`]: SOURCE } },
    ]);

  test("pending: the rewrite is committed alone and the note is informational", () => {
    const target = repo({ [REGISTRATION]: RENDERED, "README.md": "readme\n" });
    const result = runLadder(history(), target, "old");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      `::notice::Vivswan/demo: migration ${rung.id} -> dropped (committed) (the PR body carries the note)`,
    );
    expect(readFileSync(join(target, REGISTRATION), "utf-8")).toBe(RENDERED_AFTER);
    expect(git(target, "status", "--porcelain")).toBe("");
    expect(git(target, "log", "-1", "--format=%an %s").trim()).toBe(
      `repo-platform-sync chore: run migration ${rung.id}`,
    );
    expect(git(target, "log", "-1", "--name-status", "--format=")).toBe(`M\t${REGISTRATION}\n`);
    expect(readFileSync(join(result.temp, MIGRATIONS_NAME), "utf-8")).toBe(
      `${NOTE("`agents`, `auto-assign`, `settings-sync`")}\n`,
    );
    expect(readFileSync(join(result.temp, MIGRATIONS_REVIEW_NAME), "utf-8")).toBe("");
  });

  test("no usable base still runs the rung; a crossed target reports in-place without a commit", () => {
    const target = repo({ [REGISTRATION]: RENDERED });
    const first = runLadder(history(), target, "");
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain("no usable base");
    expect(first.stdout).toContain(`migration ${rung.id} -> dropped (committed)`);
    const again = runLadder(history(), target, "");
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toContain(`migration ${rung.id} -> in-place`);
    expect(again.stdout).not.toContain("(committed)");
    expect(git(target, "rev-list", "--count", "HEAD").trim()).toBe("2");
    expect(readFileSync(join(target, REGISTRATION), "utf-8")).toBe(RENDERED_AFTER);
  });

  test("the error arm fails the step with ::error:: on stdout and writes nothing", () => {
    const text = 'modules: [\n  "agents",\n  "uv"\n]\n';
    const target = repo({ [REGISTRATION]: text });
    const result = runLadder(history(), target, "old");
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain(
      `::error::Vivswan/demo: migration ${rung.id}: ${REGISTRATION}'s modules list cannot be rewritten mechanically`,
    );
    expect(readFileSync(join(target, REGISTRATION), "utf-8")).toBe(text);
    expect(git(target, "rev-list", "--count", "HEAD").trim()).toBe("1");
  });
});
