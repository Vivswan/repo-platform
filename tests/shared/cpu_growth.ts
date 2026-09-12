// A wall-clock bound cannot prove "linear time": under load a 50 ms fold measured 600 ms and failed a 300 ms
// bound. CPU time barely moves with load, and the growth from n to 4n separates the orders with margin.
//   linear    -> about 4 (fixed costs pull it lower)
//   quadratic -> about 16
// FLOOR_MS keeps the small sample above timer and GC noise on any machine; reaching it by doubling from a small
// seed keeps a quadratic's red run short.

export const LINEAR_GROWTH_MAX = 8;
const GROWTH = 4;
const FLOOR_MS = 10;
const REPS = 3;
const SEED_N = 1_000;
const MAX_DOUBLINGS = 16;

function cpuMs(run: () => void): number {
  let best = Number.POSITIVE_INFINITY;
  for (let rep = 0; rep < REPS; rep++) {
    const start = process.cpuUsage();
    run();
    const used = process.cpuUsage(start);
    best = Math.min(best, (used.user + used.system) / 1000);
  }
  return best;
}

export function growthRatio<T>(input: (n: number) => T, run: (built: T) => void): number {
  const measure = (n: number) => {
    const built = input(n);
    return cpuMs(() => run(built));
  };
  let n = SEED_N;
  let small = measure(n);
  for (let doublings = 0; small < FLOOR_MS; doublings++) {
    if (doublings === MAX_DOUBLINGS) {
      throw new Error(
        `growthRatio: ${small.toFixed(3)} ms of CPU at n=${n} is under the ${FLOOR_MS} ms floor`,
      );
    }
    n *= 2;
    small = measure(n);
  }
  return measure(GROWTH * n) / small;
}
