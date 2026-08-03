import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "run_hidden.sh");

function run(
  hide: string,
  cmd: string[],
): { exitCode: number; stdout: string; stderr: string; temp: string } {
  const temp = join(mkdtempSync(join(tmpdir(), "run-hidden-")), "temp");
  mkdirSync(temp);
  const proc = Bun.spawnSync(["bash", script, "leak test", "--", ...cmd], {
    env: { ...process.env, HIDE_DETAILS: hide, RUNNER_TEMP: temp },
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    temp,
  };
}

describe("run_hidden.sh", () => {
  test("passes through untouched when details are not hidden", () => {
    const r = run("false", ["bash", "-c", "echo target-secret; echo err-secret >&2; exit 3"]);
    expect(r.exitCode).toBe(3);
    expect(r.stdout).toContain("target-secret");
    expect(r.stderr).toContain("err-secret");
  });

  test("captures both streams and prints a generic outcome when hidden", () => {
    const r = run("true", ["bash", "-c", "echo target-secret; echo err-secret >&2"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout + r.stderr).not.toContain("target-secret");
    expect(r.stdout + r.stderr).not.toContain("err-secret");
    expect(r.stdout).toContain("leak test: ok (output hidden: private repository)");
    const captured = readFileSync(join(r.temp, "hidden-leak-test.log"), "utf-8");
    expect(captured).toContain("target-secret");
    expect(captured).toContain("err-secret");
    expect(existsSync(join(r.temp, "hidden-failures.tsv"))).toBe(false);
  });

  test("hidden failures keep the exit code and stay generic", () => {
    const r = run("true", ["bash", "-c", "echo failing-detail; exit 7"]);
    expect(r.exitCode).toBe(7);
    expect(r.stdout + r.stderr).not.toContain("failing-detail");
    expect(r.stdout).toContain("failed with exit 7 (output hidden: private repository)");
    const manifest = readFileSync(join(r.temp, "hidden-failures.tsv"), "utf-8");
    expect(manifest).toBe(`leak test\t7\t${join(r.temp, "hidden-leak-test.log")}\n`);
  });
});
