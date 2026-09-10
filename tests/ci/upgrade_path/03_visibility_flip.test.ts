// Visibility flip (public -> private): a flip between syncs is carried by
// the update itself. It must drop the conditional-filename CONTRIBUTING.md
// render, leave the repo-owned settings.yml starter alone (the managed
// baseline follows live visibility centrally), and strip the codeql
// machinery from ci.yml. Runs on a fresh public fixture (selected on the
// pre-fold build with settings-sync, the fleet's real shape; the fold rung
// drops the name) through the same workflow scripts as the main update -
// only the visibility changes. The fixture also owns a workflow at the path
// the NEW post-green starter lands on: copier keeps it without a conflict,
// so the sync must hold the PR and name the file, its template caller, and
// the template's starter.

import { expect } from "bun:test";
import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  answersAtHead,
  commitAll,
  describeLeg,
  expectNoCopierLeftovers,
  type Fixture,
  isEmptyFile,
  legTest,
  lexists,
  manifestEntry,
  readText,
  readYaml,
  recordedSrcPath,
  removedPaths,
  renderedFleetLicense,
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
  workflowJob,
  writeText,
} from "./fixture";

const harness = upgradePathHarness();

const DESCRIPTION = "Visibility-flip project";
const OWN_POST_GREEN =
  "name: Own Hook\non: push\njobs:\n  own:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo own\n";

interface SettingsFile {
  repository: { private: boolean; homepage: string; topics: string };
}

