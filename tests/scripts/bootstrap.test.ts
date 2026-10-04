import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BUN_PIN_FILE,
  bunLockDirs,
  main,
  missingNodeModules,
  runtimeMismatch,
} from "../../scripts/bootstrap";
import { tempDirs } from "../shared/temp_dir";

const root = join(import.meta.dir, "../..");
const temp = tempDirs();

function plant(base: string, path: string, files: string[]): void {
  mkdirSync(join(base, path), { recursive: true });
  for (const file of files) writeFileSync(join(base, path, file), "");
}

describe("bunLockDirs", () => {
  // A dependency's own lockfile under node_modules would be installed as a workspace.
  test("a planted tree: no lock, a lock under node_modules, a nested lock", () => {
    const base = temp.dir("bootstrap-discovery-");
    plant(base, "actions/with-lock", ["bun.lock", "package.json"]);
    plant(base, "actions/with-lock/node_modules/dep", ["bun.lock"]);
    plant(base, "actions/without-lock", ["package.json"]);
    plant(base, "actions/parent/nested", ["bun.lock"]);

    const dirs = bunLockDirs(base);
    expect(dirs).toEqual(["actions/parent/nested", "actions/with-lock"]);
    expect(missingNodeModules(base, dirs)).toEqual(["actions/parent/nested"]);

    writeFileSync(join(base, "bun.lock"), "");
    expect(bunLockDirs(base)).toEqual([".", "actions/parent/nested", "actions/with-lock"]);
  });
});

// The flag comes from check:static itself: a flag the script no longer recognizes would turn the hook step back
// into an install, and nothing else would notice.
test("the check:static step refuses a package without node_modules, naming bun run bootstrap", () => {
  const scripts = (
    JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as {
      scripts: Record<string, string>;
    }
  ).scripts;
  const [bootstrapStep] = scripts["check:static"].split(" && ");
  expect(bootstrapStep).toStartWith("bun scripts/bootstrap.ts ");
  const argv = bootstrapStep.split(" ").slice(2);

  const base = temp.dir("bootstrap-check-");
  plant(base, "files/bun", []);
  writeFileSync(join(base, BUN_PIN_FILE), `${Bun.version}\n`);
  plant(base, "actions/pkg", ["bun.lock", "package.json"]);
  const stderr = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(main(argv, base)).toBe(1);
    expect(stderr.mock.calls).toEqual([
      ["bootstrap: node_modules missing in actions/pkg; run `bun run bootstrap`"],
    ]);
    plant(base, "actions/pkg/node_modules", []);
    expect(main(argv, base)).toBe(0);
    expect(stderr.mock.calls).toHaveLength(1);
  } finally {
    stderr.mockRestore();
  }
});

/** bun.lock is JSON with trailing commas, so they go before the parse. */
function lockedName(dir: string): string {
  const lock = JSON.parse(
    readFileSync(join(root, dir, "bun.lock"), "utf-8").replace(/,(\s*[}\]])/g, "$1"),
  ) as { workspaces: Record<string, { name: string }> };
  return lock.workspaces[""].name;
}

// A frozen install accepts a stale workspace name (bun 1.4.0), so the
// lockfile of a renamed action is judged here instead.
test("every bun.lock names the package.json beside it", () => {
  const dirs = bunLockDirs(root);
  const named = (name: (dir: string) => string) => dirs.map((dir) => ({ dir, name: name(dir) }));
  expect(named(lockedName)).toEqual(
    named(
      (dir) =>
        (JSON.parse(readFileSync(join(root, dir, "package.json"), "utf-8")) as { name: string })
          .name,
    ),
  );
});

describe("runtimeMismatch", () => {
  // The named incident: a green run under 1.3 on a commit CI's 1.4 failed.
  const MISMATCH = (local: string) =>
    `local bun ${local} is not at the pinned 1.4 (files/bun/.bun-version)`;
  test.each<[string, string, { verdict: string | null } | { throws: string }]>([
    ["1.4.0", "1.4.0\n", { verdict: null }],
    ["1.4.3", "1.4.0\n", { verdict: null }],
    ["1.3.14", "1.4.0\n", { verdict: MISMATCH("1.3.14") }],
    ["2.0.0", "1.4.0\n", { verdict: MISMATCH("2.0.0") }],
    // A prerelease or an unreadable pin throws instead of reading a prefix.
    ["1.4.0-canary.1", "1.4.0\n", { throws: "the local bun runtime" }],
    ["1.4.0", "", { throws: "files/bun/.bun-version" }],
  ])("local %s against the pin %s", (local, pinned, outcome) => {
    if ("throws" in outcome) {
      expect(() => runtimeMismatch(local, pinned)).toThrow(outcome.throws);
      return;
    }
    const found = runtimeMismatch(local, pinned);
    if (outcome.verdict === null) expect(found).toBeNull();
    else expect(found).toStartWith(outcome.verdict);
  });
});
