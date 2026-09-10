// Pages answer retirement (pages_production / pages_staging): a repo
// rendered in the production/staging era carries that pages.yml shape and
// records the two retired answers. The update must re-render the managed
// pages.yml to the mounts interface and drop the retired answers from the
// answers file while the surviving pages answers ride through. The
// delivery-channel pin flip rides the same managed re-render: a repo that
// called the reusable workflows @main (the ungated tip) comes out calling
// them @build, for pages.yml and auto-assign.yml alike.

import { expect } from "bun:test";
import { join } from "node:path";
import {
  ANSWERS_FILE,
  answersOf,
  appendText,
  commitAll,
  copierCopy,
  describeLeg,
  type Fixture,
  git,
  legTest,
  readText,
  readYaml,
  resolveConflictsArgs,
  type ScriptEnv,
  selectModules,
  snapshotCopierYml,
  syncScript,
  upgradePathHarness,
  workflowJob,
  workflowJobWith,
} from "./fixture";

const harness = upgradePathHarness();

const DESCRIPTION = "Pages-retirement project";

const PAGES_YML = ".github/workflows/pages.yml";

describeLeg("09 pages answer retirement", () => {
  let fx: Fixture;
  let project: string;
  let work: string;
  let env: ScriptEnv;

  legTest("the old fixture records the production/staging era", () => {
    fx = harness.fixture();
    project = fx.path("upgrade-pages");
    work = fx.mkdir("upgrade-pages-work");
    copierCopy(project, fx.old.tag, {
      projectName: "Pages Retirement",
      description: DESCRIPTION,
      modules: ["pages", "auto-assign"],
      private: false,
      extra: { pages_setup: "none", pages_build_command: "./build.sh" },
    });
    expect(workflowJobWith(join(project, PAGES_YML), "deploy").production).toBe("main");
    // The era's recorded answers: current copier no longer asks the
    // questions, so the fleet state is modeled by recording the values.
    appendText(join(project, ANSWERS_FILE), "pages_production: main\npages_staging: false\n");
    git(project, "init", "-q", "-b", "main");
    commitAll(project, "chore: init in the production/staging era");
  });

  legTest("the update re-renders pages.yml and drops the retired answers", () => {
    snapshotCopierYml(work, fx.old.tag, fx.new.tag);
    const base = { TARGET_DIR: project, TARGET_REF: fx.new.tag, RUNNER_TEMP: work };
    syncScript("run_migrations", { ...base, OLD_SHA: fx.old.sha });
    const declared = readYaml(join(project, ".repo-platform.yml")) as { modules: string[] };
    expect(declared.modules).not.toContain("auto-assign");
    env = {
      ...base,
      MODULES: selectModules(join(project, ".repo-platform.yml"), join(work, "copier-new.yml")),
      PRIVATE: "false",
      DESCRIPTION,
      RECOVER: "",
    };
    syncScript("apply_update", env);
    syncScript("resolve_copier_conflicts", env, resolveConflictsArgs(project, work, false));

    const pagesYml = join(project, PAGES_YML);
    const pagesText = readText(pagesYml);
    const withBlock = workflowJobWith(pagesYml, "deploy");
    expect(pagesText).toContain("mounts:");
    expect(typeof withBlock.mounts).toBe("string");
    const mounts = JSON.parse(withBlock.mounts as string) as { versioned: boolean }[];
    expect(mounts.some((mount) => mount.versioned === true)).toBe(true);
    expect(withBlock.production).toBeUndefined();
    expect(withBlock.staging).toBeUndefined();
    const triggers = (readYaml(pagesYml) as { on: Record<string, unknown> }).on;
    expect(triggers.release).toBeUndefined();

    const answers = answersOf(project);
    expect(answers.pages_production).toBeUndefined();
    expect(answers.pages_staging).toBeUndefined();
    expect(answers.pages_build_command).toBe("./build.sh");

    const deploy = workflowJob(pagesYml, "deploy");
    expect(deploy?.uses).toBe("Vivswan/repo-platform/.github/workflows/reusable-pages.yml@build");
    expect(pagesText).not.toContain("repo-platform/.github/workflows/reusable-pages.yml@main");
    expect(readText(join(project, ".github/workflows/auto-assign.yml"))).toContain(
      "repo-platform/.github/workflows/reusable-auto-assign.yml@build",
    );
  });
});
