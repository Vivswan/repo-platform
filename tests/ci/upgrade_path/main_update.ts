// The main upgrade path as stages: a project generated from the synthetic
// OLD build with the local modifications a real repo carries into a sync,
// updated to the fresh build the way reusable-template-sync does (the
// migration ladder, module selection, live -d data, the split-file
// rebuild, conflict resolution, the managed delivery, retired-file
// cleanup, the preserve step, the final stamp). Leg 01 asserts between
// the stages; the recovery and branch legs start from the finished update.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  answersAtHead,
  appendText,
  commitAll,
  copierCopy,
  type Fixture,
  git,
  preserveLocalContentArgs,
  readText,
  recordedCommit,
  recordedSrcPath,
  resolveConflictsArgs,
  selectModules,
  snapshotCopierYml,
  stampManifest,
  syncScript,
  writeText,
} from "./fixture";

export const MAIN_PROJECT_ANSWERS = {
  projectName: "Upgrade Test",
  description: "Upgrade-path project",
  modules: [
    "agents",
    "uv",
    "release-please",
    "issue-templates",
    "pr-title",
    "auto-assign",
    "settings-sync",
  ],
  private: false,
};

/** The three module names the fold rung must drop from the declaration. */
export const FOLDED_MODULES = ["agents", "auto-assign", "settings-sync"];

/** Files the fold moved into base: their pre-sync bytes are the oracle for
 * landing UNCHANGED. */
export const FOLDED_FILES = [
  ".github/workflows/auto-assign.yml",
  ".github/workflows/copilot-setup-steps.yml",
  ".github/instructions/review.instructions.md",
  ".github/settings.yml",
];

/** Files the template retired between the builds, resurrected after
 * copier's own delete so retired_cleanup.ts provably removes them. */
export const RETIRED_FILES: Record<string, string> = {
  ".github/retired-sentinel.txt": "retired sentinel\n",
  ".github/workflows/rerun-copilot-gate.yml":
    "name: Rerun Copilot Gate\non: [pull_request_review]\n",
  ".github/workflows/settings-sync.yml": "name: Settings Sync\non: [push]\n",
};

export const LOCAL_NOTES = {
  settings: "# local settings note",
  securityTail: "Scope note: upgrade-local security tail",
  checks: "# local checks note",
  ci: "# local ci note",
  issueForm: "# local issue form note",
  sentinel: "# local sentinel note",
  license: "Repo-owned custom license",
  keepMe: "repo-owned sentinel",
} as const;

/** The seeded-answer CONTROL: the fixture RECORDED homepage and topics (the
 * pre-fold render asked them with settings-sync), so these live values must
 * not win over the recorded ones. */
export const LIVE_SETTINGS_CONTROL = {
  HOMEPAGE: "https://must-not-win.example",
  TOPICS: "must,not,win",
};

export interface MainProject {
  readonly fx: Fixture;
  readonly project: string;
  /** The leg's RUNNER_TEMP: the copier.yml snapshots, the clean renders, every report. */
  readonly work: string;
  /** `<work>/folded-before/<path>`: the folded files' pre-sync bytes. */
  foldedBefore(path: string): string;
}

/** Stage 1: the project rendered from the old build and committed. */
export function renderMainProject(fx: Fixture): MainProject {
  const project = fx.path("upgrade");
  const work = fx.mkdir("upgrade-work");
  copierCopy(project, fx.old.tag, MAIN_PROJECT_ANSWERS);
  git(project, "init", "-q", "-b", "main");
  commitAll(project, "chore: init");
  // The copier.yml snapshots the sync's scripts read from RUNNER_TEMP.
  snapshotCopierYml(work, fx.old.tag, fx.new.tag);
  return { fx, project, work, foldedBefore: (path) => join(work, "folded-before", path) };
}

/** Stage 2: the local modifications a real repo carries into a sync, each
 * asserted after the update. Repo-owned and generated-once files gain edits
 * that must SURVIVE; LICENSE.md swaps to a repo-owned license with the
 * custom-license module selected; retired files gain edits so their
 * deletion provably comes from the cleanup; src/keep_me.txt is
 * never-rendered content; .repo-platform.yml still names the pre-fold
 * modules the fold rung must drop; SECURITY.md's tail feeds the move rung. */
