// The fail-closed timeout contract on the sync scripts' git probe owners:
// preserve_repo_owned's git() and retired_cleanup's licensePresentAtHead
// feed consumers that read `exitCode === 0` as a benign answer (absent,
// skip the restore, stand the flip guard down), so a probe whose deadline
// expires must ABORT the step loudly instead of returning - a hung git is
// a broken step, never an answer. The tests drive the REAL wiring: a
// hanging git stub on PATH plus the helpers' test-only timeoutMs seam
// (production callers pass nothing and get proc.ts's default hang bound,
// which no test can wait out). The abort legs run in driver subprocesses
// because the guard exits the process by design.
//
// The static imports below are load-bearing: both scripts keep their main
// bodies behind import.meta.main, and importing them here fails loudly if
// that guard is ever removed.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capture } from "../../.github/scripts/shared/proc.ts";
import {
  deletedTrackedPaths,
  fleetLicenseAt,
  git,
  showFleetLicense,
} from "../../.github/scripts/sync/preserve_repo_owned.ts";
import { licensePresentAtHead } from "../../.github/scripts/sync/retired_cleanup.ts";

const preserveScript = join(import.meta.dir, "../../.github/scripts/sync/preserve_repo_owned.ts");
const cleanupScript = join(import.meta.dir, "../../.github/scripts/sync/retired_cleanup.ts");

/** Small enough to expire well inside the test budget; the stub sleeps
 * far longer, so expiry is the only way past it. */
const PROBE_TIMEOUT_MS = 250;

// Hook-driven runs (husky pre-commit) export GIT_DIR/GIT_INDEX_FILE, which
// would redirect this file's in-process git calls at the exporting repo.
// The helpers under test (git(), licensePresentAtHead) take no env
// parameter, so this ambient scrub is their one channel - and it reaches
// their children only because proc.ts hands every spawn live process.env
// (bun's own default is a process-start snapshot that kept this scrub
// silently inert; the poison-GIT_DIR test below pins that it bites now).
// This file's own fixture spawns take the explicit overlay instead.
const savedGitEnv: Record<string, string> = {};
beforeAll(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("GIT_")) {
      savedGitEnv[key] = process.env[key] as string;
      delete process.env[key];
    }
  }
});
afterAll(() => {
  for (const [key, value] of Object.entries(savedGitEnv)) process.env[key] = value;
});

/** Explicit env overlay deleting every GIT_* variable for a capture()
 * child, handed at the call site (the repo's adopted style for tests
 * that scrub). capture() MERGES options.env over live process.env, so
 * the scrub must arrive as undefined-VALUED entries - bun then omits
 * the keys - never as a filtered env copy, which would merge over the
 * live base without deleting anything. */
function gitFreeOverlay(): Record<string, string | undefined> {
  const overlay: Record<string, string | undefined> = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("GIT_")) overlay[key] = undefined;
  }
  return overlay;
}

/** A PATH prefix directory whose `git` hangs until killed. The sleeper is
 * exec'd with detached fds so a survivor can never wedge the pipe past
 * the deadline (the stall-stub lore in tests/shared/proc.test.ts). */
function hangingGitDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hanging-git-"));
  writeFileSync(
    join(dir, "git"),
    "#!/usr/bin/env bash\nexec sleep 30 </dev/null >/dev/null 2>&1\n",
    { mode: 0o755 },
  );
  return dir;
}

