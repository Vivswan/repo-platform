// Unselected-path preservation (conditional landing via _exclude): the
// composed tree carries plain filenames, and conditional landing happens
// through copier.yml's generated _exclude patterns, which must reproduce
// the retired filename-gate semantics EXACTLY. A path whose gates do not
// hold is never rendered, so a repo's OWN file at such a path (its
// custom-license LICENSE.md, a home-grown nightly.yml without the nightly
// module) survives every update byte-identical, and the retired-file
// cleanup never lists it. Runs the new build into the split build, a real
// content-changed build, through the workflow's own scripts.

import { expect } from "bun:test";
import { join } from "node:path";
import {
  answersAtHead,
  type Build,
  commitAll,
  copierCopy,
  describeLeg,
  type Fixture,
  git,
  legTest,
  lexists,
  readText,
  recordedSrcPath,
  resolveConflictsArgs,
  retiredPaths,
  type ScriptEnv,
  snapshotCopierYml,
  stampManifest,
  syncScript,
  upgradePathHarness,
  validateGenerated,
  writeText,
} from "./fixture";
import { commitSplitBuild } from "./split_build";

const harness = upgradePathHarness();

const DESCRIPTION = "Unselected-path project";
const OWN_LICENSE = "Repo-owned custom license (unselected-path leg)\n";
const OWN_NIGHTLY = "name: repo-own nightly\non: workflow_dispatch\n";
const NIGHTLY_YML = ".github/workflows/nightly.yml";

describeLeg("06 unselected paths", () => {
  let fx: Fixture;
  let splitBuild: Build;
  let project: string;
  let work: string;
  let env: ScriptEnv;

  legTest("the unselected paths never render, so the repo owns the files there", () => {
    fx = harness.fixture();
    splitBuild = commitSplitBuild(fx);
    project = fx.path("upgrade-unselected");
    work = fx.mkdir("upgrade-unselected-work");
    copierCopy(project, fx.new.tag, {
      projectName: "Unselected Paths",
      description: DESCRIPTION,
      modules: ["custom-license"],
      private: false,
    });
    expect(lexists(join(project, "LICENSE.md"))).toBe(false);
    expect(lexists(join(project, NIGHTLY_YML))).toBe(false);
    writeText(join(project, "LICENSE.md"), OWN_LICENSE);
    writeText(join(project, NIGHTLY_YML), OWN_NIGHTLY);
    git(project, "init", "-q", "-b", "main");
    commitAll(project, "chore: init with repo-owned files");
  });

  legTest("the update to a content-changed build runs the workflow's scripts", () => {
    env = {
      MODULES: '["custom-license"]',
      PRIVATE: "false",
      DESCRIPTION,
      TARGET_DIR: project,
      TARGET_REF: splitBuild.tag,
      RUNNER_TEMP: work,
      RECOVER: "",
    };
    syncScript("apply_update", env);
    syncScript("resolve_copier_conflicts", env, resolveConflictsArgs(project, work, false));
    snapshotCopierYml(work, fx.new.tag, splitBuild.tag);
    syncScript("retired_cleanup", {
      ...env,
      SRC_PATH: recordedSrcPath(answersAtHead(project)),
      OLD_SHA: fx.new.sha,
    });
    syncScript("preserve_repo_owned", env);
    stampManifest(project);
    validateGenerated(project);
  });

  legTest("the repo-owned files at unselected paths survive byte-identical and unlisted", () => {
    expect(readText(join(project, "LICENSE.md"))).toBe(OWN_LICENSE);
    expect(readText(join(project, NIGHTLY_YML))).toBe(OWN_NIGHTLY);
    const retired = retiredPaths(work);
    expect(retired.filter((path) => path.includes("LICENSE.md"))).toEqual([]);
    expect(retired.filter((path) => path.includes("nightly.yml"))).toEqual([]);
  });
});
