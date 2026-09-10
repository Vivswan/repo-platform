// Branch mode: a PR branch that changes the selection gets its render. The
// fixture (on main, synced to the fresh build) grows a branch that adds the
// fuzzer module to .repo-platform.yml, the way a managed repository's PR
// does. The module-render check must read that branch as STALE (the
// negative control), the sync legs run against the branch exactly as
// reusable-template-sync.yml runs them in branch mode, and the check must
// then read the branch as FRESH - with the render landed on the branch and
// the default branch untouched.

import { expect } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { editText } from "./edits";
import {
  answersOf,
  appendText,
  commitAll,
  describeLeg,
  git,
  legTest,
  lexists,
  manifestEntry,
  preserveLocalContentArgs,
  REPO_ROOT,
  readText,
  recordedSrcPath,
  resolveConflictsArgs,
  selectModules,
  stampManifest,
  syncScript,
  tryRun,
  upgradePathHarness,
  validateGenerated,
  workflowJob,
} from "./fixture";
import { LOCAL_NOTES, type MainProject, mainEnv, mainUpdate } from "./main_update";

const harness = upgradePathHarness();

const STALE_LINES = [
  "::error file=.github/workflows/ci.yml::module-render: .github/workflows/ci.yml does not match the render of the selected modules",
  "::error file=.github/.copier-answers.yml::module-render: .github/.copier-answers.yml does not match the render of the selected modules",
  "push it with: gh workflow run sync-repos.yml -R Vivswan/repo-platform -f repo=Vivswan/upgrade-test -f branch=select-fuzzer",
];

