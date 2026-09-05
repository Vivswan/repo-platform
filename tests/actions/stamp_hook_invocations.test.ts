// The stamp hook runs on the destination exactly ONCE per render, measured
// with real copier against a scratch build tree whose hook copy logs each
// invocation: copier runs `_tasks` on copy and recopy AND on the
// destination pass of an update (9.17.0), where the 'after' `_migrations`
// entry already stamps, so copier.yml gates the task off updates; and
// copier runs migrations even under --skip-tasks, so an update with tasks
// skipped is still stamped once (a dependency this pins). Two
// destination runs would be idempotent but the pin is the point: a hook
// that ran twice once did, silently, and this counts it. Requires copier
// on PATH; skipped elsewhere (CI's upgrade-path job covers the same
// wiring end to end).

import { describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boundedSpawnSync } from "../shared/bounded_spawn";

const repoRoot = join(import.meta.dir, "../..");
const hasCopier = Bun.which("copier") !== null;
const COPIER_TIMEOUT_MS = 270_000;

describe.skipIf(!hasCopier)("stamp hook invocations per render (real copier)", () => {
  test("copy, update, recopy, and update --skip-tasks each stamp the destination exactly once with the render's full sha; another answers file is refused", () => {
    const base = mkdtempSync(join(tmpdir(), "stamp-hook-invocations-"));
    const log = join(base, "hook.log");
    const tree = join(base, "bt");
    const dest = join(base, "out");
    const run = (cmd: string[], cwd?: string, timeoutMs?: number) => {
      const proc = boundedSpawnSync(cmd, {
        cwd,
        env: { ...process.env, HOOK_LOG: log },
        timeoutMs,
      });
      if (proc.exitCode !== 0)
        throw new Error(`${cmd.join(" ")} failed:\n${proc.stdout}\n${proc.stderr}`);
      return proc.stdout;
    };
    const git = (cwd: string, ...args: string[]) =>
      run(["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@e.c", ...args]).trim();
    const destInvocations = () =>
      readFileSync(log, "utf-8")
        .split("\n")
        .filter((line) => line !== "")
        .filter((line) => line.startsWith(`${dest}\t`) || line.startsWith(`${realpath(dest)}\t`));
    const realpath = (p: string) => require("node:fs").realpathSync(p);
    // The value as the production readers see it: the hook quotes an
    // all-digit sha so PyYAML keeps it a string, so strip optional quotes.
    const commitOf = () =>
      /^_commit:[ \t]*(\S+)/m
        .exec(readFileSync(join(dest, ".github/.copier-answers.yml"), "utf-8"))?.[1]
        ?.replace(/^(['"])(.*)\1$/, "$2");
    try {
      run(["bun", join(repoRoot, ".github/scripts/build-branches/branch_tree.ts"), "--dest", tree]);
      // The scratch tree's hook copy logs "<cwd>\t<argv>" per invocation.
      const hook = join(tree, "actions/shared/stamp_manifest.ts");
      writeFileSync(
        hook,
        readFileSync(hook, "utf-8").replace(
          "function main(): number {\n",
          'function main(): number {\n  require("node:fs").appendFileSync(process.env.HOOK_LOG as string, `${process.cwd()}\\t${process.argv.slice(2).join(" ")}\\n`);\n',
        ),
      );
      writeFileSync(log, "");
      git(tree, "init", "-q", "-b", "build");
      git(
        tree,
        "-c",
        "core.attributesFile=/dev/null",
        "-c",
        "core.autocrlf=false",
        "add",
        "-A",
        "--force",
      );
      git(tree, "commit", "-qm", "b1");
      const b1 = git(tree, "rev-parse", "HEAD");
      const answers = [
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

      // A RELATIVE destination from the scratch root: copier runs the hook
      // with cwd at the destination, and a root argument that re-applied a
      // relative path would resolve inside it (the goldens render this way).
      run(
        ["copier", "copy", tree, "out", "--vcs-ref", "HEAD", ...answers],
        base,
        COPIER_TIMEOUT_MS,
      );
      expect(destInvocations()).toHaveLength(1);
      expect(destInvocations()[0]).toContain(`--commit ${b1}`);
      expect(commitOf()).toBe(b1);

      git(dest, "init", "-q");
      git(dest, "add", "-A");
      git(dest, "commit", "-qm", "init");
      appendFileSync(join(tree, "template/CONTRIBUTING.md.jinja"), "\n# invocation-count edit\n");
      git(tree, "add", "-A");
      git(tree, "commit", "-qm", "b2");
      const b2 = git(tree, "rev-parse", "HEAD");
      writeFileSync(log, "");
      run(
        [
          "copier",
          "update",
          "--answers-file",
          ".github/.copier-answers.yml",
          "--vcs-ref",
          b2,
          "--defaults",
          "--trust",
          "-d",
          "modules=[uv]",
          "-d",
          "private=false",
          "-d",
          "description=Y",
        ],
        dest,
        COPIER_TIMEOUT_MS,
      );
      expect(destInvocations()).toHaveLength(1);
      expect(destInvocations()[0]).toContain(`--commit ${b2}`);
      expect(commitOf()).toBe(b2);

      git(dest, "add", "-A");
      git(dest, "commit", "-qm", "updated");
      // Recopy re-renders at the same ref: corrupt the recorded value so
      // its restoration is the hook's doing, not a leftover.
      const answersPath = join(dest, ".github/.copier-answers.yml");
      writeFileSync(answersPath, readFileSync(answersPath, "utf-8").replace(b2, "stale"));
      git(dest, "commit", "-qam", "corrupt");
      writeFileSync(log, "");
      run(
        [
          "copier",
          "recopy",
          "--overwrite",
          "--answers-file",
          ".github/.copier-answers.yml",
          "--vcs-ref",
          b2,
          "--defaults",
          "--trust",
          "-d",
          "modules=[uv]",
          "-d",
          "private=false",
          "-d",
          "description=Y",
        ],
        dest,
        COPIER_TIMEOUT_MS,
      );
      expect(destInvocations()).toHaveLength(1);
      expect(destInvocations()[0]).toContain(`--commit ${b2}`);
      expect(commitOf()).toBe(b2);

      // update --skip-tasks: copier 9.17 still runs migrations, so the
      // destination is stamped once by the 'after' entry alone.
      git(dest, "add", "-A");
      git(dest, "commit", "-qm", "recopied");
      appendFileSync(join(tree, "template/CONTRIBUTING.md.jinja"), "\n# skip-tasks edit\n");
      git(tree, "add", "-A");
      git(tree, "commit", "-qm", "b3");
      const b3 = git(tree, "rev-parse", "HEAD");
      writeFileSync(log, "");
      run(
        [
          "copier",
          "update",
          "--skip-tasks",
          "--answers-file",
          ".github/.copier-answers.yml",
          "--vcs-ref",
          b3,
          "--defaults",
          "--trust",
          "-d",
          "modules=[uv]",
          "-d",
          "private=false",
          "-d",
          "description=Y",
        ],
        dest,
        COPIER_TIMEOUT_MS,
      );
      expect(destInvocations()).toHaveLength(1);
      expect(destInvocations()[0]).toContain(`--commit ${b3}`);
      expect(commitOf()).toBe(b3);

      // A render into another answers file is refused by the hook before
      // any mutation. copier still renders the template's OWN answers file
      // (the alternate is only where it READS answers) with its describe
      // value, so without the refusal the default file would be stamped
      // while the caller's file went unrecorded. Pre-created destination:
      // copier removes one IT created when a task fails.
      const alt = join(base, "alt");
      mkdirSync(alt);
      const proc = boundedSpawnSync(
        ["copier", "copy", tree, alt, "--answers-file", "other.yml", "--vcs-ref", b3, ...answers],
        { env: { ...process.env, HOOK_LOG: log }, timeoutMs: COPIER_TIMEOUT_MS },
      );
      expect(proc.exitCode).not.toBe(0);
      expect(proc.stderr + proc.stdout).toContain("--answers names 'other.yml'");
      expect(existsSync(join(alt, "other.yml"))).toBe(false);
      const defaultAnswers = readFileSync(join(alt, ".github/.copier-answers.yml"), "utf-8");
      expect(/^_commit:[ \t]*(\S+)/m.exec(defaultAnswers)?.[1]).toBe(b3.slice(0, 7));
      expect(readFileSync(join(alt, ".github/repo-platform-manifest.json"), "utf-8")).toContain(
        '"commit": null',
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }, 300_000);
});