describeLeg("03 visibility flip", () => {
  let fx: Fixture;
  let project: string;
  let work: string;
  let ownPostGreen: string;
  let env: ScriptEnv;

  legTest("the public fixture carries the machinery whose removal is under test", () => {
    fx = harness.fixture();
    project = fx.path("upgrade-vis");
    work = fx.mkdir("upgrade-vis-work");
    renderProject(
      project,
      fx.old.tag,
      {
        projectName: "Visibility Flip",
        description: DESCRIPTION,
        modules: ["bun", "settings-sync"],
        private: false,
      },
      "chore: init",
    );

    expect(existsSync(join(project, "SECURITY.md"))).toBe(true);
    // The old fixture is synthetic (built from the current tree), so the
    // newer public-only artifacts are always present.
    expect(existsSync(join(project, "CONTRIBUTING.md"))).toBe(true);
    expect(existsSync(join(project, "CODE_OF_CONDUCT.md"))).toBe(true);
    // The identity starter (repo-owned; the managed settings baseline is
    // computed centrally, so no rulesets or labels render here).
    const settings = readYaml(join(project, ".github/settings.yml")) as SettingsFile;
    expect(settings.repository.private).toBe(false);

    const postGreen = join(project, ".github/workflows/post-green.yml");
    expect(lexists(postGreen)).toBe(false);
    writeText(postGreen, OWN_POST_GREEN);
    ownPostGreen = join(work, "own-post-green.yml");
    copyFileSync(postGreen, ownPostGreen);
    commitAll(project, "chore: own post-green hook");
  });

  legTest("the update re-renders with PRIVATE=true against recorded answers saying false", () => {
    snapshotCopierYml(work, fx.old.tag, fx.new.tag);
    const base = { TARGET_DIR: project, TARGET_REF: fx.new.tag, RUNNER_TEMP: work };
    syncScript("run_migrations", { ...base, OLD_SHA: fx.old.sha });
    env = {
      ...base,
      MODULES: selectModules(join(project, ".repo-platform.yml"), join(work, "copier-new.yml")),
      PRIVATE: "true",
      DESCRIPTION,
      RECOVER: "",
    };
    syncScript("apply_update", env);
    syncScript("resolve_copier_conflicts", env, resolveConflictsArgs(project, work, false));

    // Current copier already deletes the de-rendered CONTRIBUTING.md during
    // the update; resurrect it so retired_cleanup's data-driven old/new
    // render diff (old render private=false from the recorded answers, new
    // render private=true from the live data) must really flag and delete it.
    writeText(join(project, "CONTRIBUTING.md"), "# Contributing\n");
    syncScript("retired_cleanup", {
      ...env,
      SRC_PATH: recordedSrcPath(answersAtHead(project)),
      OLD_SHA: fx.old.sha,
    });
    expect(retiredPaths(work)).toContain("CONTRIBUTING.md");
    expect(removedPaths(work)).toContain("CONTRIBUTING.md");

    // The new-starter hold: the kept repo-owned post-green.yml is
    // byte-intact (skip_if_exists), and the hold names it, its caller
    // ci.yml, and the template starter's sha input for the reviewer.
    expect(readText(join(project, ".github/workflows/post-green.yml"))).toBe(
      readText(ownPostGreen),
    );
    const newStarters = join(work, "new-starters-review.md");
    expect(existsSync(newStarters)).toBe(true);
    expect(isEmptyFile(newStarters)).toBe(false);
    const hold = readText(newStarters);
    expect(hold).toContain("`.github/workflows/post-green.yml`");
    expect(hold).toContain("named by `.github/workflows/ci.yml`");
    expect(hold).toContain("        sha:");

    syncScript("preserve_repo_owned", env);
    stampManifest(project);
    // Deleting a split-classed file takes its repository-owned half with
    // it, so the removal must raise the removed-splits hold that keeps the
    // PR manual: CONTRIBUTING.md (class `split` at HEAD). The rung's
    // SECURITY.md rename must not read as a deletion.
    const removedSplits = join(work, "removed-splits.md");
    expect(existsSync(removedSplits)).toBe(true);
    expect(isEmptyFile(removedSplits)).toBe(false);
    const splits = readText(removedSplits);
    expect(splits).not.toContain("`SECURITY.md`");
    expect(splits).toContain("`CONTRIBUTING.md`");

    validateGenerated(project);
  });

  legTest(
    "the flipped project retires the public-only files and keeps the repo-owned starter",
    () => {
      // SECURITY.md is visibility-independent since the ungating: it survives
      // the flip, at its new home.
      expect(existsSync(join(project, ".github/SECURITY.md"))).toBe(true);
      expect(lexists(join(project, "SECURITY.md"))).toBe(false);

      const ciYml = join(project, ".github/workflows/ci.yml");
      const ciText = readText(ciYml);
      // The static release leg is present in every render and gated on the
      // plan's modules output, so a selection without release-please skips it.
      expect(String(workflowJob(ciYml, "release")?.if)).toContain('"release-please"');

      // The public-only base files and gates retire on the flip, the
      // manifest's visibility-gated entries with them.
      expect(lexists(join(project, "CONTRIBUTING.md"))).toBe(false);
      expect(lexists(join(project, "CODE_OF_CONDUCT.md"))).toBe(false);
      expect(lexists(join(project, ".github/CODE_OF_CONDUCT.md"))).toBe(false);
      expect(manifestEntry(project, "CONTRIBUTING.md")).toBeUndefined();

      // The license is visibility-independent and (without custom-license)
      // template-managed: the fleet LICENSE.md stays in place.
      const fleetLicense = renderedFleetLicense();
      expect(fleetLicense).not.toBe("");
      expect(readText(join(project, "LICENSE.md")).startsWith(fleetLicense)).toBe(true);

      // ci.yml carries no visibility: the flip lives in the answers file
      // and fleet-ci reads it at run time.
      expect(workflowJob(ciYml, "ci")?.with).toBeUndefined();

      // settings.yml is a repo-owned starter: the flip must NOT rewrite it
      // (drift surfaces via the settings-drift report instead), and the other
      // always-declared identity keys survive untouched too.
      const settings = readYaml(join(project, ".github/settings.yml")) as SettingsFile;
      expect(settings.repository.private).toBe(false);
      expect(settings.repository.homepage).toBe("");
      expect(settings.repository.topics).toBe("");

      expect(ciText).not.toContain("javascript-typescript");

      expectNoCopierLeftovers(project);
    },
  );
});
