import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();
const MIGRATE = new URL("../../.github/scripts/sync/migrate.ts", import.meta.url).pathname;

/** A rung that appends its name and its argument to the checkout's log, reports two paths (one shared by every
 *  rung), speaks on stderr, then exits as told. */
const rung = (exit: number) =>
  [
    'import { appendFileSync } from "node:fs";',
    'import { basename, join } from "node:path";',
    "const name = basename(import.meta.path);",
    'appendFileSync(join(process.argv[2], "log"), `${name} ${process.argv[2]}\\n`);',
    "console.log(`shared.md\\n${name}.out`);",
    "console.error(`${name} err`);",
    `process.exit(${exit});`,
    "",
  ].join("\n");

function rungs(files: Record<string, string>): string {
  const dir = temp.dir("migrate-rungs-");
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

function run(dir: string, checkout: string, runnerTemp: string) {
  return boundedSpawnSync([process.execPath, MIGRATE, dir, checkout], {
    env: { ...process.env, RUNNER_TEMP: runnerTemp },
  });
}

describe("migrate.ts", () => {
  // The migrations contract of docs/sync.md: name order, the failing rung's own exit, stderr passed through (a
  // failed rung's line is what the delivered log tail carries), and stdout collected as the paths the delivery
  // stages: written only by a run every rung finished, deduplicated, NUL-separated.
  test("runs every rung in name order over the checkout; a failing rung ends the run with its exit, the rest do not run, and no list is written", () => {
    const dir = rungs({
      "0002-second.ts": rung(0),
      "0001-first.ts": rung(0),
      // Sorts before every rung: an unfiltered run would run it first and its line would show in stderr.
      "0000-README.md": "not a rung\n",
      "0003-fails.ts": rung(3),
      "0004-never.ts": rung(0),
    });
    const checkout = temp.dir("migrate-checkout-");
    const runnerTemp = temp.dir("migrate-temp-");
    const ran = ["0001-first.ts", "0002-second.ts", "0003-fails.ts"];
    expect(run(dir, checkout, runnerTemp)).toEqual({
      exitCode: 3,
      stdout: "",
      stderr: ran.map((n) => `${n} err\n`).join(""),
    });
    expect(readFileSync(join(checkout, "log"), "utf-8")).toBe(
      ran.map((n) => `${n} ${checkout}\n`).join(""),
    );
    expect(existsSync(join(runnerTemp, "migrated.txt"))).toBe(false);
  });

  test("a run every rung finished writes the union of the reported paths, each once", () => {
    const dir = rungs({ "0001-first.ts": rung(0), "0002-second.ts": rung(0) });
    const checkout = temp.dir("migrate-checkout-");
    const runnerTemp = temp.dir("migrate-temp-");
    expect(run(dir, checkout, runnerTemp).exitCode).toBe(0);
    expect(readFileSync(join(runnerTemp, "migrated.txt"), "utf-8")).toBe(
      ["shared.md", "0001-first.ts.out", "0002-second.ts.out"].map((path) => `${path}\0`).join(""),
    );
  });
});
