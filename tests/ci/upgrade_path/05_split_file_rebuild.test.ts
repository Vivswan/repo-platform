// Split-file structural rebuild (regenerate-and-splice): the primary sync
// path discards copier's merged result for every split-class file and
// rebuilds it structurally, the managed half from the clean render at the
// new ref, the repository-owned sides byte-for-byte from HEAD. The fixture
// plants a local AGENTS.md tail, a local .gitignore entry above the managed
// BEGIN, and a hand edit INSIDE CODEOWNERS's managed region, then updates
// to a build whose template changed each file's managed region. Sides must
// ride through byte-preserved, managed regions must equal render-new
// byte-for-byte, the managed-region edit must be reset and flagged for
// review, and no split file may appear in the dropped-hunks summary. The
// same fixture declares LICENSE.md mirrors the way the skills repo does:
// every mirror comes out byte-identical to the DELIVERED file, a glob
// creates the copy a new folder never had, and hostile targets (a
// traversal, a template-owned file) are refused with no write.

import { expect } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { editText, insertBeforeLine, linesOf } from "./edits";
import {
  answersAtHead,
  appendText,
  type Build,
  CI_IDENTITY,
  COPIER_CONFLICT_MARKER,
  commitAll,
  describeLeg,
  type Fixture,
  filesContaining,
  git,
  isEmptyFile,
  legTest,
  lexists,
  MARKERS,
  preserveLocalContentArgs,
  readText,
  recordedSrcPath,
  renderProject,
  resolveConflictsArgs,
  type ScriptEnv,
  snapshotCopierYml,
  stampManifest,
  syncScript,
  textOrEmpty,
  upgradePathHarness,
  validateGenerated,
  writeText,
} from "./fixture";
import { commitSplitBuild, SPLIT_MANAGED_LINES } from "./split_build";

const harness = upgradePathHarness();

const DESCRIPTION = "Split-rebuild project";
const AGENTS_TAIL = "## Local agent docs\n\nsplit-local agents tail";
const CODEOWNERS_HAND_EDIT = "# split-local hand edit inside the managed region";
const LICENSE_TAIL = "split-local license tail";
const MIRRORS = ["template/LICENSE.md", "skills/alpha/LICENSE.md", "skills/beta/LICENSE.md"];
const SPLIT_FILES = ["AGENTS.md", ".github/CODEOWNERS", ".gitignore"];

/** The lines above the first managed BEGIN line (the repository-owned above-side). */
function aboveManaged(text: string): string[] {
  const lines = linesOf(text);
  const begin = lines.indexOf(MARKERS.hash.begin);
  return begin === -1 ? lines : lines.slice(0, begin);
}

/** The lines from the first managed BEGIN line to the end of the file. */
function fromManagedBegin(text: string): string[] {
  const lines = linesOf(text);
  const begin = lines.indexOf(MARKERS.hash.begin);
  return begin === -1 ? [] : lines.slice(begin);
}

