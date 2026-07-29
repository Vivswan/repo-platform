import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const HELPER = join(import.meta.dir, "commit_stamp.sh");

// Run a snippet with the helper sourced, the way its callers use it.
function stamped(script: string): string {
  const proc = Bun.spawnSync(["bash", "-euo", "pipefail", "-c", `. "${HELPER}"\n${script}`]);
  expect(proc.stderr.toString()).toBe("");
  expect(proc.exitCode).toBe(0);
  return proc.stdout.toString();
}

describe("commit stamp", () => {
  test("write then parse round-trips the sha", () => {
    const sha = "62653b669d40d3c88b6a0c713942d7e80ac4032d";
    const out = stamped(
      `commit_stamp_write https://github.com Vivswan/repo-platform ${sha} | commit_stamp_parse`,
    );
    expect(out).toBe(`${sha}\n`);
  });

  test("parse finds the stamp inside a full build commit message", () => {
    const message = [
      "build(staging): main from 62653b669d40",
      "",
      "source: https://github.com/Vivswan/repo-platform/commit/62653b669d40d3c88b6a0c713942d7e80ac4032d",
      "run: https://github.com/Vivswan/repo-platform/actions/runs/1",
    ].join("\n");
    const out = stamped(`commit_stamp_parse <<'MESSAGE'\n${message}\nMESSAGE`);
    expect(out).toBe("62653b669d40d3c88b6a0c713942d7e80ac4032d\n");
  });

  test("parse prints nothing for a message without a stamp", () => {
    const out = stamped(`commit_stamp_parse <<'MESSAGE'\nchore: no stamp here\nMESSAGE`);
    expect(out).toBe("");
  });
});
