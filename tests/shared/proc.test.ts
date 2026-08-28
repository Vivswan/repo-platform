// Pins the timeout contract on capture and mustCapture: every piped run
// is bounded - an explicit timeoutMs wins, and without one the default
// hang bound applies (bun >= 1.4.0 waits for piped-stdio EOF rather than
// child exit, so an unbounded piped run can hang forever on an orphaned
// pipe holder). A run cut off by its deadline is a FAILURE: capture
// reports timedOut with a nonzero exitCode, mustCapture names the
// deadline and exits nonzero - even when the child itself exited 0 and
// only an orphan wedged the pipe until the deadline.

import { describe, expect, test } from "bun:test";
import {
  capture,
  DEFAULT_HANG_BOUND_MS,
  mustCapture,
  timeoutExitCode,
} from "../../.github/scripts/shared/proc";

describe("capture timeoutMs", () => {
  test("absent: the hang bound is the deadline; a normal exit reports timedOut false", () => {
    // Minutes, not seconds - a hang bound must never cut a legitimate
    // operation short - but small enough to fire before the job-level
    // timeout kills the runner.
    expect(DEFAULT_HANG_BOUND_MS).toBe(300_000);
    const result = capture(["true"]);
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  test("an expiring deadline kills the child and reports timedOut", () => {
    const start = Date.now();
    const result = capture(["sleep", "5"], { timeoutMs: 200 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(Date.now() - start).toBeLessThan(3000);
  });

  test("an orphan holding the pipe cannot stretch the deadline or mask the kill", () => {
    // The child is still running at the deadline while its backgrounded
    // grandchild holds the pipe fds: the SIGKILL only reaps the child, so
    // spawnSync must return at the kill (not at the orphan's EOF, ~5s)
    // and report a loud nonzero timeout under every bun version.
    const start = Date.now();
    const result = capture(["sh", "-c", "sleep 5 & sleep 5"], { timeoutMs: 200 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(Date.now() - start).toBeLessThan(3000);
  });

  test("a clean child exit behind a pipe-wedging orphan never reads as success", () => {
    // Under bun >= 1.4.0 this child exits 0 immediately but spawnSync
    // waits at the pipe until the deadline and reports exitedDueToTimeout
    // with the child's exit code 0 - which must surface as timedOut plus
    // a nonzero exitCode (124). Under bun < 1.4.0 spawnSync returns at
    // child exit, so the run legitimately succeeds; either way, timedOut
    // and a zero exitCode must never coincide.
    const result = capture(["sh", "-c", "sleep 2 & exit 0"], { timeoutMs: 400 });
    expect(result.exitCode).toBe(result.timedOut ? 124 : 0);
  });

  test("a deadline that is not hit: timedOut false, output intact", () => {
    const result = capture(["echo", "ok"], { timeoutMs: 5000 });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ok\n");
  });
});

describe("timeoutExitCode", () => {
  test("a child that exited 0 before the deadline still maps to failure (124)", () => {
    expect(timeoutExitCode({ exitCode: 0, signalCode: null })).toBe(124);
  });

  test("a killed or failed child keeps its own code", () => {
    expect(timeoutExitCode({ exitCode: null, signalCode: "SIGKILL" })).toBe(137);
    expect(timeoutExitCode({ exitCode: 3, signalCode: null })).toBe(3);
  });
});

describe("mustCapture timeoutMs", () => {
  const procModule = new URL("../../.github/scripts/shared/proc.ts", import.meta.url).pathname;

  test("a deadline that is not hit returns trimmed stdout", () => {
    expect(mustCapture(["echo", "ok"], { timeoutMs: 5000 })).toBe("ok");
  });

  test("an expiring deadline names it and exits nonzero", () => {
    // mustCapture exits the calling process on failure, so the timeout
    // path runs in a child bun invoking it against a stalled command.
    const snippet = [
      `import { mustCapture } from ${JSON.stringify(procModule)};`,
      'mustCapture(["sleep", "5"], { timeoutMs: 200 });',
      'console.log("unreachable");',
    ].join("\n");
    const start = Date.now();
    const result = capture(["bun", "-e", snippet], { timeoutMs: 10_000 });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain("unreachable");
    expect(result.stderr).toContain("timed out after 200ms: sleep 5");
    expect(Date.now() - start).toBeLessThan(5000);
  });
});
