import { describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dueMigrations, migrationRange, parse } from "./run.ts";

const RUNNER = `${import.meta.dir}/run.ts`;

// A staging-channel _commit as dunamai renders it (describe/sha, no
// templates/vX.Y.Z shape).
const STAGING_REF = "0.0.0.post7+9288246";

const SCRIPTS = ["0.2.4.ts", "0.9.0.ts", "1.4.0.ts", "run.ts", "README.md", "notes.txt"];

// A stand-in migration script: proves it ran (and WHERE it ran) by writing
// a marker file into its cwd, which the contract says is the downstream
// repository.
function markerScript(label: string): string {
  return `import { writeFileSync } from "node:fs";\nwriteFileSync("ran-${label}.txt", "ok");\n`;
}

// Spawns a copy of run.ts from a temp directory seeded with the given
// migration scripts, with cwd set to a fresh temp dir standing in for the
// downstream repo. Never the real runner in the real checkout: run.ts
// readdirs its own directory and executes what it finds against cwd, so
// the first real migration script would otherwise run against this
// repository during tests.
function runRunner(options: {
  scripts?: string[];
  args?: string[];
  env?: Record<string, string>;
}): { stdout: string; exitCode: number; cwd: string } {
  const runnerDir = mkdtempSync(join(tmpdir(), "migrations-runner-"));
  copyFileSync(RUNNER, join(runnerDir, "run.ts"));
  for (const name of options.scripts ?? []) {
    writeFileSync(join(runnerDir, name), markerScript(name.slice(0, -".ts".length)));
  }
  const cwd = mkdtempSync(join(tmpdir(), "migrations-repo-"));
  const result = Bun.spawnSync(
    [process.execPath, join(runnerDir, "run.ts"), ...(options.args ?? [])],
    { cwd, env: { ...process.env, VERSION_FROM: "", VERSION_TO: "", ...options.env } },
  );
  return { stdout: result.stdout.toString(), exitCode: result.exitCode, cwd };
}

describe("parse", () => {
  test("strips the templates/v build-tag prefix", () => {
    expect(parse("templates/v0.2.4")).toEqual([0, 2, 4]);
  });

  test("accepts bare and v-prefixed semver", () => {
    expect(parse("1.2.3")).toEqual([1, 2, 3]);
    expect(parse("v1.2.3")).toEqual([1, 2, 3]);
  });

  test("rejects staging describe/sha strings", () => {
    expect(parse(STAGING_REF)).toBeNull();
    expect(parse("9288246")).toBeNull();
    expect(parse("")).toBeNull();
  });
});

describe("dueMigrations", () => {
  test("selects the half-open [from, to) range in ascending order", () => {
    const due = dueMigrations([0, 2, 4], [1, 4, 0], SCRIPTS);
    expect(due.map(([, name]) => name)).toEqual(["0.2.4.ts", "0.9.0.ts"]);
  });

  test("ignores run.ts and non-version files", () => {
    const due = dueMigrations([0, 0, 0], [99, 0, 0], SCRIPTS);
    expect(due.map(([, name]) => name)).toEqual(["0.2.4.ts", "0.9.0.ts", "1.4.0.ts"]);
  });
});

describe("migrationRange", () => {
  test("parseable both: the usual [from, to) range, no channel switch", () => {
    const range = migrationRange("templates/v0.2.4", "templates/v1.4.0");
    expect(range).toEqual({ vfrom: [0, 2, 4], vto: [1, 4, 0], channelSwitch: false });
  });

  test("parseable both: nothing to cross when to <= from", () => {
    expect(migrationRange("templates/v1.4.0", "templates/v1.4.0")).toBeNull();
    expect(migrationRange("templates/v1.4.0", "templates/v0.9.0")).toBeNull();
  });

  test("unparseable FROM + parseable TO: channel switch runs everything below TO", () => {
    const range = migrationRange(STAGING_REF, "templates/v1.4.0");
    expect(range).toEqual({ vfrom: [0, 0, 0], vto: [1, 4, 0], channelSwitch: true });
    const due = dueMigrations([0, 0, 0], [1, 4, 0], SCRIPTS);
    expect(due.map(([, name]) => name)).toEqual(["0.2.4.ts", "0.9.0.ts"]);
  });

  test("unparseable TO: a staging-channel update never migrates", () => {
    expect(migrationRange("templates/v0.2.4", STAGING_REF)).toBeNull();
    expect(migrationRange(STAGING_REF, STAGING_REF)).toBeNull();
  });
});

describe("run.ts end to end", () => {
  test("parseable both with no scripts: prints the none-due line", () => {
    const { stdout, exitCode } = runRunner({ args: ["templates/v0.2.4", "templates/v1.4.0"] });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("migrations: none due for templates/v0.2.4 -> templates/v1.4.0");
    expect(stdout).not.toContain("staging channel");
  });

  test("parseable both: runs exactly the due scripts, in the downstream cwd", () => {
    const { stdout, exitCode, cwd } = runRunner({
      scripts: ["0.2.4.ts", "1.4.0.ts"],
      args: ["templates/v0.2.4", "templates/v1.0.0"],
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("migrating from 0.2.4: 0.2.4.ts");
    expect(stdout).not.toContain("staging channel");
    expect(existsSync(join(cwd, "ran-0.2.4.txt"))).toBe(true);
    expect(existsSync(join(cwd, "ran-1.4.0.txt"))).toBe(false);
  });

  test("unparseable FROM + parseable TO: loud banner and every script below TO runs", () => {
    const { stdout, exitCode, cwd } = runRunner({
      scripts: ["0.2.4.ts", "0.9.0.ts"],
      args: [STAGING_REF, "templates/v1.4.0"],
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("leaving the staging channel");
    expect(stdout).toContain("ALL migrations up to templates/v1.4.0");
    expect(existsSync(join(cwd, "ran-0.2.4.txt"))).toBe(true);
    expect(existsSync(join(cwd, "ran-0.9.0.txt"))).toBe(true);
  });

  test("unparseable FROM with nothing due: none-due line, no banner", () => {
    const { stdout, exitCode } = runRunner({ args: [STAGING_REF, "templates/v1.4.0"] });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("migrations: none due for");
    expect(stdout).not.toContain("staging channel");
  });

  test("unparseable TO: unchanged no-op, nothing executes", () => {
    const { stdout, exitCode, cwd } = runRunner({
      scripts: ["0.2.4.ts"],
      args: ["templates/v0.2.4", STAGING_REF],
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("migrations: nothing to do");
    expect(existsSync(join(cwd, "ran-0.2.4.txt"))).toBe(false);
  });

  test("copier-style invocation: VERSION_FROM/VERSION_TO env vars, no positional args", () => {
    const { stdout, exitCode, cwd } = runRunner({
      scripts: ["0.2.4.ts"],
      env: { VERSION_FROM: "templates/v0.2.4", VERSION_TO: "templates/v1.4.0" },
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("migrating from 0.2.4: 0.2.4.ts");
    expect(existsSync(join(cwd, "ran-0.2.4.txt"))).toBe(true);
  });
});
