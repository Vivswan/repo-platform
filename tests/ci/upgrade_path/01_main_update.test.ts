// The main upgrade path: a project generated from the synthetic OLD build,
// carrying the local modifications a real repo has, updated to the fresh
// build the way reusable-template-sync does (the migration ladder, module
// selection, live -d data, the split-file rebuild, conflict resolution,
// the managed delivery, retired-file cleanup, the preserve step). Files the
// template dropped are deleted while repo-owned content survives,
// settings.yml included, and the ownership manifest is stamped for the new
// tree.

import { expect } from "bun:test";
import { existsSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { linesOf } from "./edits";
import {
  answersOf,
  commitIdentityLine,
  commitNameStatus,
  describeLeg,
  expectNoCopierLeftovers,
  git,
  isCleanTree,
  isEmptyFile,
  legTest,
  lexists,
  manifestEntry,
  REPO_ROOT,
  readText,
  readYaml,
  recordedCommit,
  removedPaths,
  retiredPaths,
  SYNC_IDENTITY,
  sha256File,
  syncScript,
  trySyncScript,
  upgradePathHarness,
  validateGenerated,
  workflowJob,
  workflowJobWith,
} from "./fixture";
import {
  FOLDED_FILES,
  FOLDED_MODULES,
  LOCAL_NOTES,
  type MainProject,
  type MainUpdateResult,
  mainEnv,
  plantMainModifications,
  RETIRED_FILES,
  renderMainProject,
  runMainLadder,
  runMainUpdate,
} from "./main_update";

const harness = upgradePathHarness();

/** Whether `.repo-platform.yml`'s text names a module (the exact quoted item). */
const declares = (registration: string, module: string) => registration.includes(`"${module}"`);

describeLeg("01 main update", () => {
  let mp: MainProject;
  let at: (rel: string) => string;
  let work: (rel: string) => string;
  let controlHead: string;
  let securityBeforeMove: string;
  let registrationBeforeLadder: string;
  let update: MainUpdateResult;

  legTest(
    "the synthetic old fixture renders the retired machinery and predates the arrivals",
    () => {
      mp = renderMainProject(harness.fixture());
      at = (rel) => join(mp.project, rel);
      work = (rel) => join(mp.work, rel);
      // The fixture must contain the files whose deletion is under test...
      for (const rel of [
        ".github/settings.yml",
        ".github/workflows/settings-sync.yml",
        "AGENTS.md",
        "LICENSE.md",
      ]) {
        expect(existsSync(at(rel))).toBe(true);
      }
      // ...record the three folded modules (the premise of the stale-answer
      // proof: copier must accept them on update)...
      expect(answersOf(mp.project).modules).toEqual(expect.arrayContaining(FOLDED_MODULES));
      for (const rel of Object.keys(RETIRED_FILES)) expect(existsSync(at(rel))).toBe(true);
      // ...and predate the files whose ARRIVAL is under test.
      expect(lexists(at(".github/workflows/pr-title.yml"))).toBe(false);
    },
  );

  legTest(
    "the local modifications land on a fixture that carries the pre-move security policy",
    () => {
      // The move assertions would be vacuous without the root policy.
      expect(existsSync(at("SECURITY.md"))).toBe(true);
      expect(lexists(at(".github/SECURITY.md"))).toBe(false);
      plantMainModifications(mp);
      const registration = readText(at(".repo-platform.yml"));
      for (const module of ["custom-license", ...FOLDED_MODULES])
        expect(declares(registration, module)).toBe(true);
    },
  );

  legTest("the ladder is a no-op when both builds carry every rung (the control)", () => {
    // With the same build on both sides every rung is crossed, so the ladder
    // must touch nothing: same HEAD, clean tree, both reports written and
    // empty. The control bites only while the ladder holds a rung; an empty
    // ladder is a legitimate state, announced rather than failed.
    const rungFiles = linesOf(
      `${git(REPO_ROOT, "ls-tree", "--name-only", mp.fx.new.tag, "migrations/")}\n`,
    );
    console.log(
      rungFiles.length > 0
        ? "migration ladder populated: the no-op control is armed"
        : "migration ladder empty: the no-op control is vacuous by construction",
    );
    controlHead = git(mp.project, "rev-parse", "HEAD");
    const control = syncScript("run_migrations", { ...mainEnv(mp), OLD_SHA: mp.fx.new.sha });
    // The runner's own report is checked too: an idempotent rung that ran
    // anyway leaves HEAD and the tree untouched, so the postconditions alone
    // could not see it.
    expect(control).toContain("no pending migrations");
    expect(control).not.toMatch(/migration m[0-9]{4}_/);
    expect(git(mp.project, "rev-parse", "HEAD")).toBe(controlHead);
    expect(isCleanTree(mp.project)).toBe(true);
    for (const report of ["migrations.md", "migrations-review.md"]) {
      expect(existsSync(work(report))).toBe(true);
      expect(isEmptyFile(work(report))).toBe(true);
    }
    expect(existsSync(at("SECURITY.md"))).toBe(true);
    expect(declares(readText(at(".repo-platform.yml")), "settings-sync")).toBe(true);
    securityBeforeMove = readText(at("SECURITY.md"));
    registrationBeforeLadder = readText(at(".repo-platform.yml"));
  });

  legTest(
    "module selection refuses the pre-fold declaration against the new template (the fold rung's necessity)",
    () => {
      // A name that is not a choice is never silently dropped, so without the
      // fold rung the sync could not proceed.
      const refused = trySyncScript("modules", {}, [
        "--repo-file",
        at(".repo-platform.yml"),
        "--template-copier",
        work("copier-new.yml"),
      ]);
      expect(refused.exitCode).not.toBe(0);
      expect(refused.stdout + refused.stderr).toContain(
        "is not a choice of the selected template version",
      );
    },
  );

  legTest(
    "the two pending rungs run once each, committed in ladder order as the sync identity",
    () => {
      runMainLadder(mp);
      expect(isCleanTree(mp.project)).toBe(true);
      expect(git(mp.project, "rev-list", "--count", `${controlHead}..HEAD`)).toBe("2");
      expect(commitIdentityLine(mp.project, "HEAD~1")).toBe(
        `${SYNC_IDENTITY} chore: run migration m0001_security_policy_to_github`,
      );
      expect(commitNameStatus(mp.project, "HEAD~1")).toEqual([
        "R100\tSECURITY.md\t.github/SECURITY.md",
      ]);
      expect(commitIdentityLine(mp.project)).toBe(
        `${SYNC_IDENTITY} chore: run migration m0002_fold_base_modules`,
      );
      expect(commitNameStatus(mp.project)).toEqual(["M\t.repo-platform.yml"]);
    },
  );

  legTest(
    "the fold rung drops exactly the three names and the move rung carries the policy byte-for-byte",
    () => {
      const registration = readText(at(".repo-platform.yml"));
      for (const module of FOLDED_MODULES) expect(declares(registration, module)).toBe(false);
      for (const module of [
        "uv",
        "release-please",
        "issue-templates",
        "pr-title",
        "custom-license",
      ]) {
        expect(declares(registration, module)).toBe(true);
      }
      expect(registration).toMatch(/^# Generated once by/m);
      // Exactly the three items left the rendered flow list (each with its
      // separating comma wherever copier's choice order put it); every other
      // byte is the pre-ladder copy's.
      let expected = registrationBeforeLadder;
      for (const module of FOLDED_MODULES) {
        expected = expected.replace(`"${module}", `, "").replace(`, "${module}"`, "");
      }
      expect(registration).toBe(expected);
      expect(readText(work("migrations.md"))).toContain("MODULE FOLD");
      // No rung held the PR for review on a routine update.
      expect(isEmptyFile(work("migrations-review.md"))).toBe(true);
      // The pending rung moved the policy (tail included), so the split-file
      // rebuild finds the previous copy at the new path.
      expect(lexists(at("SECURITY.md"))).toBe(false);
      expect(readText(at(".github/SECURITY.md"))).toBe(securityBeforeMove);
      expect(readText(work("migrations.md"))).toContain("SECURITY POLICY MOVE");
    },
  );

  legTest(
    "the update delivers managed files whole, deletes the retired ones, and preserves repo-owned content",
    () => {
      update = runMainUpdate(mp);
      for (const module of FOLDED_MODULES) expect(update.modules).not.toContain(module);
      expect(update.modules).toContain("custom-license");
      // _commit records the build commit the old tag names (the resolver hands
      // the runner a full sha).
      expect(update.commitAtHead).toBe(mp.fx.old.sha);
      // The managed delivery's CONTROL: copier's merge kept the local note in
      // the managed ci.yml, so the byte-equality can only come from the leg.
      expect(update.ciYmlBeforeDelivery).toContain(LOCAL_NOTES.ci);
      expect(readText(at(".github/workflows/ci.yml"))).toBe(
        readText(work("render-new/.github/workflows/ci.yml")),
      );
      const replaced = readText(work("managed-replaced.md"));
      expect(replaced).toContain("- `.github/workflows/ci.yml`");
      // The manifest differs only in its stamp-derived hashes, not in what it declares.
      expect(replaced).not.toContain("repo-platform-manifest.json");
      // The retired-file cleanup: never the repo-owned or generated-once
      // paths; the resurrected retired files flagged AND removed.
      const retired = retiredPaths(mp.work);
      expect(retired).not.toContain(".github/settings.yml");
      expect(retired.filter((path) => path.includes("checks.yml"))).toEqual([]);
      expect(retired).not.toContain("LICENSE.md");
      const removed = removedPaths(mp.work);
      for (const rel of Object.keys(RETIRED_FILES)) {
        expect(retired).toContain(rel);
        expect(removed).toContain(rel);
      }
      validateGenerated(mp.project);
    },
  );

  legTest(
    "the updated project records the new build, carries the arrivals, and keeps every repo-owned edit",
    () => {
      // _commit is the new build commit's full sha (the stamp hook rewrites
      // copier's describe output from vcs_ref_hash).
      expect(recordedCommit(answersOf(mp.project))).toBe(mp.fx.new.sha);
      for (const rel of Object.keys(RETIRED_FILES)) expect(lexists(at(rel))).toBe(false);
      // THE MODULE FOLD's postcondition: the folded files are base content now
      // and land UNCHANGED, the agent-file symlinks survive with their targets,
      // the declaration keeps the rung's rewrite, and the answers file (which
      // copier rewrote from the filtered -d selection, accepting the stale
      // recorded list) carries the filtered list in choice order.
      for (const rel of FOLDED_FILES)
        expect(readText(at(rel))).toBe(readText(mp.foldedBefore(rel)));
      for (const [link, target] of [
        ["CLAUDE.md", "AGENTS.md"],
        [".github/agents.md", "../AGENTS.md"],
        [".github/copilot-instructions.md", "../AGENTS.md"],
      ]) {
        expect(readlinkSync(at(link))).toBe(target);
      }
      const registration = readText(at(".repo-platform.yml"));
      for (const module of FOLDED_MODULES) expect(declares(registration, module)).toBe(false);
      const answers = answersOf(mp.project);
      expect(answers.modules).toEqual([
        "uv",
        "release-please",
        "issue-templates",
        "pr-title",
        "custom-license",
      ]);
      // The seeded-answer control: the recorded homepage and topics win over the live values.
      expect(answers.homepage).toBe("");
      expect(answers.topics).toBe("");
      for (const rel of [".github/settings.yml", ".github/.copier-answers.yml"]) {
        expect(readText(at(rel))).not.toContain("must-not-win");
      }
      // settings.yml is repo-owned (PROTECTED_PATHS + the preserve step): the
      // file AND its local edit survive.
      expect(existsSync(at(".github/settings.yml"))).toBe(true);
      expect(readText(at(".github/settings.yml"))).toContain(LOCAL_NOTES.settings);
      expect(readYaml(at(".repo-platform.yml"))).toHaveProperty("modules");
      expect(readText(at("src/keep_me.txt"))).toBe(`${LOCAL_NOTES.keepMe}\n`);
      expect(readText(at(".github/workflows/checks.yml"))).toContain(LOCAL_NOTES.checks);
      // _skip_if_exists must hold for the generated-once issue form.
      expect(readText(at(".github/ISSUE_TEMPLATE/bug_report.yml"))).toContain(
        LOCAL_NOTES.issueForm,
      );
      // LICENSE.md opted out via custom-license survives the update, the
      // de-render, and the retired-file cleanup.
      expect(readText(at("LICENSE.md"))).toBe(`${LOCAL_NOTES.license}\n`);
      // Public-only community files arrive via the update; CODE_OF_CONDUCT.md
      // lands under .github/ and leaves the root through the re-render plus
      // retired-file cleanup.
      expect(existsSync(at("CONTRIBUTING.md"))).toBe(true);
      expect(existsSync(at(".github/CODE_OF_CONDUCT.md"))).toBe(true);
      expect(lexists(at("CODE_OF_CONDUCT.md"))).toBe(false);
      // SECURITY.md's repository-owned tail rode the rung's move, and the
      // rename must not read as a split-file deletion.
      expect(existsSync(at(".github/SECURITY.md"))).toBe(true);
      expect(lexists(at("SECURITY.md"))).toBe(false);
      expect(readText(at(".github/SECURITY.md"))).toContain(LOCAL_NOTES.securityTail);
      expect(existsSync(work("removed-splits.md"))).toBe(true);
      expect(readText(work("removed-splits.md"))).not.toContain("`SECURITY.md`");
    },
  );

  legTest(
    "the updated ci.yml carries the gate, the post-green hook, and the release leg, and the starters arrive",
    () => {
      const ciYml = at(".github/workflows/ci.yml");
      const ciText = readText(ciYml);
      expect(ciText).toContain("repo-platform/.github/workflows/fleet-ci.yml@build");
      // The gate: ci.yml's own all-green job is the required check, judged
      // through the shared action at the build ref.
      const allGreen = workflowJob(ciYml, "all-green");
      expect(allGreen).toBeDefined();
      expect(allGreen?.needs).toEqual(["checks", "ci"]);
      expect(allGreen?.if).toBe("always()");
      expect(ciText).toContain("repo-platform/actions/all-green@build");
      // The repo-owned post-green hook and the release leg ride downstream of
      // the gate; the release also waits for the hook and passes the judged
      // sha into a release.yml that declares and reads the input. Each needs
      // list is read inside ITS job.
      const postGreen = workflowJob(ciYml, "post-green");
      expect(postGreen).toBeDefined();
      expect(postGreen?.needs).toEqual(["all-green"]);
      // The caller's target arrives with it: the repo-owned starter, callable
      // with the sha input. The old fixture never rendered it, so this is the
      // new-starter CONTROL: a target without the file gets the template's
      // starter and no hold is raised.
      const postGreenYml = at(".github/workflows/post-green.yml");
      expect(existsSync(postGreenYml)).toBe(true);
      expect(isEmptyFile(work("new-starters-review.md"))).toBe(true);
      const starterOn = (readYaml(postGreenYml) as { on: Record<string, unknown> }).on;
      expect(starterOn).toHaveProperty("workflow_call");
      expect(
        (starterOn.workflow_call as { inputs: Record<string, unknown> }).inputs,
      ).toHaveProperty("sha");
      const release = workflowJob(ciYml, "release");
      expect(release).toBeDefined();
      expect(release?.needs).toEqual(["all-green", "post-green"]);
      expect(release?.if).toContain("needs.all-green.result == 'success' &&");
      expect(release?.if).toContain("needs.post-green.result == 'success' &&");
      expect(workflowJobWith(ciYml, "release").sha).toBe("${{ github.sha }}");
      expect(linesOf(readText(at(".github/workflows/release.yml")))).toContain(
        "          JUDGED: ${{ inputs.sha || github.sha }}",
      );
      // The update PRESERVES the repo's configuration, not resets it.
      expect(readText(at(".gitignore"))).toContain("## Python ");
      expect(readText(at(".github/dependabot.yml"))).toContain('package-ecosystem: "uv"');
      expect(workflowJobWith(ciYml, "ci").modules).toContain('"pr-title"');
      // pr-title's own natively-required workflow ARRIVES with the update.
      const prTitleYml = at(".github/workflows/pr-title.yml");
      expect(existsSync(prTitleYml)).toBe(true);
      const prTitleOn = (readYaml(prTitleYml) as { on: { pull_request: { types: string[] } } }).on;
      expect(prTitleOn.pull_request.types).toEqual(["opened", "edited", "reopened", "synchronize"]);
      expect(existsSync(at("AGENTS.md"))).toBe(true);
      expect(answersOf(mp.project).description).toBe("Upgraded description");
      expectNoCopierLeftovers(mp.project);
    },
  );

  legTest("the ownership manifest is stamped for the new tree", () => {
    // Entries follow the new selection (the folded files as base entries,
    // the custom-license opt-out de-rendering LICENSE.md), starters stay
    // hashless, the managed ci.yml hash matches the updated file, and the
    // manifest's own entry stays null (a self-hash would be circular) while
    // carrying the render's _commit as provenance.
    expect(existsSync(at(".github/repo-platform-manifest.json"))).toBe(true);
    const entry = (path: string) => manifestEntry(mp.project, path);
    expect(entry(".github/workflows/ci.yml")?.class).toBe("managed");
    expect(entry(".github/workflows/settings-sync.yml")).toBeUndefined();
    expect(entry("AGENTS.md")?.class).toBe("split");
    expect(entry(".github/settings.yml")?.class).toBe("starter");
    expect(entry("LICENSE.md")).toBeUndefined();
    expect(entry(".github/workflows/checks.yml")).toEqual({ class: "starter" });
    expect(entry(".github/workflows/ci.yml")?.hash).toBe(
      sha256File(at(".github/workflows/ci.yml")),
    );
    expect(entry(".github/repo-platform-manifest.json")?.hash).toBeNull();
    expect(entry(".github/repo-platform-manifest.json")?.commit).toBe(mp.fx.new.sha);
  });
});
