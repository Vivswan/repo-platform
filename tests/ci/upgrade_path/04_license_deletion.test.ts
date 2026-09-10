// Committed LICENSE deletion (fleet license mandatory): a repo still on the
// fleet license that committed a LICENSE deletion. copier honors the
// deletion when it re-applies the local diff, cleanup never lists the path
// (LICENSE.md is in both renders), and HEAD has no copy to restore - the
// preserve step must re-seed the fleet license from the target build ref.

import { expect } from "bun:test";
import { join } from "node:path";
import {
  describeLeg,
  git,
  legTest,
  readText,
  renderedFleetLicense,
  renderProject,
  resolveConflictsArgs,
  syncScript,
  upgradePathHarness,
} from "./fixture";

const harness = upgradePathHarness();

describeLeg("04 license deletion", () => {
  legTest("a committed LICENSE deletion re-converges to the mandatory fleet license", () => {
    const fx = harness.fixture();
    // Rendered from the NEW build: the re-seed hole only exists when the
    // base already carried LICENSE.md and the local diff deletes it (a
    // fixture on the old build gets LICENSE.md as a fresh render).
    const project = fx.path("upgrade-del");
    renderProject(project, fx.new.tag, {
      projectName: "License Deletion",
      description: "License-deletion project",
      modules: [],
      private: false,
    });
    git(project, "rm", "-q", "LICENSE.md");
    git(
      project,
      "-c",
      "user.name=ci",
      "-c",
      "user.email=ci@localhost",
      "commit",
      "-q",
      "-m",
      "chore: delete LICENSE.md",
    );

    const env = {
      MODULES: "[]",
      PRIVATE: "false" as const,
      DESCRIPTION: "License-deletion project",
      TARGET_DIR: project,
      TARGET_REF: fx.new.tag,
      RECOVER: "",
      RUNNER_TEMP: fx.runDir,
    };
    syncScript("apply_update", env);
    syncScript("resolve_copier_conflicts", env, resolveConflictsArgs(project, fx.runDir, false));
    syncScript("preserve_repo_owned", env);

    expect(readText(join(project, "LICENSE.md"))).toBe(renderedFleetLicense());
  });
});
