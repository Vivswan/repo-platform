// The retired-paths parse in retired_cleanup.ts must never echo its
// payload: the script's stdout is the public sync-leg log and the paths
// are target-derived. The pipeline ahead of the parse runs against a real
// target git repo, with copier and the two bun-spawned pipeline stages
// stubbed on PATH so the test reaches the parse without a template tree.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boundedSpawnSync } from "../shared/bounded_spawn";

const script = join(import.meta.dir, "../../.github/scripts/sync/retired_cleanup.ts");

function gitFreeEnv(): Record<string, string> {
  // Hook-driven runs (husky pre-commit) export GIT_DIR/GIT_INDEX_FILE, which
  // would redirect every git subprocess these tests spawn away from their
  // scratch repositories.
  const env = { ...process.env } as Record<string, string>;
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  return env;
}

describe("retired_cleanup retired-paths parse", () => {
  test("malformed retired_paths output fails value-free (no SyntaxError echo)", () => {
    const root = mkdtempSync(join(tmpdir(), "retired-cleanup-"));
    const bin = join(root, "bin");
    mkdirSync(bin);
    // The stub bun intercepts the two pipeline stages and forwards
    // everything else (including this test's own script invocation) to
    // the real bun. The retired_paths payload is the leaking form: a raw
    // JSON.parse error would quote 'corruptpath' into the public log.
    writeFileSync(
      join(bin, "bun"),
      [
        "#!/usr/bin/env bash",
        'case "$*" in',
        "  *render_data.ts*) exit 0 ;;",
        "  *retired_paths.ts*)",
        "    echo '[\"docs/kept.md\", corruptpath]'",
        "    exit 0",
        "    ;;",
        '  *) exec "$REAL_BUN" "$@" ;;',
        "esac",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    // The copier stub creates its destination (the last argument) like the
    // real one: clean_renders renames the scratch renders into place after
    // both succeed, and a missing directory would fail that publish.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: bash parameter expansion in the stub, not a JS template
    writeFileSync(join(bin, "copier"), '#!/usr/bin/env bash\nmkdir -p "${@: -1}"\nexit 0\n', {
      mode: 0o755,
    });

    const target = join(root, "target");
    mkdirSync(join(target, ".github"), { recursive: true });
    writeFileSync(join(target, ".github/.copier-answers.yml"), "modules: [uv]\n");
    const git = (...args: string[]) => {
      const proc = boundedSpawnSync(["git", "-C", target, ...args], { env: gitFreeEnv() });
      if (proc.exitCode !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${proc.stderr}`);
      }
    };
    git("init", "-b", "main");
    git("config", "user.name", "test");
    git("config", "user.email", "test@example.com");
    git("add", "-A");
    git("commit", "-qm", "pre-update state");

    const runnerTemp = join(root, "temp");
    mkdirSync(runnerTemp);
    const proc = boundedSpawnSync(["bun", script], {
      cwd: root,
      env: {
        ...gitFreeEnv(),
        PATH: `${bin}:${process.env.PATH}`,
        REAL_BUN: process.execPath,
        RUNNER_TEMP: runnerTemp,
        TARGET_DIR: target,
        MODULES: '["uv"]',
        PRIVATE: "false",
        DESCRIPTION: "d",
        SRC_PATH: root,
        OLD_SHA: "HEAD",
        TARGET_REF: "HEAD",
      },
    });
    expect(proc.exitCode).toBe(1);
    const stdout = proc.stdout;
    expect(stdout).toContain("::error::retired_cleanup: retired_paths.ts output: not valid JSON");
    expect(stdout + proc.stderr).not.toContain("corruptpath");
  });
});