describeLeg("12 branch render", () => {
  let mp: MainProject;
  let at: (rel: string) => string;
  let mainHead: string;
  let branchBase: string;
  let branchWork: string;
  let renderOut: string;

  /** The check the fleet-ci module-render job runs, against the fixture's own
   * template clone (--src) at the recorded _commit. */
  const renderCheck = (): number => {
    const result = tryRun(
      [
        "bun",
        join(REPO_ROOT, "actions/module-render/src/render.ts"),
        "--root",
        mp.project,
        "--src",
        REPO_ROOT,
      ],
      {
        env: {
          RUNNER_TEMP: mp.work,
          GITHUB_REPOSITORY: "Vivswan/upgrade-test",
          GITHUB_HEAD_REF: "select-fuzzer",
        },
        timeoutMs: 270_000,
      },
    );
    renderOut = result.stdout + result.stderr;
    return result.exitCode;
  };

  legTest(
    "a branch selects the fuzzer module and carries a local note in the managed ci.yml",
    () => {
      ({ mp } = mainUpdate(harness.fixture()));
      at = (rel) => join(mp.project, rel);
      commitAll(mp.project, "chore: settle the main leg's tree");
      mainHead = git(mp.project, "rev-parse", "HEAD");
      git(mp.project, "switch", "-q", "-c", "select-fuzzer");
      expect(readText(at(".repo-platform.yml"))).not.toContain('"fuzzer"');
      editText(at(".repo-platform.yml"), (text) => text.replace(/\]$/m, ', "fuzzer"]'));
      expect(readText(at(".repo-platform.yml"))).toContain('"fuzzer"');
      // copier's merge keeps the note (the control below), so without the
      // managed delivery module-render would still read the rendered branch as stale.
      appendText(at(".github/workflows/ci.yml"), `${LOCAL_NOTES.ci}\n`);
      commitAll(mp.project, "chore: select the fuzzer module");
      branchBase = git(mp.project, "rev-parse", "HEAD");
    },
  );

  legTest("module-render reads the branch as STALE before its render lands (the control)", () => {
    // A tree whose selection changed without its render must read STALE
    // naming the two managed files a module adds to, with the remedy line.
    expect(renderCheck()).not.toBe(0);
    for (const line of STALE_LINES) expect(renderOut).toContain(line);
    // Starters are seeded once, never compared.
    expect(renderOut).not.toContain("::error file=.github/workflows/nightly-fuzz.yml");
    expect(lexists(join(mp.work, "module-render"))).toBe(false);
  });

  legTest("the sync legs render the branch's selection with the managed delivery", () => {
    branchWork = mp.fx.mkdir("branch-work");
    const base = { ...mainEnv(mp), RUNNER_TEMP: branchWork, OLD_SHA: mp.fx.new.sha };
    syncScript("run_migrations", base);
    const modules = selectModules(at(".repo-platform.yml"), join(mp.work, "copier-new.yml"));
    expect(modules).toContain("fuzzer");
    const env = { ...base, MODULES: modules };
    syncScript("apply_update", env);
    const srcPath = recordedSrcPath(answersOf(mp.project));
    // Identical builds on both sides: the snapshots are both the new copier.yml.
    for (const name of ["copier-new.yml", "copier-old.yml"]) {
      writeFileSync(join(branchWork, name), readText(join(mp.work, "copier-new.yml")));
    }
    const withRenders = { ...env, SRC_PATH: srcPath };
    syncScript("clean_renders", withRenders);
    syncScript("preserve_local_content", env, preserveLocalContentArgs(mp.project, branchWork));
    syncScript("resolve_copier_conflicts", env, resolveConflictsArgs(mp.project, branchWork, true));
    // The managed delivery's CONTROL: copier's merge kept the local note.
    expect(readText(at(".github/workflows/ci.yml"))).toContain(LOCAL_NOTES.ci);
    syncScript("reset_managed", withRenders);
    expect(readText(at(".github/workflows/ci.yml"))).toBe(
      readText(join(branchWork, "render-new/.github/workflows/ci.yml")),
    );
    expect(readText(join(branchWork, "managed-replaced.md"))).toContain(
      "- `.github/workflows/ci.yml`",
    );
    syncScript("retired_cleanup", withRenders);
    syncScript("preserve_repo_owned", env);
    stampManifest(mp.project);
    validateGenerated(mp.project);
  });

  legTest(
    "the render landed on the branch, reads FRESH, and left the default branch untouched",
    () => {
      expect(readText(at(".github/workflows/ci.yml"))).not.toContain(LOCAL_NOTES.ci);
      // ci.yml carries no selection; the answers file and the registration do.
      expect(workflowJob(at(".github/workflows/ci.yml"), "ci")?.with).toBeUndefined();
      expect(answersOf(mp.project).modules).toContain("fuzzer");
      expect(existsSync(at(".github/workflows/nightly-fuzz.yml"))).toBe(true);
      expect(manifestEntry(mp.project, ".github/workflows/nightly-fuzz.yml")?.class).toBe(
        "starter",
      );
      expect(renderCheck()).toBe(0);
      expect(renderOut).toContain("managed files match");
      // The commit the sync's push step would make (commit_push.ts's own push
      // is GitHub-bound; its unit test pins the wiring).
      git(mp.project, "add", "--all");
      git(
        mp.project,
        "-c",
        "user.name=repo-platform-sync",
        "-c",
        "user.email=repo-platform-sync@users.noreply.github.com",
        "commit",
        "-q",
        "-m",
        "chore: render the fuzzer module",
      );
      expect(git(mp.project, "rev-list", "--count", `${branchBase}..HEAD`)).toBe("1");
      expect(git(mp.project, "rev-parse", "main")).toBe(mainHead);
      expect(
        tryRun([
          "git",
          "-C",
          mp.project,
          "diff",
          "--quiet",
          "main",
          "--",
          ".github/workflows/nightly-fuzz.yml",
        ]).exitCode,
      ).not.toBe(0);
      git(mp.project, "switch", "-q", "main");
      expect(lexists(at(".github/workflows/nightly-fuzz.yml"))).toBe(false);
    },
  );
});