describeLeg("05 split file rebuild", () => {
  let fx: Fixture;
  let splitBuild: Build;
  let project: string;
  let work: string;
  let renderNew: string;
  let gitignoreAboveExpected: string[];
  let env: ScriptEnv;

  legTest("the fixture carries local sides, a managed-region edit, and mirror declarations", () => {
    fx = harness.fixture();
    splitBuild = commitSplitBuild(fx);
    project = fx.path("upgrade-split");
    work = fx.mkdir("upgrade-split-work");
    renderNew = join(work, "render-new");
    renderProject(project, fx.new.tag, {
      projectName: "Split Rebuild",
      description: DESCRIPTION,
      modules: [],
      private: false,
    });

    appendText(join(project, "AGENTS.md"), `\n${AGENTS_TAIL}\n`);
    const gitignore = join(project, ".gitignore");
    editText(gitignore, (text) =>
      insertBeforeLine(
        text,
        (line) => line === MARKERS.hash.begin,
        ["split-local-cache/"],
        "plant the .gitignore entry above the managed region",
      ),
    );
    gitignoreAboveExpected = aboveManaged(readText(gitignore));
    expect(gitignoreAboveExpected).toContain("split-local-cache/");
    const codeowners = join(project, ".github/CODEOWNERS");
    editText(codeowners, (text) => {
      const lines = linesOf(text);
      if (lines[0] !== MARKERS.hash.begin) throw new Error("CODEOWNERS does not open on BEGIN");
      lines.splice(1, 0, CODEOWNERS_HAND_EDIT);
      return `${lines.join("\n")}\n`;
    });
    expect(readText(codeowners)).toContain(CODEOWNERS_HAND_EDIT);

    // The mirror fixture: a repo-owned tail below LICENSE.md's END marker,
    // stale copies in template/ and one skill folder, a second skill folder
    // with NO copy yet, and the repo-owned declaration in .repo-platform.yml.
    appendText(join(project, "LICENSE.md"), `\n${LICENSE_TAIL}\n`);
    mkdirSync(join(project, "skills/alpha"), { recursive: true });
    mkdirSync(join(project, "skills/beta"), { recursive: true });
    mkdirSync(join(project, "template"), { recursive: true });
    writeText(join(project, "template/LICENSE.md"), "stale mirror (must be overwritten)\n");
    writeText(join(project, "skills/alpha/LICENSE.md"), "stale mirror (must be overwritten)\n");
    writeText(join(project, "skills/beta/SKILL.md"), "name: beta\n");
    appendText(
      join(project, ".repo-platform.yml"),
      "mirrors:\n  - source: LICENSE.md\n    targets:\n      - template/LICENSE.md\n      - skills/*/LICENSE.md\n",
    );
    commitAll(project, "chore: local modifications");
  });

  legTest("the update runs the workflow's leg order into the split build", () => {
    env = {
      MODULES: "[]",
      PRIVATE: "false",
      DESCRIPTION,
      TARGET_DIR: project,
      TARGET_REF: splitBuild.tag,
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
    snapshotCopierYml(work, fx.new.tag, splitBuild.tag);
    syncScript("retired_cleanup", renders);
    syncScript("preserve_repo_owned", env);
    syncScript("materialize_mirrors", env, ["--root", project]);
    stampManifest(project);
    validateGenerated(project);
  });

  legTest("sides ride through byte-preserved and managed regions equal render-new", () => {
    // AGENTS.md: the whole file is exactly render-new plus the local tail.
    const agents = readText(join(project, "AGENTS.md"));
    expect(agents).toBe(`${readText(join(renderNew, "AGENTS.md"))}\n${AGENTS_TAIL}\n`);
    expect(agents).toContain(SPLIT_MANAGED_LINES.agents);

    // CODEOWNERS: the hand edit inside the managed region is RESET and the
    // reset is flagged for review, loudly.
    const codeowners = readText(join(project, ".github/CODEOWNERS"));
    expect(codeowners).toBe(readText(join(renderNew, ".github/CODEOWNERS")));
    expect(codeowners).not.toContain(CODEOWNERS_HAND_EDIT);
    expect(codeowners).toContain(SPLIT_MANAGED_LINES.codeowners);
    const review = linesOf(readText(join(work, "carry-review.txt")));
    expect(
      review.some((line) => line.startsWith(".github/CODEOWNERS: managed-region edits reset")),
    ).toBe(true);
    expect(readText(join(work, "local-carryover.md"))).toContain("RESET to the fresh render");
    // The clean carries stay auto-merge-eligible (LICENSE.md's tail is a
    // clean side-restore).
    expect(review.filter((line) => /^(AGENTS\.md|\.gitignore|LICENSE\.md):/.test(line))).toEqual(
      [],
    );

    // .gitignore: the above-side byte-preserved, the managed region (BEGIN
    // to end of file; nothing sits below END here) byte-equal to render-new.
    const gitignore = readText(join(project, ".gitignore"));
    expect(aboveManaged(gitignore)).toEqual(gitignoreAboveExpected);
    expect(fromManagedBegin(gitignore)).toEqual(
      fromManagedBegin(readText(join(renderNew, ".gitignore"))),
    );
    expect(linesOf(gitignore)).toContain(SPLIT_MANAGED_LINES.gitignore);

    // The split files never reach the conflict resolver.
    const dropped = textOrEmpty(join(work, "dropped-local-hunks.md"));
    for (const file of SPLIT_FILES) expect(dropped).not.toContain(`\`${file}\``);
    expect(filesContaining(project, COPIER_CONFLICT_MARKER)).toEqual([]);
  });

  legTest("every declared mirror is byte-identical to the delivered LICENSE.md", () => {
    const delivered = readText(join(project, "LICENSE.md"));
    for (const mirror of MIRRORS) expect(readText(join(project, mirror))).toBe(delivered);
    const alpha = readText(join(project, "skills/alpha/LICENSE.md"));
    expect(alpha).toContain(SPLIT_MANAGED_LINES.license);
    expect(alpha).toContain(LICENSE_TAIL);
    expect(readText(join(work, "mirrors.md"))).toContain("`template/LICENSE.md` <- `LICENSE.md`");
    expect(textOrEmpty(join(work, "mirrors-review.md"))).toBe("");
    expect(readText(join(project, ".repo-platform.yml"))).toContain("mirrors:");
  });

  legTest("hostile mirror declarations are refused with no write", () => {
    const hostileWork = fx.mkdir("upgrade-split-hostile");
    const declaration = join(project, ".repo-platform.yml");
    const modulesLines = linesOf(readText(declaration)).filter((line) =>
      line.startsWith("modules:"),
    );
    if (modulesLines.length === 0) throw new Error(".repo-platform.yml carries no modules: line");
    writeText(
      declaration,
      `${modulesLines.join("\n")}\nmirrors:\n  - source: LICENSE.md\n    targets:\n      - ../mirror-escape.md\n      - .github/CODEOWNERS\n`,
    );
    git(project, "add", ".repo-platform.yml");
    git(project, ...CI_IDENTITY, "commit", "-q", "-m", "chore: hostile mirror fixture");
    syncScript("materialize_mirrors", { ...env, RUNNER_TEMP: hostileWork }, ["--root", project]);

    expect(lexists(join(fx.runDir, "mirror-escape.md"))).toBe(false);
    expect(readText(join(project, ".github/CODEOWNERS"))).toBe(
      readText(join(renderNew, ".github/CODEOWNERS")),
    );
    const refusal = join(hostileWork, "mirrors-review.md");
    expect(existsSync(refusal)).toBe(true);
    expect(isEmptyFile(refusal)).toBe(false);
    expect(readText(refusal)).toContain("CODEOWNERS");
  });
});