/** A committed scratch repository with the given flat files. */
function initRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "fail-closed-repo-"));
  for (const [rel, content] of Object.entries(files)) {
    writeFileSync(join(dir, rel), content);
  }
  const run = (...args: string[]) => {
    const proc = capture(["git", "-C", dir, ...args], { env: gitFreeOverlay() });
    if (proc.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${proc.stderr}`);
  };
  run("init", "-b", "main");
  run("config", "user.name", "test");
  run("config", "user.email", "test@example.com");
  run("add", "-A");
  run("commit", "-qm", "fixture");
  return dir;
}

/** Run a one-shot driver that imports a script's exported helper; the
 * abort under test exits the DRIVER process, never this one. Through
 * capture(): the same merge semantics the old raw spawn spelled by hand
 * ({ ...process.env, ...env }), and the spawn stays deadline-bounded
 * with SIGKILL - generous next to PROBE_TIMEOUT_MS, so a driver that
 * outlives it is itself a hang regression. */
function runDriver(
  source: string,
  env: Record<string, string>,
): { exitCode: number; stdout: string } {
  const driver = join(mkdtempSync(join(tmpdir(), "fail-closed-driver-")), "driver.ts");
  writeFileSync(driver, source);
  const proc = capture([process.execPath, driver], { env, timeoutMs: 10_000 });
  return { exitCode: proc.exitCode, stdout: proc.stdout };
}

describe("probe timeouts fail closed (never read as absent)", () => {
  test("preserve_repo_owned's git() aborts loudly when the probe hangs", () => {
    const result = runDriver(
      [
        `import { git } from ${JSON.stringify(preserveScript)};`,
        `const probe = git(["cat-file", "-e", "HEAD:LICENSE"], ${PROBE_TIMEOUT_MS});`,
        `console.log("PROBE-RETURNED " + probe.exitCode);`,
        "",
      ].join("\n"),
      {
        PATH: `${hangingGitDir()}:${process.env.PATH}`,
        TARGET_DIR: initRepo({ "README.md": "readme\n" }),
        TARGET_DISPLAY: "",
        TARGET: "",
      },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("::error::");
    expect(result.stdout).toContain(
      "git cat-file timed out; aborting rather than reading it as an answer",
    );
    // The old bug: the probe returning at all - its nonzero exit then read
    // as "absent" and the restore silently skipped.
    expect(result.stdout).not.toContain("PROBE-RETURNED");
  });

  test("retired_cleanup's licensePresentAtHead aborts loudly when the probe hangs", () => {
    const result = runDriver(
      [
        `import { licensePresentAtHead } from ${JSON.stringify(cleanupScript)};`,
        `const present = licensePresentAtHead(${JSON.stringify(
          initRepo({ "README.md": "readme\n" }),
        )}, "LICENSE", ${PROBE_TIMEOUT_MS});`,
        `console.log("PROBE-RETURNED " + present);`,
        "",
      ].join("\n"),
      { PATH: `${hangingGitDir()}:${process.env.PATH}` },
    );
    expect(result.exitCode).toBe(1); // fail()'s contract
    expect(result.stdout).toContain("::error::git cat-file timed out probing HEAD:LICENSE");
    // The old bug: false ("license absent") standing the flip guard down.
    expect(result.stdout).not.toContain("PROBE-RETURNED");
  });

  test("preserve_repo_owned's fleetLicenseAt aborts loudly when the probe hangs", () => {
    const result = runDriver(
      [
        `import { fleetLicenseAt } from ${JSON.stringify(preserveScript)};`,
        `const present = fleetLicenseAt("HEAD", ${PROBE_TIMEOUT_MS});`,
        `console.log("PROBE-RETURNED " + present);`,
        "",
      ].join("\n"),
      { PATH: `${hangingGitDir()}:${process.env.PATH}`, TARGET_DISPLAY: "", TARGET: "" },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("::error::");
    expect(result.stdout).toContain("git cat-file timed out probing the fleet license at HEAD");
    // The old bug: false ("no fleet license at the ref") silently skipping
    // the mandatory re-seed.
    expect(result.stdout).not.toContain("PROBE-RETURNED");
  });

  test("preserve_repo_owned's showFleetLicense (the raw latin1 spawn) aborts loudly on expiry", () => {
    // The one guard on a DIFFERENT predicate: the raw Bun.spawnSync reads
    // exitedDueToTimeout, not capture()'s timedOut flag, so the git()
    // legs above cannot stand in for it.
    const result = runDriver(
      [
        `import { showFleetLicense } from ${JSON.stringify(preserveScript)};`,
        `const bytes = showFleetLicense("HEAD", ${PROBE_TIMEOUT_MS});`,
        `console.log("PROBE-RETURNED " + bytes.length);`,
        "",
      ].join("\n"),
      { PATH: `${hangingGitDir()}:${process.env.PATH}`, TARGET_DISPLAY: "", TARGET: "" },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("::error::");
    expect(result.stdout).toContain("reading the fleet license from HEAD timed out");
    expect(result.stdout).not.toContain("PROBE-RETURNED");
  });

  test("preserve_repo_owned's deletedTrackedPaths (the raw bytes spawn) aborts loudly on expiry", () => {
    // Another guard on the raw exitedDueToTimeout predicate: the deletion
    // axis reads its paths as BYTES (a capture() decode would fold a
    // non-UTF-8 tracked name onto U+FFFD), so the git() legs above cannot
    // stand in for it. A timeout returning null would hold the PR too, but
    // as a generic unverifiable scan on a healthy-looking run - a hung git
    // is a broken step, never an answer.
    const result = runDriver(
      [
        `import { deletedTrackedPaths } from ${JSON.stringify(preserveScript)};`,
        `const deleted = deletedTrackedPaths(${PROBE_TIMEOUT_MS});`,
        `console.log("PROBE-RETURNED " + (deleted === null ? "null" : deleted.paths.length));`,
        "",
      ].join("\n"),
      {
        PATH: `${hangingGitDir()}:${process.env.PATH}`,
        TARGET_DIR: initRepo({ "README.md": "readme\n" }),
        TARGET_DISPLAY: "",
        TARGET: "",
      },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("::error::");
    expect(result.stdout).toContain(
      "git diff timed out; aborting rather than reading it as an answer",
    );
    expect(result.stdout).not.toContain("PROBE-RETURNED");
  });

  test("positive control: real probes answer both ways without aborting", () => {
    const withLicense = initRepo({ LICENSE: "license\n", "README.md": "readme\n" });
    const without = initRepo({ "README.md": "readme\n" });
    expect(licensePresentAtHead(withLicense, "LICENSE")).toBe(true);
    expect(licensePresentAtHead(without, "LICENSE")).toBe(false);
  });

  test("near-miss: without the owner's guard a timeout reads exactly like absence", () => {
    // The pre-fix consumers read `exitCode === 0` and nothing else - the
    // reading a neutered guard falls back to. Same stub, same bound:
    const hung = capture(["git", "cat-file", "-e", "HEAD:LICENSE"], {
      timeoutMs: PROBE_TIMEOUT_MS,
      env: { PATH: `${hangingGitDir()}:${process.env.PATH}` },
    });
    const absent = capture([
      "git",
      "-C",
      initRepo({ "README.md": "readme\n" }),
      "cat-file",
      "-e",
      "HEAD:LICENSE",
    ]);
    // On the `=== 0` axis the two are indistinguishable...
    expect(hung.exitCode === 0).toBe(false);
    expect(absent.exitCode === 0).toBe(false);
    // ...and only the timedOut flag discriminates - which is exactly what
    // the guards consume, and what the abort legs above pin.
    expect(hung.timedOut).toBe(true);
    expect(absent.timedOut).toBe(false);
  });

  test("a poison GIT_DIR genuinely reaches capture's child, and both scrub shapes strip it", () => {
    // The scrubs in this file ride channels bun's default snapshot env
    // silently severed: the beforeAll deletion (ambient, for the helpers
    // that take no env parameter) and initRepo's undefined-valued
    // overlay. CONTROL first: a poison GIT_DIR set now must reach an
    // unscrubbed child and break it - without that arm, a snapshot
    // regression would let both scrubs go quietly inert again.
    const saved = process.env.GIT_DIR;
    process.env.GIT_DIR = join(tmpdir(), "fail-closed-poison-not-a-git-dir");
    try {
      expect(capture(["git", "rev-parse", "--git-dir"], { timeoutMs: 2000 }).exitCode).not.toBe(0);
      // Overlay shape: the undefined value deletes the poison for the child.
      expect(
        capture(["git", "rev-parse", "--git-dir"], { env: gitFreeOverlay(), timeoutMs: 2000 })
          .exitCode,
      ).toBe(0);
      // Ambient shape: `delete process.env[key]` - exactly beforeAll's
      // scrub - must clear the child through the same live-env channel.
      delete process.env.GIT_DIR;
      expect(capture(["git", "rev-parse", "--git-dir"], { timeoutMs: 2000 }).exitCode).toBe(0);
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved;
    }
  });

  test("the scripts run their probes through the guarded owners (wiring pin)", () => {
    // The behavioral legs test the exported helpers; these pins keep the
    // scripts' probe paths ON those helpers, so a revert to a bare capture
    // (guard bypassed) fails red here instead of passing unexamined.
    const preserve = readFileSync(preserveScript, "utf-8");
    expect(preserve).toMatch(
      /return git\(\["cat-file", "-e", `HEAD:\$\{path\}`\]\)\.exitCode === 0/,
    );
    expect(preserve).toMatch(/fleetLicenseAt\(targetRef\)/);
    expect(preserve).toMatch(/showFleetLicense\(targetRef\)/);
    expect(preserve).toMatch(/const deleted = deletedTrackedPaths\(\);/);
    const cleanup = readFileSync(cleanupScript, "utf-8");
    expect(cleanup).toMatch(/licensePresentAtHead\(targetDir, name\)/);
  });

  test("importing the scripts leaves their main bodies unrun (import.meta.main guard)", () => {
    // The static imports at the top already happened; the exported helpers
    // being callable here means the modules loaded as libraries. If either
    // guard is removed, the import itself runs a whole sync step inside
    // the test process and this file fails long before this line.
    expect(typeof git).toBe("function");
    expect(typeof fleetLicenseAt).toBe("function");
    expect(typeof showFleetLicense).toBe("function");
    expect(typeof deletedTrackedPaths).toBe("function");
    expect(typeof licensePresentAtHead).toBe("function");
  });
});
