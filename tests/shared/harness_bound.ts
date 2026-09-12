// A harness bound is a hang guard, not a deadline, so it stretches with the machine instead of failing a slow
// but healthy run: parallel gates at load 60 to 180 pushed builds and folds past bounds set on an idle box.
//   TEST_TIME_SCALE=3        -> every bound x3 (an operator's knob; a finite number, never under 1)
//   unset, load 60, 12 cores -> x5, the one-minute load average per core, rounded up
//   unset, idle or CI runner -> x1, the bound as written
// The scaled value is validated here, the one place every bound passes through: bun reads 0, NaN, and Infinity
// as NO bound, and scripts/check/ssot/process_discipline.ts trusts the identifier it is handed.

import os from "node:os";

export function timeScale(): number {
  const raw = process.env.TEST_TIME_SCALE;
  if (raw === undefined) {
    return Math.max(1, Math.ceil(os.loadavg()[0] / os.availableParallelism()));
  }
  const scale = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(scale) || scale < 1) {
    throw new Error(
      `TEST_TIME_SCALE must be a finite number of at least 1, got ${JSON.stringify(raw)}`,
    );
  }
  return scale;
}

export function harnessBound(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(`harnessBound: a bound must be a positive finite number, got ${ms}`);
  }
  const scaled = Math.ceil(ms * timeScale());
  if (!Number.isFinite(scaled)) {
    throw new Error(
      `harnessBound: ${ms}ms x TEST_TIME_SCALE=${process.env.TEST_TIME_SCALE} overflows`,
    );
  }
  return scaled;
}
