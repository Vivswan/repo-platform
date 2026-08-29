import { describe, expect, test } from "bun:test";

import { boundedSpawnSync, SPAWN_TIMEOUT_MS } from "./bounded_spawn";

// Fixtures run through process.execPath, never a PATH lookup: several
// arms pass hermetic envs with no PATH at all.
const bunExe = process.execPath;

// Every hanging fixture self-exits after BACKSTOP_MS: if the wrapper's
// bound is ever broken, the arm fails its assertion after ~10s instead
// of wedging the run - the forced-red direction stays bounded too.
const BACKSTOP_MS = 10_000;

describe("boundedSpawnSync", () => {
  test("a healthy child returns its own exit code and both streams", () => {
    const ok = boundedSpawnSync([bunExe, "-e", "console.log('out'); console.error('err');"]);
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toBe("out\n");
    expect(ok.stderr).toBe("err\n");
  });

  test("a nonzero exit is a result, not a throw", () => {
    const bad = boundedSpawnSync([bunExe, "-e", "process.exit(3)"]);
    expect(bad.exitCode).toBe(3);
  });

  test("FORCED RED: a hung child hits the bound and reads as failed-to-look", () => {
    expect(() =>
      boundedSpawnSync([bunExe, "-e", `await Bun.sleep(${BACKSTOP_MS})`], { timeoutMs: 250 }),
    ).toThrow(/exceeded the 250ms harness bound.*failed to look/s);
  });

  test("FORCED RED: a clean exit behind a pipe-holding descendant still throws, never exit 0", () => {
    // The pipe-EOF arm: the child exits 0 but a descendant inherits the
    // pipes, so only the deadline unblocks the caller - and that expiry
    // must never surface as the child's clean exit code.
    const fixture = `Bun.spawn(["sleep", "${BACKSTOP_MS / 1000}"], { stdout: "inherit", stderr: "inherit" }); process.exit(0);`;
    expect(() => boundedSpawnSync([bunExe, "-e", fixture], { timeoutMs: 250 })).toThrow(
      /exceeded the 250ms harness bound/,
    );
  });

  test("a signal death is failed-to-look, naming the signal", () => {
    expect(() => boundedSpawnSync([bunExe, "-e", "process.kill(process.pid, 'SIGKILL')"])).toThrow(
      /died on signal SIGKILL/,
    );
  });

  test("a zero, negative, infinite, or NaN bound is refused - bun reads those as NO bound", () => {
    for (const bad of [0, -1, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(() => boundedSpawnSync(["true"], { timeoutMs: bad })).toThrow(
        /timeoutMs must be a positive finite number/,
      );
    }
  });

  test("the default bound is itself a positive finite number", () => {
    expect(Number.isFinite(SPAWN_TIMEOUT_MS) && SPAWN_TIMEOUT_MS > 0).toBe(true);
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
