// rebuild_split_files.ts: the split-file rebuild leg behind run_hidden. A
// stub bun records the spawned argv; the render-dir pair is present in a
// normal run and absent in recovery mode (no usable old render).

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { argvStub } from "../shared/argv_stub";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();
const SYNC = join(import.meta.dir, "../../.github/scripts/sync");
const script = join(SYNC, "rebuild_split_files.ts");

function run(env: Record<string, string | undefined>) {
  const stub = argvStub(temp.dir("rebuild-split-"), "bun");
  const proc = boundedSpawnSync([process.execPath, script], {
    env: {
      ...process.env,
      PATH: `${stub.bin}:${process.env.PATH}`,
      RUNNER_TEMP: "/rt",
      HIDE_DETAILS: "true",
      RECOVER: "",
      STUB_EXIT: undefined,
      ...env,
    },
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout,
    stderr: proc.stderr,
    calls: stub.calls(),
  };
}

/** The wrapped rebuild call before its optional render-dir pair. */
function common(hideDetails: string): string[] {
  return [
    "bun",
    join(SYNC, "run_hidden.ts"),
    "split-file rebuild",
    "--",
    "bun",
    join(SYNC, "preserve_local_content.ts"),
    "--summary",
    "/rt/local-carryover.md",
    "--root",
    "target",
    "--hide-details",
    hideDetails,
    "--needs-review",
    "/rt/carry-review.txt",
    "--rebuilt-paths",
    "/rt/split-rebuilt-paths.txt",
  ];
}
const RENDER_DIRS = ["--render-dir", "/rt/render-new", "--old-render-dir", "/rt/render-old"];

describe("rebuild_split_files.ts", () => {
  test("a normal run rebuilds against both clean renders", () => {
    expect(run({})).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
      calls: [[...common("true"), ...RENDER_DIRS]],
    });
  });

  test("recovery mode leaves the render dirs off (no usable old render)", () => {
    expect(run({ RECOVER: "recopy" })).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
      calls: [common("true")],
    });
  });

  test("the hide-details flag carries the job's raw value, and the child's exit code is the step's", () => {
    expect(run({ HIDE_DETAILS: "false", STUB_EXIT: "4" })).toEqual({
      exitCode: 4,
      stdout: "",
      stderr: "",
      calls: [[...common("false"), ...RENDER_DIRS]],
    });
  });
});
