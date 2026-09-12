import { describe, expect, test } from "bun:test";

import { boundedSpawnSync } from "./bounded_spawn";
import { harnessBound } from "./harness_bound";

// Fixtures run through process.execPath, never a PATH lookup: several
// arms pass hermetic envs with no PATH at all.
const bunExe = process.execPath;

// Every hanging fixture self-exits after BACKSTOP_MS (10 s, stretched like the
// bounds it outlasts): if the wrapper's bound is ever broken, the arm fails its
// assertion then instead of wedging the run - the forced-red direction stays bounded too.
const BACKSTOP_MS = harnessBound(10_000);

describe("boundedSpawnSync", () => {
  test("a healthy child under the default bound returns its own exit code and both streams", () => {
    // No timeoutMs: runs under SPAWN_TIMEOUT_MS, so the wrapper's bound
    // guard below would throw here on a non-positive or non-finite default.
    expect(boundedSpawnSync([bunExe, "-e", "console.log('out'); console.error('err');"])).toEqual({
      exitCode: 0,
      stdout: "out\n",
      stderr: "err\n",
    });
  });

  test("a nonzero exit is a result, not a throw", () => {
    const bad = boundedSpawnSync([bunExe, "-e", "process.exit(3)"]);
    expect(bad.exitCode).toBe(3);
  });

  // The two hung fixtures wait out the scaled bound, so their own bun-test timeouts scale with it.
  test(
    "FORCED RED: a hung child hits the bound and reads as failed-to-look",
    () => {
      expect(() =>
        boundedSpawnSync([bunExe, "-e", `await Bun.sleep(${BACKSTOP_MS})`], { timeoutMs: 250 }),
      ).toThrow(/exceeded the 250ms harness bound.*failed to look/s);
    },
    harnessBound(5_000),
  );

  test(
    "FORCED RED: a clean exit behind a pipe-holding descendant still throws, never exit 0",
    () => {
      const fixture = `Bun.spawn(["sleep", "${BACKSTOP_MS / 1000}"], { stdout: "inherit", stderr: "inherit" }); process.exit(0);`;
      expect(() => boundedSpawnSync([bunExe, "-e", fixture], { timeoutMs: 250 })).toThrow(
        /exceeded the 250ms harness bound/,
      );
    },
    harnessBound(5_000),
  );

  test("a signal death is failed-to-look, naming the signal", () => {
    expect(() => boundedSpawnSync([bunExe, "-e", "process.kill(process.pid, 'SIGKILL')"])).toThrow(
      /died on signal SIGKILL/,
    );
  });

  test("TEST_TIME_SCALE stretches the bound: a child that overruns the written bound survives under x8, and the failure names both", () => {
    const previous = process.env.TEST_TIME_SCALE;
    process.env.TEST_TIME_SCALE = "8";
    try {
      const slow = boundedSpawnSync([bunExe, "-e", "await Bun.sleep(400); console.log('late')"], {
        timeoutMs: 250,
      });
      expect(slow).toEqual({ exitCode: 0, stdout: "late\n", stderr: "" });
      expect(() =>
        boundedSpawnSync([bunExe, "-e", `await Bun.sleep(${BACKSTOP_MS})`], { timeoutMs: 250 }),
      ).toThrow(/exceeded the 250ms harness bound \(stretched to 2000ms for load\)/);
    } finally {
      if (previous === undefined) delete process.env.TEST_TIME_SCALE;
      else process.env.TEST_TIME_SCALE = previous;
    }
  });

  test("a zero, negative, infinite, or NaN bound is refused - bun reads those as NO bound", () => {
    for (const bad of [0, -1, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(() => boundedSpawnSync(["true"], { timeoutMs: bad })).toThrow(
        /a bound must be a positive finite number/,
      );
    }
  });

  test("stdin bytes pass through", () => {
    const r = boundedSpawnSync(["cat"], { stdin: Buffer.from("fed via stdin") });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("fed via stdin");
  });

  test("POISON CONTROL: an explicit env passes verbatim - no process.env spread", () => {
    process.env.BOUNDED_SPAWN_CANARY = "leaked";
    try {
      const r = boundedSpawnSync(
        [bunExe, "-e", "console.log(String(process.env.BOUNDED_SPAWN_CANARY), process.env.OWN)"],
        { env: { OWN: "own-value" } },
      );
      expect(r.stdout).toBe("undefined own-value\n");
    } finally {
      delete process.env.BOUNDED_SPAWN_CANARY;
    }
  });
});
