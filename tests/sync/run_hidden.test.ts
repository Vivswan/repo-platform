import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendHiddenFailure,
  captureName,
  parseHiddenFailures,
} from "../../.github/scripts/sync/run_hidden.ts";
import { boundedSpawnSync } from "../shared/bounded_spawn";

const script = join(import.meta.dir, "../../.github/scripts/sync/run_hidden.ts");

function run(
  hide: string,
  cmd: string[],
): { exitCode: number; stdout: string; stderr: string; temp: string } {
  const temp = join(mkdtempSync(join(tmpdir(), "run-hidden-")), "temp");
  mkdirSync(temp);
  const proc = boundedSpawnSync(["bun", script, "leak test", "--", ...cmd], {
    env: { ...process.env, HIDE_DETAILS: hide, RUNNER_TEMP: temp },
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout,
    stderr: proc.stderr,
    temp,
  };
}

describe("run_hidden.ts", () => {
  test("captureName squeezes non-alphanumeric runs and trims the edges", () => {
    expect(captureName("leak test")).toBe("hidden-leak-test.log");
    expect(captureName(" post-withhold re-validation!")).toBe(
      "hidden-post-withhold-re-validation.log",
    );
  });

  test("parseHiddenFailures is total: malformed rows are counted, never returned", () => {
    // Torn-write shapes: a short row (the write died mid-row), a bare
    // label, an extra field, and an empty field. None may surface as a
    // HiddenFailure with undefined fields.
    const parsed = parseHiddenFailures(
      [
        "branch push\t1\t/tmp/rt/hidden-branch-push.log",
        "copier update\t3",
        "lonely-label",
        "a\t1\t/tmp/rt/a.log\textra",
        "empty-rc\t\t/tmp/rt/b.log",
        "",
      ].join("\n"),
    );
    expect(parsed.failures).toEqual([
      { label: "branch push", rc: "1", capture: "/tmp/rt/hidden-branch-push.log" },
    ]);
    expect(parsed.malformedRows).toBe(4);
  });

  test("parseHiddenFailures control: a well-formed manifest parses whole", () => {
    const parsed = parseHiddenFailures("a\t1\t/tmp/rt/a.log\nb\t2\t/tmp/rt/b.log\n");
    expect(parsed.failures).toHaveLength(2);
    expect(parsed.malformedRows).toBe(0);
  });

  test("an unterminated tail row is malformed even with three fields", () => {
    // appendHiddenFailure newline-terminates every record, so a tail with
    // no newline is a torn write whose capture path may be cut short -
    // three fields or not.
    const parsed = parseHiddenFailures("a\t1\t/tmp/rt/a.log\nb\t9\t/tmp/rt/hidden-b.lo");
    expect(parsed.failures).toEqual([{ label: "a", rc: "1", capture: "/tmp/rt/a.log" }]);
    expect(parsed.malformedRows).toBe(1);
  });

  test("empty rows are malformed, never silently dropped", () => {
    // A newline-only manifest passes failure_issue.ts's non-empty-file
    // guard; without a malformed count it would deliver a report that
    // silently claims completeness with nothing in it.
    expect(parseHiddenFailures("\n")).toEqual({ failures: [], malformedRows: 1 });
    const interior = parseHiddenFailures("a\t1\t/tmp/rt/a.log\n\nb\t2\t/tmp/rt/b.log\n");
    expect(interior.failures).toHaveLength(2);
    expect(interior.malformedRows).toBe(1);
  });

  test("appendHiddenFailure rejects delimiter-bearing fields loudly", () => {
    // The parser is total, so a tab or newline smuggled into a field would
    // write a row the reader downgrades to "malformed" - a real failure
    // silently lost. Unreachable today (labels are literals, capture paths
    // squeeze through captureName), so the writer treats it as a
    // programmer error instead of guarding every reader.
    const temp = join(mkdtempSync(join(tmpdir(), "run-hidden-")), "temp");
    mkdirSync(temp);
    expect(() => appendHiddenFailure(temp, "tab\tlabel", 1, "/tmp/rt/a.log")).toThrow();
    expect(() => appendHiddenFailure(temp, "label", 1, "/tmp/rt/a\n.log")).toThrow();
    expect(() => appendHiddenFailure(temp, "cr\rlabel", 1, "/tmp/rt/a.log")).toThrow();
    expect(existsSync(join(temp, "hidden-failures.tsv"))).toBe(false);
    // Control: a clean record appends and round-trips through the parser.
    appendHiddenFailure(temp, "branch push", 1, "/tmp/rt/a.log");
    const parsed = parseHiddenFailures(readFileSync(join(temp, "hidden-failures.tsv"), "utf-8"));
    expect(parsed.failures).toEqual([{ label: "branch push", rc: "1", capture: "/tmp/rt/a.log" }]);
    expect(parsed.malformedRows).toBe(0);
  });

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
