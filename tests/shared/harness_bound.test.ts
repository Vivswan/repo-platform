import { describe, expect, test } from "bun:test";
import os from "node:os";
import { harnessBound, timeScale } from "./harness_bound";

function withScale<T>(value: string | undefined, body: () => T): T {
  const previous = process.env.TEST_TIME_SCALE;
  if (value === undefined) delete process.env.TEST_TIME_SCALE;
  else process.env.TEST_TIME_SCALE = value;
  try {
    return body();
  } finally {
    if (previous === undefined) delete process.env.TEST_TIME_SCALE;
    else process.env.TEST_TIME_SCALE = previous;
  }
}

describe("harnessBound", () => {
  test("TEST_TIME_SCALE stretches every bound by that factor", () => {
    expect(withScale("3", () => harnessBound(15_000))).toBe(45_000);
    expect(withScale("2.5", () => harnessBound(200))).toBe(500);
    expect(withScale("1", () => harnessBound(180_000))).toBe(180_000);
  });

  test("unset, the scale is the load per core rounded up and never under 1", () => {
    const scale = withScale(undefined, timeScale);
    expect(scale).toBe(Math.max(1, Math.ceil(os.loadavg()[0] / os.availableParallelism())));
    expect(withScale(undefined, () => harnessBound(1_000))).toBeGreaterThanOrEqual(1_000);
  });

  test("FORCED RED: a scale that would shrink or disarm a hang guard is refused, never read as 0 or NaN", () => {
    for (const bad of ["0", "0.5", "-2", "abc", "", "Infinity", "NaN"]) {
      expect(() => withScale(bad, () => harnessBound(1_000))).toThrow(
        /TEST_TIME_SCALE must be a finite number of at least 1/,
      );
    }
  });

  test("FORCED RED: a bound bun would read as none is refused before and after scaling", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => withScale("1", () => harnessBound(bad))).toThrow(
        /a bound must be a positive finite number/,
      );
    }
    expect(() => withScale("1e308", () => harnessBound(250))).toThrow(/overflows/);
  });
});
