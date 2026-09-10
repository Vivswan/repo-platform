// End-to-end: a real build tree, a real copier recopy, and the carry
// restoring every repo-owned side; runs only where copier is on PATH.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boundedSpawnSync } from "../../shared/bounded_spawn";
import { tempDirs } from "../../shared/temp_dir";
import { E, gitFreeEnv, HB, initGitRepo, repoRoot, script } from "./fixtures";

const temp = tempDirs();

// End-to-end against a REAL template render and a REAL `copier recopy
// --overwrite`, mirroring reusable-template-sync.yml's recovery path: the
// recopy resets the sanctioned repo-owned sides (the live defect) and the
// carry must restore every one. Requires copier on PATH, so CI's
// script-tests job skips it; the always-on coverage is the upgrade-path
// harness's recovery leg (tests/ci/upgrade_path/02_recovery_recopy.test.ts), which
// drives the same carry against a real recopy.
const hasCopier = Bun.which("copier") !== null;

describe.skipIf(!hasCopier)("preserve_local_content end-to-end (copier recopy)", () => {
  test(
    "restores the repo-owned sides a recovery re-render wipes",
    () => {
      const base = temp.dir("preserve-local-e2e-");
      const tree = join(base, "bt");
      const target = join(base, "out");
      // Only the copier renders need a wide bound; everything else keeps
      // the wrapper's default, and both stay under the test's 300s cap
      // so a wedge dies named.
      const COPIER_TIMEOUT_MS = 270_000;
      const run = (cmd: string[], cwd?: string, timeoutMs?: number) => {
        const proc = boundedSpawnSync(cmd, { cwd, env: gitFreeEnv(), timeoutMs });
        if (proc.exitCode !== 0) {
          throw new Error(`${cmd.join(" ")} failed:\n${proc.stdout}\n${proc.stderr}`);
        }
        return proc.stdout;
      };
      run(["bun", join(repoRoot, ".github/scripts/build-branches/branch_tree.ts"), "--dest", tree]);
      run(["git", "-C", tree, "init", "-b", "build"]);
      run(["git", "-C", tree, "add", "-A"]);
      run(["git", "-C", tree, "-c", "user.name=t", "-c", "user.email=t@e.c", "commit", "-qm", "b"]);
      const copierArgs = [
        "--defaults",
        "--trust",
        "-d",
        "project_name=X",
        "-d",
        "description=Y",
        "-d",
        "modules=[uv]",
        "-d",
        "private=false",
      ];
      run(
        ["copier", "copy", tree, target, "--vcs-ref", "HEAD", ...copierArgs],
        undefined,
        COPIER_TIMEOUT_MS,
      );

      // Customize every sanctioned repo-owned side, plus the repo-owned
      // exemptions file, and commit: this is the pre-recovery repo state.
      const tails: Record<string, string> = {
        "AGENTS.md": "\n## Project docs\n\nrepo-local agent guidance\n",
        "LICENSE.md": "\nThird-party components: repo-local notice\n",
        ".gitattributes": "*.repo-local binary\n",
        ".editorconfig": "\n[legacy/**.js]\nindent_size = 3\n",
        ".github/CODEOWNERS": "\n/security/ @security-team\n",
      };
      for (const [rel, tail] of Object.entries(tails)) {
        const path = join(target, rel);
        writeFileSync(path, readFileSync(path, "utf-8") + tail);
      }
      // .gitignore: local content lives ABOVE the managed BEGIN marker.
      const gitignorePath = join(target, ".gitignore");
      writeFileSync(
        gitignorePath,
        readFileSync(gitignorePath, "utf-8").replace(`${HB}\n`, `/repo-local-cache/\n\n${HB}\n`),
      );
      writeFileSync(join(target, ".typography-allow.local"), "docs/legacy/\n");
      initGitRepo(target);

      // The recovery re-render, exactly as apply_update.ts issues it.
      run(
        [
          "copier",
          "recopy",
          "--overwrite",
          // Where copier reads the recorded answers: the CLI flag or the
          // hardcoded root default, never the template's _answers_file -
          // the same flag apply_update.ts passes.
          "--answers-file",
          ".github/.copier-answers.yml",
          "--vcs-ref",
          "HEAD",
          ...copierArgs,
        ],
        target,
        COPIER_TIMEOUT_MS,
      );
      // Defect reproduced: the re-render reset the repo-owned sides.
      expect(readFileSync(join(target, "AGENTS.md"), "utf-8")).not.toContain(
        "repo-local agent guidance",
      );
      expect(readFileSync(gitignorePath, "utf-8")).not.toContain("/repo-local-cache/");
      // recopy deletes nothing: the separate repo-owned file survives.
      expect(existsSync(join(target, ".typography-allow.local"))).toBe(true);

      const summaryPath = join(base, "local-carryover.md");
      run(["bun", script, "--summary", summaryPath, "--root", target]);

      for (const [rel, tail] of Object.entries(tails)) {
        expect(readFileSync(join(target, rel), "utf-8")).toEndWith(tail);
      }
      expect(readFileSync(join(target, "AGENTS.md"), "utf-8")).toContain(E);
      expect(readFileSync(gitignorePath, "utf-8")).toContain("/repo-local-cache/");
      const summary = readFileSync(summaryPath, "utf-8");
      for (const rel of [...Object.keys(tails), ".gitignore"]) {
        expect(summary).toContain(`- \`${rel}\`:`);
      }
      // The whole carried tree must still validate.
      const validate = boundedSpawnSync([
        "bun",
        join(repoRoot, "actions/validate-template-report/validator/validate_generated_files.ts"),
        target,
      ]);
      expect(validate.exitCode).toBe(0);
    },
    { timeout: 300000 },
  );
});
