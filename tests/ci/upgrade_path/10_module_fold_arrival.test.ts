// Module fold arrival (a repo onboarded without the three modules): a
// repository rendered before the fold WITHOUT agents, auto-assign, or
// settings-sync has none of their files, and may carry its OWN AGENTS.md.
// The update delivers the files as base content; the m0002 rung finds
// nothing to drop but FOLDS the repository's own copilot-instructions.md
// (a regular file where a managed symlink now lands) into AGENTS.md and
// holds the PR; the repository's own AGENTS.md, folded block included,
// rides below the fresh managed region under the recovery appendix (HEAD's
// manifest never declared the path, so its copy cannot be split by
// markers), flagged for manual review; .repo-platform.yml is untouched;
// and the answers file gains the two settings questions every repository
// is asked now.

import { expect } from "bun:test";
import { existsSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { countOf, linesOf } from "./edits";
import {
  answersAtHead,
  answersOf,
  COPIER_CONFLICT_MARKER,
  commitAll,
  commitNameStatus,
  copierCopy,
  describeLeg,
  type Fixture,
  filesContaining,
  git,
  legTest,
  lexists,
  MARKERS,
  manifestEntry,
  preserveLocalContentArgs,
  readText,
  readYaml,
  recordedSrcPath,
  resolveConflictsArgs,
  type ScriptEnv,
  selectModules,
  snapshotCopierYml,
  stampManifest,
  syncScript,
  upgradePathHarness,
  validateGenerated,
  writeText,
} from "./fixture";

const harness = upgradePathHarness();

const DESCRIPTION = "Fold-arrival project";
const HOMEPAGE = "https://arrival.example";
const TOPICS = "alpha,beta";
const REGISTRATION = ".repo-platform.yml";
const COPILOT_INSTRUCTIONS = ".github/copilot-instructions.md";

/** Every path the old build gated on one of the three folded modules. */
const FOLDED_PATHS = [
  "AGENTS.md",
  "CLAUDE.md",
  ".github/agents.md",
  COPILOT_INSTRUCTIONS,
  ".github/instructions/review.instructions.md",
  ".github/workflows/auto-assign.yml",
  ".github/workflows/settings-sync.yml",
  ".github/workflows/copilot-setup-steps.yml",
  ".github/settings.yml",
];

/** The folded files that arrive as regular files: the managed ones and the two starters. */
const ARRIVING_FILES = [
  ".github/instructions/review.instructions.md",
  ".github/workflows/auto-assign.yml",
  ".github/workflows/copilot-setup-steps.yml",
  ".github/settings.yml",
];

const AGENT_FILE_LINKS: [link: string, target: string][] = [
  ["CLAUDE.md", "AGENTS.md"],
  [".github/agents.md", "../AGENTS.md"],
  [COPILOT_INSTRUCTIONS, "../AGENTS.md"],
];

const OWN_AGENTS = "# House rules\n\narrival-local agents note\n";
const OWN_COPILOT = "# Our own Copilot rules\n\narrival-local copilot line\n";
/** The rung's whole output on AGENTS.md: the repository's own file, then
 * the folded block for the alias, byte for byte. The block's text is the
 * rung's; this harness restates it rather than importing it. */
const AGENTS_AFTER_FOLD = [
  OWN_AGENTS,
  "\n## Folded from .github/copilot-instructions.md\n\n",
  "This repository carried its own `.github/copilot-instructions.md` before the agent files became managed symlinks to `AGENTS.md`; ",
  "its content follows verbatim. Reconcile it into the sections above.\n\n",
  OWN_COPILOT,
].join("");

describeLeg("10 module fold arrival", () => {
  let fx: Fixture;
  let project: string;
  let work: string;
  let registrationBefore: string;
  let env: ScriptEnv;

  legTest("the pre-fold fixture rendered none of the folded files", () => {
    fx = harness.fixture();
    project = fx.path("upgrade-arrival");
    work = fx.mkdir("upgrade-arrival-work");
    copierCopy(project, fx.old.tag, {
      projectName: "Fold Arrival",
      description: DESCRIPTION,
      modules: ["uv"],
      private: false,
    });
    // The old build gated the folded files on selection: none rendered,
    // not even as a symlink.
    for (const path of FOLDED_PATHS) expect(lexists(join(project, path))).toBe(false);
    expect(manifestEntry(project, "AGENTS.md")).toBeUndefined();
    const answers = answersOf(project);
    expect(answers).not.toHaveProperty("homepage");
    expect(answers).not.toHaveProperty("topics");
    writeText(join(project, "AGENTS.md"), OWN_AGENTS);
    // The repository's own Copilot instructions at a path the fold makes a
    // managed symlink: without the rung's fold, copier replaces the file
    // and its content is gone with no report.
    writeText(join(project, COPILOT_INSTRUCTIONS), OWN_COPILOT);
    git(project, "init", "-q", "-b", "main");
    commitAll(project, "chore: init with the repository's own AGENTS.md");
    registrationBefore = readText(join(project, REGISTRATION));
  });

  legTest("the fold rung folds the repository's own Copilot rules into AGENTS.md", () => {
    snapshotCopierYml(work, fx.old.tag, fx.new.tag);
    const headBefore = git(project, "rev-parse", "HEAD");
    const out = syncScript("run_migrations", {
      TARGET_DIR: project,
      TARGET_REF: fx.new.tag,
      RUNNER_TEMP: work,
      OLD_SHA: fx.old.sha,
    });
    // Nothing to drop from the declaration, but the alias fold commits
    // and holds the PR; with m0001's rename that is two commits.
    expect(out).toContain("migration m0002_fold_base_modules -> in-place+aliases (committed)");
    expect(git(project, "rev-list", "--count", `${headBefore}..HEAD`)).toBe("2");
    expect(readText(join(work, "migrations-review.md"))).toContain("AGENT FILES FOLDED");
    expect(commitNameStatus(project)).toEqual([`D\t${COPILOT_INSTRUCTIONS}`, "M\tAGENTS.md"]);
    expect(readText(join(project, "AGENTS.md"))).toBe(AGENTS_AFTER_FOLD);
    expect(readText(join(project, REGISTRATION))).toBe(registrationBefore);
  });

  legTest("the update runs the workflow's scripts with the live settings values", () => {
    // The repository never recorded homepage or topics (it never selected
    // settings-sync), so the sync seeds both from the LIVE repository.
    env = {
      TARGET_DIR: project,
      TARGET_REF: fx.new.tag,
      RUNNER_TEMP: work,
      MODULES: selectModules(join(project, REGISTRATION), join(work, "copier-new.yml")),
      PRIVATE: "false",
      DESCRIPTION,
      HOMEPAGE,
      TOPICS,
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
    syncScript("preserve_repo_owned", env);
    stampManifest(project);
    validateGenerated(project);
  });

  legTest("the folded files arrive as base content, the retired workflow does not", () => {
    expect(existsSync(join(project, "AGENTS.md"))).toBe(true);
    // Byte-identical to the clean render at the new ref: nothing merged
    // into them, the repository had none of them.
    for (const path of ARRIVING_FILES) {
      expect(existsSync(join(project, path))).toBe(true);
      expect(readText(join(project, path))).toBe(readText(join(work, "render-new", path)));
    }
    expect(lexists(join(project, ".github/workflows/settings-sync.yml"))).toBe(false);
    for (const [link, target] of AGENT_FILE_LINKS) {
      expect(readlinkSync(join(project, link))).toBe(target);
    }
  });

  legTest(
    "the repository's own AGENTS.md rides below the managed region as a reviewed appendix",
    () => {
      // The previous copy (house rules plus the folded Copilot rules) carried
      // no marker text, so the appendix is the copy verbatim: the file ENDS
      // with its exact bytes.
      const agents = readText(join(project, "AGENTS.md"));
      expect(agents.endsWith(AGENTS_AFTER_FOLD)).toBe(true);
      expect(agents).toContain("## Folded from .github/copilot-instructions.md");
      expect(agents).toContain("repo-platform:recovery-appendix");
      expect(countOf(agents, MARKERS.html.begin)).toBe(1);
      expect(countOf(agents, MARKERS.html.end)).toBe(1);
      expect(agents.indexOf(MARKERS.html.end)).toBeLessThan(
        agents.indexOf("arrival-local agents note"),
      );
      const review = linesOf(readText(join(work, "carry-review.txt")));
      expect(review.some((line) => line.startsWith("AGENTS.md:"))).toBe(true);
      expect(readText(join(work, "local-carryover.md"))).toContain("recovery-appendix");
      expect(filesContaining(project, COPIER_CONFLICT_MARKER)).toEqual([]);
    },
  );

  legTest("the registration is untouched and the answers record the live settings", () => {
    expect(readText(join(project, REGISTRATION))).toBe(registrationBefore);
    const answers = answersOf(project);
    expect(answers.homepage).toBe(HOMEPAGE);
    expect(answers.topics).toBe(TOPICS);
    // The starter declares the live values (the render-new byte comparison
    // above already holds, so the clean render was seeded identically).
    const settings = readYaml(join(project, ".github/settings.yml")) as {
      repository: { homepage: unknown; topics: unknown };
    };
    expect(settings.repository.homepage).toBe(HOMEPAGE);
    expect(settings.repository.topics).toBe(TOPICS);
  });
});
