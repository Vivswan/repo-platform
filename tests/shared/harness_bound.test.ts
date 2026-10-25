import { describe, expect, test } from "bun:test";
import { harnessBound } from "./harness_bound";

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
  test("unset, the load-derived scale never shrinks a bound", () => {
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
