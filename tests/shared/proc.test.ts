// Pins the additive timeout contract on capture and mustCapture: without
// timeoutMs behavior is byte-identical for existing callers (capture's
// result carries no timedOut key); with it, a stalled child is killed at
// the deadline - capture reports timedOut, mustCapture names the deadline
// and exits nonzero.

import { describe, expect, test } from "bun:test";
import { capture, mustCapture } from "../../.github/scripts/shared/proc";

describe("capture timeoutMs", () => {
  test("absent: no timedOut key, normal exit", () => {
    const result = capture(["true"]);
    expect(result.exitCode).toBe(0);
    expect("timedOut" in result).toBe(false);
  });

  test("an expiring deadline kills the child and reports timedOut", () => {
    const start = Date.now();
    const result = capture(["sleep", "5"], { timeoutMs: 200 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(Date.now() - start).toBeLessThan(3000);
  });

  test("a deadline that is not hit: timedOut false, output intact", () => {
    const result = capture(["echo", "ok"], { timeoutMs: 5000 });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ok\n");
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
