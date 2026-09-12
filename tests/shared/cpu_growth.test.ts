import { describe, expect, test } from "bun:test";
import { growthRatio, LINEAR_GROWTH_MAX } from "./cpu_growth";
import { harnessBound } from "./harness_bound";

// The totals are checked so the JIT cannot delete the loops the ratio measures.
function keep(total: number): void {
  if (total < 0) throw new Error(`a sum of non-negative terms came out ${total}`);
}

describe("growthRatio", () => {
  test(
    "a linear pass reads under the bound, a quadratic one over it: the CONTROL for every linear-time claim",
    () => {
      const linear = growthRatio(
        (n) => new Uint8Array(n).fill(1),
        (bytes) => {
          let total = 0;
          for (const byte of bytes) total += byte;
          keep(total);
        },
      );
      const quadratic = growthRatio(
        (n) => n,
        (n) => {
          let total = 0;
          for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) total += (i ^ j) & 1;
          keep(total);
        },
      );
      expect({
        linear: linear < LINEAR_GROWTH_MAX,
        quadratic: quadratic > LINEAR_GROWTH_MAX,
      }).toEqual({
        linear: true,
        quadratic: true,
      });
    },
    harnessBound(60_000),
  );
});
