// The last gate in front of a destructive settings apply: it publishes
// `moved`, and the apply runs only on `moved == 'false'`. Every path that
// cannot prove the target is unmoved must therefore publish NOTHING - an
// absent output is what keeps the apply off - so these cases assert the
// output file's contents, not just the exit code.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { boundedSpawnSync } from "../shared/bounded_spawn";

const script = resolve(import.meta.dir, "../../.github/scripts/fleet/check_target_fresh.ts");
const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);

describe("check_target_fresh", () => {
  /** Runs the script with a stub `gh` that answers the two calls
   *  resolveTargetRef makes, or fails when `failGh` is set. */
  function run(env: Record<string, string>, failGh = false) {
    const root = mkdtempSync(join(tmpdir(), "fresh-"));
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "gh"),
      [
        "#!/usr/bin/env bash",
        failGh ? 'echo "gh: HTTP 404" >&2; exit 1' : "",
        'case "$*" in',
        `  *commits*) echo ${HEAD} ;;`,
        "  *) echo main ;;",
        "esac",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const outputPath = join(root, "output.txt");
    const proc = boundedSpawnSync(["bun", script], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GITHUB_OUTPUT: outputPath,
        GH_TOKEN: "stub",
        ...env,
      },
    });
    return {
      exitCode: proc.exitCode,
      stderr: proc.stderr,
      stdout: proc.stdout,
      outputs: existsSync(outputPath) ? readFileSync(outputPath, "utf-8") : "",
    };
  }

  test("an unmoved target publishes moved=false, which is what opens the gate", () => {
    const result = run({ TARGET: "o/r", PINNED: HEAD });
    expect(result.exitCode).toBe(0);
    expect(result.outputs).toBe("moved=false\n");
  });

  test("a moved target publishes moved=true and says what moved", () => {
    const result = run({ TARGET: "o/r", PINNED: OLD });
    expect(result.exitCode).toBe(0);
    expect(result.outputs).toBe("moved=true\n");
    expect(result.stdout).toContain(OLD);
    expect(result.stdout).toContain(HEAD);
  });

  test("an EMPTY pin is refused, never treated as fresh", () => {
    // Every fact source pins now, local checkouts included. An empty pin
    // means the render published nothing to compare against; guessing
    // "not moved" here would be the one path reaching a mutation
    // unchecked.
    const result = run({ TARGET: "o/r", PINNED: "" });
    expect(result.exitCode).not.toBe(0);
    expect(result.outputs).toBe("");
    // The SPECIFIC refusal, not a generic missing-env exit: a plain
    // required-env read would also fail here, and would say nothing about
    // why an unpinned target must never be applied to.
    expect(result.stdout).toContain("no pinned commit");
  });

  test("an unresolvable target publishes nothing, so the apply stays off", () => {
    const result = run({ TARGET: "o/r", PINNED: HEAD }, true);
    expect(result.exitCode).not.toBe(0);
    expect(result.outputs).toBe("");
    // The RESOLVER's failure, naming the target - not an unrelated crash
    // that happened to publish nothing.
    expect(result.stderr).toContain("o/r: cannot read the default branch");
  });
});
