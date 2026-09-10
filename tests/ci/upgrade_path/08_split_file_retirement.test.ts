// Split-file retirement (a visibility flip de-renders CONTRIBUTING.md): a
// render condition turning false retires a file from the render, and a
// retired file HEAD's manifest classes `split` carries a repository-owned
// half that leaves WITH the deletion (copier resolves delete-vs-modify by
// dropping the file; retired_cleanup rms retired paths outright). No module
// ships a split file, so the public-only CONTRIBUTING.md going private is
// the case. The class-level hold (preserve_repo_owned.ts ->
// removed-splits.md -> open_pr.ts) must name the leaving content and keep
// the PR manual, on this rule ALONE: no license machinery is involved, and
// the tail tripwire must stay clear (the retired path is absent from the
// post-sync manifest by design, so the wire never visits it).

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
  openPr,
  preserveLocalContentArgs,
  readText,
  recordedSrcPath,
  renderProject,
  resolveConflictsArgs,
  type ScriptEnv,
  snapshotCopierYml,
  stampManifest,
  syncScript,
  upgradePathHarness,
} from "./fixture";

const harness = upgradePathHarness();

const DESCRIPTION = "Split-retirement project";
const CONTRIBUTING_TAIL = "deselect-local contributing tail";

describeLeg("08 split file retirement", () => {
  let fx: Fixture;
  let project: string;
  let work: string;
  let env: ScriptEnv;

  legTest(
    "the public fixture commits a repo-owned tail on the split-classed CONTRIBUTING.md",
    () => {
      fx = harness.fixture();
      project = fx.path("upgrade-deselect");
      work = fx.mkdir("upgrade-deselect-work");
      renderProject(project, fx.new.tag, {
        projectName: "Split Retirement",
        description: DESCRIPTION,
        modules: ["uv"],
        private: false,
      });
      appendText(
        join(project, "CONTRIBUTING.md"),
        `\n## Local contributing docs\n\n${CONTRIBUTING_TAIL}\n`,
      );
      commitAll(project, "chore: init with contributing tail");
    },
  );

  legTest("the flip to private retires CONTRIBUTING.md and raises the removed-splits hold", () => {
    // The live data says PRIVATE=true (the flip that de-renders the file),
    // then the workflow's leg order.
    env = {
      MODULES: '["uv"]',
      PRIVATE: "true",
      DESCRIPTION,
      TARGET_DIR: project,
      TARGET_REF: fx.new.tag,
      RUNNER_TEMP: work,
      RECOVER: "",
    };
    syncScript("apply_update", env);
    const renders = {
      ...env,
      SRC_PATH: recordedSrcPath(answersAtHead(project)),
      OLD_SHA: fx.new.sha,
    };
    syncScript("clean_renders", renders);
    syncScript("preserve_local_content", env, preserveLocalContentArgs(project, work));
    syncScript("resolve_copier_conflicts", env, resolveConflictsArgs(project, work, true));
    snapshotCopierYml(work, fx.new.tag, fx.new.tag);
    syncScript("retired_cleanup", renders);
    expect(lexists(join(project, "CONTRIBUTING.md"))).toBe(false);
    syncScript("preserve_repo_owned", env);
    stampManifest(project);
    syncScript("tail_tripwire", env, ["--root", project]);

    // The hold must come from the removal rule alone.
    const tailShrank = join(work, "tail-shrank.md");
    expect(!existsSync(tailShrank) || isEmptyFile(tailShrank)).toBe(true);
    const removedSplits = join(work, "removed-splits.md");
    expect(existsSync(removedSplits)).toBe(true);
    expect(isEmptyFile(removedSplits)).toBe(false);
    const hold = readText(removedSplits);
    expect(hold).toContain("`CONTRIBUTING.md`");
    expect(hold).toContain(CONTRIBUTING_TAIL);
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
    expect(readText(join(work, "pr-body.md"))).toContain(CONTRIBUTING_TAIL);
    const calls = linesOf(readText(stub.calls));
    expect(calls.filter((line) => line.startsWith("gh pr merge"))).toEqual([]);
  });
});
