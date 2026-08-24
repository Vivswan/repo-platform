// Pins the additive timeout contract on capture: without timeoutMs the
// result carries no timedOut key and behavior is byte-identical for
// existing callers; with it, a stalled child is killed at the deadline
// and reported timedOut.

import { describe, expect, test } from "bun:test";
import { capture } from "../../.github/scripts/shared/proc";

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