export function plantMainModifications(mp: MainProject): void {
  const at = (rel: string) => join(mp.project, rel);
  appendText(at(".github/settings.yml"), `${LOCAL_NOTES.settings}\n`);
  appendText(at("SECURITY.md"), `\n${LOCAL_NOTES.securityTail}\n`);
  appendText(at(".github/workflows/checks.yml"), `${LOCAL_NOTES.checks}\n`);
  // A MANAGED file with a local trailing comment: copier's three-way merge
  // keeps it (the control), the managed delivery must replace the file.
  appendText(at(".github/workflows/ci.yml"), `${LOCAL_NOTES.ci}\n`);
  appendText(at(".github/ISSUE_TEMPLATE/bug_report.yml"), `${LOCAL_NOTES.issueForm}\n`);
  // Adopting custom-license REPLACES the fleet license under the one-license rule.
  writeFileSync(at("LICENSE.md"), `${LOCAL_NOTES.license}\n`);
  appendText(at(".github/retired-sentinel.txt"), `${LOCAL_NOTES.sentinel}\n`);
  writeText(at("src/keep_me.txt"), `${LOCAL_NOTES.keepMe}\n`);
  const registration = readText(at(".repo-platform.yml"));
  const withCustomLicense = registration.replace(/\]$/m, ', "custom-license"]');
  if (withCustomLicense === registration)
    throw new Error("could not add custom-license to .repo-platform.yml");
  writeFileSync(at(".repo-platform.yml"), withCustomLicense);
  for (const file of FOLDED_FILES) {
    mkdirSync(dirname(mp.foldedBefore(file)), { recursive: true });
    writeFileSync(mp.foldedBefore(file), readFileSync(at(file)));
  }
  commitAll(mp.project, "chore: local modifications");
}

/** The env every sync script of the main update runs under. */
export function mainEnv(mp: MainProject, modules?: string): Record<string, string> {
  return {
    TARGET_DIR: mp.project,
    TARGET_REF: mp.fx.new.tag,
    RUNNER_TEMP: mp.work,
    PRIVATE: "false",
    DESCRIPTION: "Upgraded description",
    RECOVER: "",
    OLD_SHA: mp.fx.old.sha,
    ...(modules === undefined ? {} : { MODULES: modules }),
    ...LIVE_SETTINGS_CONTROL,
  };
}

/** Stage 3: THE MIGRATION LADDER, replayed BEFORE the update like the
 * workflow: every rung that appears in build history after the old build
 * acts on the fixture, committed so copier sees a clean tree. */
export function runMainLadder(mp: MainProject): string {
  return syncScript("run_migrations", mainEnv(mp));
}

export interface MainUpdateResult {
  /** Module selection as reusable-template-sync computes it, AFTER the ladder. */
  modules: string;
  srcPath: string;
  /** The `_commit` recorded at HEAD when the update ran: the old build's sha. */
  commitAtHead: string;
  /** The managed ci.yml as copier's merge left it, before the managed delivery. */
  ciYmlBeforeDelivery: string;
}

/** Stage 4: module selection in its slot after the ladder, the update
 * through the same apply_update.ts wrapper the workflow uses, then the
 * workflow's post-update order: clean renders, split-file rebuild,
 * conflict resolution with the rebuilt paths skipped, the managed
 * delivery, the retired-file cleanup (over resurrected files), the
 * preserve step, and the final stamp. */
export function runMainUpdate(mp: MainProject): MainUpdateResult {
  const modules = selectModules(
    join(mp.project, ".repo-platform.yml"),
    join(mp.work, "copier-new.yml"),
  );
  const env = mainEnv(mp, modules);
  syncScript("apply_update", env);
  const answersBefore = answersAtHead(mp.project);
  const srcPath = recordedSrcPath(answersBefore);
  const commitAtHead = recordedCommit(answersBefore);
  const withRenders = { ...env, SRC_PATH: srcPath };
  syncScript("clean_renders", withRenders);
  syncScript("preserve_local_content", env, preserveLocalContentArgs(mp.project, mp.work));
  syncScript("resolve_copier_conflicts", env, resolveConflictsArgs(mp.project, mp.work, true));
  const ciYmlBeforeDelivery = readText(join(mp.project, ".github/workflows/ci.yml"));
  syncScript("reset_managed", withRenders);
  // Current copier already deletes the de-rendered files during update, so
  // the cleanup would run over an empty set and pass even if broken.
  for (const [rel, content] of Object.entries(RETIRED_FILES))
    writeFileSync(join(mp.project, rel), content);
  syncScript("retired_cleanup", withRenders);
  syncScript("preserve_repo_owned", env);
  stampManifest(mp.project);
  return { modules, srcPath, commitAtHead, ciYmlBeforeDelivery };
}

/** The whole main update, for the legs that start from its result. */
export function mainUpdate(fx: Fixture): { mp: MainProject; update: MainUpdateResult } {
  const mp = renderMainProject(fx);
  plantMainModifications(mp);
  runMainLadder(mp);
  return { mp, update: runMainUpdate(mp) };
}
