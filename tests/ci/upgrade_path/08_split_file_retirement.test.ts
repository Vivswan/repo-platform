// Split-file retirement: the template stops rendering a file HEAD's manifest
// classes `split` (the community health files moving to the account's
// .github defaults retire CONTRIBUTING.md). Copier resolves delete-vs-modify
// by dropping the file and retired_cleanup rms retired paths outright, so
// the repository-owned half leaves with the deletion; the class-level hold
// (preserve_repo_owned.ts -> removed-splits.md -> open_pr.ts) must name that
// half and keep the PR manual, on this rule ALONE: no license machinery is
// involved, and the tail tripwire must stay clear (the retired path is
// absent from the post-sync manifest by design, so the wire never visits it).

import { expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { linesOf } from "./edits";
import {
  answersAtHead,
  appendText,
  commitAll,
  describeLeg,
  type Fixture,
  ghStub,
  isEmptyFile,
  legTest,
  lexists,
  manifestEntry,
  openPr,
  preserveLocalContentArgs,
  readText,
  recordedSrcPath,
  renderProject,
  resolveConflictsArgs,
  retiredPaths,
  type ScriptEnv,
  selectModules,
  snapshotCopierYml,
  stampManifest,
  syncScript,
  upgradePathHarness,
  validateGenerated,
} from "./fixture";

const harness = upgradePathHarness();

const DESCRIPTION = "Split-retirement project";
const CONTRIBUTING_TAIL = "\n## Local contributing docs\n\nretire-local contributing tail\n";

describeLeg("08 split file retirement", () => {
  let fx: Fixture;
  let project: string;
  let work: string;
  let env: ScriptEnv;

  legTest(
    "the old-build fixture commits a repo-owned tail on the split-classed CONTRIBUTING.md",
    () => {
      fx = harness.fixture();
      project = fx.path("upgrade-retire");
      work = fx.mkdir("upgrade-retire-work");
      renderProject(project, fx.old.tag, {
        projectName: "Split Retirement",
        description: DESCRIPTION,
        modules: ["uv"],
        private: false,
      });
      expect(manifestEntry(project, "CONTRIBUTING.md")?.class).toBe("split");
      appendText(join(project, "CONTRIBUTING.md"), CONTRIBUTING_TAIL);
      commitAll(project, "chore: init with contributing tail");
    },
  );

  legTest("the update retires CONTRIBUTING.md and raises the removed-splits hold", () => {
    // The workflow's leg order: the ladder, then the update and its
    // post-update steps.
    snapshotCopierYml(work, fx.old.tag, fx.new.tag);
    const base = { TARGET_DIR: project, TARGET_REF: fx.new.tag, RUNNER_TEMP: work };
    syncScript("run_migrations", { ...base, OLD_SHA: fx.old.sha });
    env = {
      ...base,
      MODULES: selectModules(join(project, ".repo-platform.yml"), join(work, "copier-new.yml")),
      PRIVATE: "false",
      DESCRIPTION,
      RECOVER: "",
    };
    syncScript("apply_update", env);
    const renders = {
      ...env,
      SRC_PATH: recordedSrcPath(answersAtHead(project)),
      OLD_SHA: fx.old.sha,
    };
    syncScript("clean_renders", renders);
    syncScript("preserve_local_content", env, preserveLocalContentArgs(project, work));
    syncScript("resolve_copier_conflicts", env, resolveConflictsArgs(project, work, true));
    syncScript("retired_cleanup", renders);
    expect(retiredPaths(work)).toContain("CONTRIBUTING.md");
    expect(lexists(join(project, "CONTRIBUTING.md"))).toBe(false);
    syncScript("preserve_repo_owned", env);
    // The preserve step restores settings.yml and a custom license only:
    // the split file stays gone.
    expect(lexists(join(project, "CONTRIBUTING.md"))).toBe(false);
    stampManifest(project);
    expect(manifestEntry(project, "CONTRIBUTING.md")).toBeUndefined();
    syncScript("tail_tripwire", env, ["--root", project]);

    // The hold must come from the removal rule alone.
    const tailShrank = join(work, "tail-shrank.md");
    expect(!existsSync(tailShrank) || isEmptyFile(tailShrank)).toBe(true);
    const removedSplits = join(work, "removed-splits.md");
    expect(existsSync(removedSplits)).toBe(true);
    expect(isEmptyFile(removedSplits)).toBe(false);
    const hold = readText(removedSplits);
    expect(hold).toContain("`CONTRIBUTING.md`");
    expect(hold).toContain("retire-local contributing tail");
    validateGenerated(project);
  });

  legTest("open_pr names the leaving content and leaves auto-merge off on the hold alone", () => {
    // The only other non-empty inputs, the removed-paths list and the carry
    // summary, are informational and never force review.
    const stub = ghStub(work);
    const out = openPr(work, stub, "Vivswan/split-retirement", {
      CARRIED_FILE: join(work, "local-carryover.md"),
      CARRY_REVIEW_FILE: join(work, "carry-review.txt"),
      REMOVED_PATHS_FILE: join(work, "removed-paths.txt"),
    });
    expect(out).toContain("auto-merge left off");
    expect(readText(join(work, "pr-body.md"))).toContain("retire-local contributing tail");
    const calls = linesOf(readText(stub.calls));
    expect(calls.filter((line) => line.startsWith("gh pr merge"))).toEqual([]);
  });
});
