// The rung is seen red on the old shape (a seed without the marker gets it, the path reported) and silent as a
// control (a repository's own hook, a marked hook, a missing one); the fleet's seeds differ only in their header
// comment, so one old wording stands for them all, and the compare is the body alone.

import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOOKS } from "../../actions/plan/hooks";
import { PLACEHOLDER_MARKER } from "../../actions/shared/platform";
import { belowHeader, SEED_BODIES } from "../../migrations/0004-hook-placeholder-marker";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();
const RUNG = new URL("../../migrations/0004-hook-placeholder-marker.ts", import.meta.url).pathname;
const TEMPLATES = new URL("../../files/base", import.meta.url).pathname;
const SILENT = { exitCode: 0, stdout: "", stderr: "" };

/** An earlier sync's header wording over the seed body: the shape the fleet still holds. */
const OLD_HEADER =
  "# Repo-owned: seeded once by the fleet sync, never overwritten.\n# REPLACE the no-op job with this repository's work.\n\n";
const oldSeed = (hook: keyof typeof HOOKS) => `${OLD_HEADER}${SEED_BODIES[hook]}`;
const REAL_HOOK =
  "# This repository's own hook.\nname: Post Green\n\non:\n  workflow_call:\n\njobs:\n  publish:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ./.github/actions/publish\n";

function checkout(files: Record<string, string>): string {
  const root = temp.dir("migration-0004-");
  mkdirSync(join(root, ".github/workflows"), { recursive: true });
  for (const [relative, text] of Object.entries(files)) writeFileSync(join(root, relative), text);
  return root;
}

const run = (root: string) => boundedSpawnSync([process.execPath, RUNG, root]);
const read = (root: string, relative: string) => readFileSync(join(root, relative), "utf-8");

describe("0004-hook-placeholder-marker", () => {
  // The fixture is the body the shipped templates still carry below their header: a template whose body moved
  // would leave the fleet's older seeds unmatched, so the drift is caught here, not in a repository.
  test("the seed bodies kept here are the shipped templates' bodies", () => {
    for (const [hook, relative] of Object.entries(HOOKS) as [keyof typeof HOOKS, string][]) {
      expect(belowHeader(readFileSync(join(TEMPLATES, relative), "utf-8"))).toBe(SEED_BODIES[hook]);
    }
  });

  test("an unmarked seed of each hook gets the marker as its first line, the rest byte for byte; a second run is silent", () => {
    const root = checkout({
      [HOOKS["post-green"]]: oldSeed("post-green"),
      [HOOKS["release-gate"]]: oldSeed("release-gate"),
    });
    expect(run(root)).toEqual({
      exitCode: 0,
      stdout: `${HOOKS["post-green"]}\n${HOOKS["release-gate"]}\n`,
      stderr: "",
    });
    for (const hook of ["post-green", "release-gate"] as const) {
      expect(read(root, HOOKS[hook])).toBe(`${PLACEHOLDER_MARKER}\n${oldSeed(hook)}`);
    }
    expect(run(root)).toEqual(SILENT);
    expect(read(root, HOOKS["post-green"])).toBe(`${PLACEHOLDER_MARKER}\n${oldSeed("post-green")}`);
  });

  test.each<{ reason: string; files: Record<string, string> }>([
    { reason: "no hooks at all", files: {} },
    { reason: "a repository's own hook", files: { [HOOKS["post-green"]]: REAL_HOOK } },
    {
      reason: "a seed whose body differs by one byte",
      files: {
        [HOOKS["post-green"]]: oldSeed("post-green").replace(
          "timeout-minutes: 5",
          "timeout-minutes: 6",
        ),
      },
    },
    {
      reason: "a hook already marked",
      files: { [HOOKS["release-gate"]]: `${PLACEHOLDER_MARKER}\n${oldSeed("release-gate")}` },
    },
    {
      reason: "one hook's body under the other's path",
      files: { [HOOKS["release-gate"]]: oldSeed("post-green") },
    },
  ])("$reason is a no-op", ({ files }) => {
    const root = checkout(files);
    expect(run(root)).toEqual(SILENT);
    for (const [relative, text] of Object.entries(files)) expect(read(root, relative)).toBe(text);
  });

  test("a symbolic link where the workflows directory should be stops the rung before any write", () => {
    const root = temp.dir("migration-0004-link-");
    const elsewhere = temp.dir("migration-0004-elsewhere-");
    mkdirSync(join(root, ".github"));
    symlinkSync(elsewhere, join(root, ".github/workflows"));
    writeFileSync(join(elsewhere, "post-green.yml"), oldSeed("post-green"));
    const result = run(root);
    expect([result.exitCode, result.stdout]).toEqual([1, ""]);
    expect(result.stderr).toContain("its ancestor '.github/workflows' is a symbolic link");
    expect(readFileSync(join(elsewhere, "post-green.yml"), "utf-8")).toBe(oldSeed("post-green"));
  });

  // Not a file and not absent: the row fails loudly rather than reading the hook as missing, the writer's own rule.
  test("a directory at a hook's path fails the row, naming the path", () => {
    const root = checkout({});
    mkdirSync(join(root, HOOKS["release-gate"]));
    const result = run(root);
    expect([result.exitCode, result.stdout]).toEqual([1, ""]);
    expect(result.stderr).toContain(`${HOOKS["release-gate"]}: not a regular file`);
  });
});
