// Recovery mode (recover=recopy): a repo whose recorded _commit is unusable
// gets a full re-render via sync/apply_update.ts. The copier semantics
// that path relies on: `copier recopy --overwrite` runs without a
// resolvable _commit, respects _skip_if_exists (generated-once files keep
// local edits), deletes nothing, overwrites template-managed files, and
// re-records _commit; the local-content carry and the preserve step bring
// the repo-owned sides back over the re-render.

import { expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { dropLinesContaining, editText, insertBeforeLine, linesOf } from "./edits";
import {
  answersOf,
  appendText,
  commitAll,
  describeLeg,
  git,
  isCleanTree,
  isEmptyFile,
  legTest,
  lexists,
  MARKERS,
  manifestEntry,
  REPO_ROOT,
  readText,
  recordedCommit,
  sha256File,
  stampManifest,
  syncScript,
  upgradePathHarness,
  validateGenerated,
} from "./fixture";
import { LOCAL_NOTES, type MainProject, mainEnv, mainUpdate } from "./main_update";

const harness = upgradePathHarness();

const MIRRORS_DECLARATION =
  "mirrors:\n  - source: AGENTS.md\n    targets:\n      - copies/AGENTS.md\n";

/** Repo-owned content the local-content carry must bring back over the
 * re-render: tails below END markers, a .gitignore entry ABOVE the BEGIN
 * marker, and an unsplittable .gitattributes (its marker pair stripped) that
 * must ride whole under the recovery appendix. */
const CARRIED: Record<string, string> = {
  "AGENTS.md": "recovery-local agents note",
  ".editorconfig": "[recovery-local/**.js]",
  ".github/CODEOWNERS": "/recovery-local/ @recovery-local-owner",
  ".gitignore": "recovery-local-cache/",
  ".gitattributes": "recovery-local-attr binary",
};

describeLeg("02 recovery recopy", () => {
  let mp: MainProject;
  let modules: string;
  let at: (rel: string) => string;
  let work: (rel: string) => string;
  let registrationBeforeRecopy: string;

  legTest(
    "the synced fixture gets a corrupt base, a managed-file edit, and repo-owned content",
    () => {
      ({
        mp,
        update: { modules },
      } = mainUpdate(harness.fixture()));
      at = (rel) => join(mp.project, rel);
      work = (rel) => join(mp.work, rel);
      commitAll(mp.project, "chore: template update");
      // Corrupt the recorded base the way a lost build branch would, and add a
      // local edit to a template-managed file (recovery legitimately drops it).
      editText(at(".github/.copier-answers.yml"), (text) =>
        text.replace(/^_commit: .*$/m, "_commit: deadbeef"),
      );
      expect(recordedCommit(answersOf(mp.project))).toBe("deadbeef");
      appendText(at(".github/workflows/ci.yml"), `${LOCAL_NOTES.ci}\n`);
      // The registration starter must hold under recopy --overwrite too: the
      // repo-owned `mirrors` declaration lives in it, and a recopy that
      // re-rendered the file would silently drop the key.
      appendText(at(".repo-platform.yml"), MIRRORS_DECLARATION);
      registrationBeforeRecopy = readText(at(".repo-platform.yml"));
      appendText(at("AGENTS.md"), `${CARRIED["AGENTS.md"]}\n`);
      appendText(at(".editorconfig"), `${CARRIED[".editorconfig"]}\nindent_size = 3\n`);
      appendText(at(".github/CODEOWNERS"), `${CARRIED[".github/CODEOWNERS"]}\n`);
      editText(at(".gitignore"), (text) =>
        insertBeforeLine(
          text,
          (line) => line === MARKERS.hash.begin,
          [CARRIED[".gitignore"]],
          "plant the .gitignore entry above the managed region",
        ),
      );
      appendText(at(".gitattributes"), `${CARRIED[".gitattributes"]}\n`);
      editText(at(".gitattributes"), (text) =>
        dropLinesContaining(dropLinesContaining(text, MARKERS.hash.begin), MARKERS.hash.end),
      );
      commitAll(mp.project, "chore: corrupt the base");
    },
  );

  legTest("the ladder with no base runs every rung of the new tree once, each idempotent", () => {
    // Recovery resolves an empty OLD_SHA: no base tree, so EVERY rung runs -
    // and this fixture crossed them all in the main update, so each is
    // idempotent here: same HEAD, clean tree, both reports written and empty.
    const head = git(mp.project, "rev-parse", "HEAD");
    const out = syncScript("run_migrations", {
      ...mainEnv(mp, modules),
      OLD_SHA: "",
      PLATFORM_DIR: REPO_ROOT,
    });
    // Every rung file on the new tree RAN exactly once, in ladder (filename)
    // order, and reported a verdict: the no-op postconditions alone cannot
    // tell a skipped rung from an idempotent one.
    const rungs = linesOf(
      `${git(REPO_ROOT, "ls-tree", "--name-only", mp.fx.new.tag, "migrations/")}\n`,
    ).map((path) => path.replace(/^migrations\//, "").replace(/\.ts$/, ""));
    const ran = linesOf(out).flatMap((line) => {
      const match = /^.*: migration (m[0-9]{4}_[a-z0-9_]+) -> .*$/.exec(line);
      return match === null ? [] : [match[1]];
    });
    expect(ran).toEqual(rungs);
    expect(git(mp.project, "rev-parse", "HEAD")).toBe(head);
    expect(isCleanTree(mp.project)).toBe(true);
    for (const report of ["migrations.md", "migrations-review.md"]) {
      expect(existsSync(work(report))).toBe(true);
      expect(isEmptyFile(work(report))).toBe(true);
    }
  });

  legTest(
    "recopy re-records the base, keeps the repo-owned files, and re-renders the managed ones",
    () => {
      // The wrapper, the local-content carry, and the repo-owned preserve step
      // in the workflow's order, proving their RECOVER routing.
      const env = { ...mainEnv(mp, modules), RECOVER: "recopy" };
      syncScript("apply_update", env);
      syncScript("preserve_local_content", env, [
        "--summary",
        work("local-carryover.md"),
        "--root",
        mp.project,
      ]);
      syncScript("preserve_repo_owned", env);
      stampManifest(mp.project);

      expect(recordedCommit(answersOf(mp.project))).toBe(mp.fx.new.sha);
      // _skip_if_exists must hold under recopy --overwrite.
      expect(readText(at(".github/workflows/checks.yml"))).toContain(LOCAL_NOTES.checks);
      // The main update dropped the issue form; the recopy renders none.
      expect(lexists(at(".github/ISSUE_TEMPLATE/bug_report.yml"))).toBe(false);
      expect(readText(at(".repo-platform.yml"))).toBe(registrationBeforeRecopy);
      // custom-license de-renders LICENSE.md and recopy deletes nothing.
      expect(readText(at("LICENSE.md"))).toBe(`${LOCAL_NOTES.license}\n`);
      expect(readText(at("src/keep_me.txt"))).toBe(`${LOCAL_NOTES.keepMe}\n`);
      expect(readText(at(".github/settings.yml"))).toContain(LOCAL_NOTES.settings);
      // recopy must overwrite the template-managed ci.yml.
      expect(readText(at(".github/workflows/ci.yml"))).not.toContain(LOCAL_NOTES.ci);
      for (const [rel, content] of Object.entries(CARRIED))
        expect(readText(at(rel))).toContain(content);
      // The main update retired CONTRIBUTING.md; the recopy renders no such
      // file, so nothing brings it back.
      expect(lexists(at("CONTRIBUTING.md"))).toBe(false);
      // The unsplittable previous copy rides whole under the appendix marker.
      expect(readText(at(".gitattributes"))).toContain("# repo-platform:recovery-appendix");
      const summary = readText(work("local-carryover.md"));
      for (const rel of Object.keys(CARRIED)) expect(summary).toContain(rel);
      validateGenerated(mp.project);
      // The recopy carry steps run after copier's own stamp hook, so the final
      // stamp must leave the managed ci.yml hash matching the re-rendered file.
      expect(manifestEntry(mp.project, ".github/workflows/ci.yml")?.hash).toBe(
        sha256File(at(".github/workflows/ci.yml")),
      );
    },
  );
});
