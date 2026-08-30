#!/usr/bin/env bun
// Weekly arming proof for the guard registry (audit-guards.yml). Binding
// (scripts/check_guard_binding.ts) proves each guard and its forcing
// test EXIST; this proves the pair is ARMED: per entry, in a scratch
// clone - never the checkout - apply the mutation, run the forcing test
// file, require the NAMED test red (per-test junit verdict; a different
// test failing is a broken scan, not proof), restore, require it green
// (the control pinning the red on the mutation). A guard whose unarming
// no test notices is decorative; the audit fails and the workflow's
// report job files the tracking issue.
//
// The audit judges the clone's HEAD alone: the registry is imported FROM
// THE CLONE, so a dirty checkout's registry can never audit HEAD's guard
// files (the two-revision mix a local run would otherwise produce).
//
// Cleanup: every spawn is bounded and SIGKILLed on expiry (proc.ts's
// capture), each recorded pid is verified dead, a pgrep sweep on the
// scratch path kills stragglers, and the scratch tree is removed in a
// finally. Residual: grandchildren whose argv never carries the scratch
// path are outside the sweep's sight - bounding those is the forcing
// tests' own harness discipline (tests/shared/bounded_spawn.ts).
//
// Usage: bun .github/scripts/audit-guards/arm_audit.ts

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { applyMutation, type GuardEntry } from "../../../scripts/guard_registry.ts";
import { error } from "../shared/gha.ts";
import { capture } from "../shared/proc.ts";

const REPO_ROOT = resolve(import.meta.dir, "../../..");

/** Hang bound per forcing-test run: the slowest seed (bounded_spawn's
 *  forced-red arms sleep out their ~10s backstops) finishes well under
 *  it, and a wedged run dies loudly instead of eating the job timeout. */
export const RUN_TIMEOUT_MS = 180_000;

export interface JunitCase {
  name: string;
  verdict: "pass" | "fail" | "skip";
}

function unescapeXml(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

/** Every testcase in bun test's junit report, multiplicity preserved -
 *  the only view that names WHICH test failed (the console reporter
 *  prints no pass lines when piped). A testcase without a name is
 *  malformed and throws: the caller reads that as a broken scan, never
 *  as a verdict. */
export function parseJunit(xml: string): JunitCase[] {
  const cases: JunitCase[] = [];
  const testcase = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const match of xml.matchAll(testcase)) {
    const nameAttr = /\bname="([^"]*)"/.exec(match[1]);
    if (!nameAttr) throw new Error("junit report carries a testcase without a name attribute");
    const name = unescapeXml(nameAttr[1]);
    const body = match[2] ?? "";
    const verdict =
      body.includes("<failure") || body.includes("<error")
        ? "fail"
        : body.includes("<skipped")
          ? "skip"
          : "pass";
    cases.push({ name, verdict });
  }
  return cases;
}

/** The one verdict for the named test, or why there is none: "absent"
 *  (it never ran) and "ambiguous" (several same-named testcases, whose
 *  verdicts could contradict each other) are distinct non-verdicts, so a
 *  duplicated name can never launder a pass into a fail or vice versa. */
export function namedVerdict(
  cases: JunitCase[],
  name: string,
): "pass" | "fail" | "skip" | "absent" | "ambiguous" {
  const matches = cases.filter((testcase) => testcase.name === name);
  if (matches.length === 0) return "absent";
  if (matches.length > 1) return "ambiguous";
  return matches[0].verdict;
}

/** True while `pid` still exists (EPERM means alive but not ours). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface ForcingRun {
  exitCode: number;
  timedOut: boolean;
  pid: number;
  /** null when no parseable junit report was produced (a crashed or
   *  wedged run) - a broken scan, never a verdict. */
  cases: JunitCase[] | null;
}

/** One bounded run of a single forcing-test file inside `root`, with the
 *  per-test verdicts read from a junit report written OUTSIDE the tree. */
export function runForcingTest(options: {
  root: string;
  testFile: string;
  junitPath: string;
  timeoutMs: number;
}): ForcingRun {
  rmSync(options.junitPath, { force: true });
  const run = capture(
    [
      process.execPath,
      "test",
      options.testFile,
      "--reporter=junit",
      `--reporter-outfile=${options.junitPath}`,
    ],
    { cwd: options.root, timeoutMs: options.timeoutMs },
  );
  let cases: JunitCase[] | null = null;
  try {
    cases = parseJunit(readFileSync(options.junitPath, "utf-8"));
  } catch {
    cases = null;
  }
  return { exitCode: run.exitCode, timedOut: run.timedOut, pid: run.pid, cases };
}

export interface EntryAudit {
  armed: boolean;
  problems: string[];
  /** Every child pid this entry spawned, for the caller's liveness check. */
  pids: number[];
}

/** The mutated run's verdict: null means the red proof stands. Pure over
 *  the run result so the contradictory shapes (a named fail beside exit
 *  0, a skip, a duplicate name) are table-testable without child runs. */
export function judgeRed(red: ForcingRun, entry: GuardEntry, mutation: string): string | null {
  if (red.timedOut) {
    return `failed to look: the mutated run of ${entry.testFile} exceeded its bound - not a verdict`;
  }
  if (red.cases === null) {
    return `scan broken: the mutated run of ${entry.testFile} left no parseable junit report (exit ${red.exitCode})`;
  }
  const verdict = namedVerdict(red.cases, entry.testName);
  if (verdict === "pass") {
    return `guard is DECORATIVE: unarming it (${mutation} in ${entry.guardFile}) left "${entry.testName}" GREEN - the attack it claims to stop was never staged against it`;
  }
  if (verdict === "skip") {
    return `scan broken: "${entry.testName}" is SKIPPED under the mutation - a skipped forcing test proves nothing`;
  }
  if (verdict === "absent") {
    return `scan broken: "${entry.testName}" never ran in the mutated ${entry.testFile} (exit ${red.exitCode}; a different test failing is not proof)`;
  }
  if (verdict === "ambiguous") {
    return `scan broken: several testcases in ${entry.testFile} report the name "${entry.testName}" - no single verdict exists`;
  }
  // A named fail beside a green exit means the report and the runner
  // disagree; ordinary CI would not have failed on this "red".
  if (red.exitCode === 0) {
    return `scan broken: "${entry.testName}" reads failed while the mutated run exited 0 - the junit report and the exit code contradict each other`;
  }
  return null;
}

/** The restored control run's verdict: null means the control stands
 *  (the named test green in a clean exit-0 run). */
export function judgeControl(control: ForcingRun, entry: GuardEntry): string | null {
  if (control.timedOut) {
    return `failed to look: the restored control run of ${entry.testFile} exceeded its bound`;
  }
  if (
    control.exitCode !== 0 ||
    control.cases === null ||
    namedVerdict(control.cases, entry.testName) !== "pass"
  ) {
    return `control broken: the RESTORED tree does not run "${entry.testName}" green (exit ${control.exitCode}) - the red above is ambient breakage, not proof`;
  }
  return null;
}

/** The whole mutate-red-restore-green proof for one entry, against the
 *  tree at `root`. The guard file is restored in a finally, so a crashed
 *  red run can never leave the scratch tree mutated for later entries. */
export function auditEntry(options: {
  root: string;
  entry: GuardEntry;
  junitDir: string;
  timeoutMs: number;
}): EntryAudit {
  const { root, entry, junitDir, timeoutMs } = options;
  const pids: number[] = [];
  const guardPath = join(root, entry.guardFile);
  let original: string;
  try {
    original = readFileSync(guardPath, "utf-8");
  } catch {
    return {
      armed: false,
      problems: [`scan broken: guard file ${entry.guardFile} is missing in the scratch tree`],
      pids,
    };
  }
  let mutatedContent: string;
  try {
    mutatedContent = applyMutation(original, entry);
  } catch (err) {
    return {
      armed: false,
      problems: [`scan broken: ${err instanceof Error ? err.message : String(err)}`],
      pids,
    };
  }
  const mutation = `${JSON.stringify(entry.snippet)} -> ${JSON.stringify(entry.mutated)}`;
  writeFileSync(guardPath, mutatedContent);
  let red: ForcingRun;
  try {
    red = runForcingTest({
      root,
      testFile: entry.testFile,
      junitPath: join(junitDir, `${entry.id}-red.xml`),
      timeoutMs,
    });
  } finally {
    writeFileSync(guardPath, original);
  }
  pids.push(red.pid);
  const redProblem = judgeRed(red, entry, mutation);
  if (redProblem !== null) return { armed: false, problems: [redProblem], pids };
  const control = runForcingTest({
    root,
    testFile: entry.testFile,
    junitPath: join(junitDir, `${entry.id}-control.xml`),
    timeoutMs,
  });
  pids.push(control.pid);
  const controlProblem = judgeControl(control, entry);
  return {
    armed: controlProblem === null,
    problems: controlProblem === null ? [] : [controlProblem],
    pids,
  };
}

export interface SweepResult {
  /** Survivors found (and SIGKILLed); [] on a clean tree. */
  survivors: number[];
  /** True when the sweep itself could not look (pgrep errored or was
   *  missing) - "nothing found" and "failed to look" must never share a
   *  value, so the caller counts this as a cleanup violation. */
  failed: boolean;
}

/** SIGKILL every process whose argv still references `marker`. pgrep
 *  exit 1 means none found; anything past 1 - including a missing pgrep
 *  binary, which makes the spawn itself throw - means the sweep never
 *  looked, and must never read as clean (it runs inside main's finally,
 *  where a throw would also skip the scratch removal). The executable is
 *  injectable so the failed-look arm is testable. */
export function sweepSurvivors(marker: string, pgrepExecutable = "pgrep"): SweepResult {
  let sweep: { exitCode: number; stdout: string };
  try {
    sweep = capture([pgrepExecutable, "-f", marker], { timeoutMs: 10_000 });
  } catch {
    return { survivors: [], failed: true };
  }
  if (sweep.exitCode === 1) return { survivors: [], failed: false };
  if (sweep.exitCode !== 0) return { survivors: [], failed: true };
  const survivors = sweep.stdout
    .split("\n")
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
  for (const pid of survivors) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone between the scan and the kill.
    }
  }
  return { survivors, failed: false };
}

/** The clone's own registry, so a locally dirty checkout can never mix
 *  revisions (a working-tree registry auditing HEAD's guard files). The
 *  binding check green at that commit is what makes the shape trustable;
 *  the array check is the loud floor for a truncated clone. */
async function loadCloneRegistry(scratch: string): Promise<readonly GuardEntry[]> {
  const module = (await import(join(scratch, "scripts", "guard_registry.ts"))) as {
    GUARD_REGISTRY?: unknown;
  };
  if (!Array.isArray(module.GUARD_REGISTRY)) {
    throw new Error(
      "the scratch clone's scripts/guard_registry.ts exports no GUARD_REGISTRY array",
    );
  }
  return module.GUARD_REGISTRY as readonly GuardEntry[];
}

async function main(): Promise<number> {
  const scratchParent = mkdtempSync(join(tmpdir(), "arm-audit-"));
  const scratch = join(scratchParent, "tree");
  const junitDir = join(scratchParent, "junit");
  let failures = 0;
  let total = 0;
  const cleanupViolations: string[] = [];
  try {
    mkdirSync(junitDir);
    const clone = capture(
      ["git", "clone", "--quiet", "--local", "--no-hardlinks", REPO_ROOT, scratch],
      { timeoutMs: 120_000 },
    );
    if (clone.exitCode !== 0) {
      throw new Error(`git clone into the scratch tree failed: ${clone.stderr}`);
    }
    // The forcing tests may import installed packages; the clone has no
    // node_modules of its own, and installing one would audit different
    // bytes than the checkout runs.
    const nodeModules = join(REPO_ROOT, "node_modules");
    if (existsSync(nodeModules)) symlinkSync(nodeModules, join(scratch, "node_modules"));
    const entries = await loadCloneRegistry(scratch);
    total = entries.length;
    for (const entry of entries) {
      const result = auditEntry({ root: scratch, entry, junitDir, timeoutMs: RUN_TIMEOUT_MS });
      for (const pid of result.pids) {
        if (pidAlive(pid)) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // Died between the check and the kill.
          }
          cleanupViolations.push(`${entry.id}: child ${pid} outlived its bounded run (SIGKILLed)`);
        }
      }
      if (result.armed) {
        console.log(
          `armed: ${entry.id} - "${entry.testName}" went red under the mutation, green restored`,
        );
      } else {
        failures++;
        for (const problem of result.problems) error(`arm-audit: ${entry.id}: ${problem}`);
      }
    }
  } finally {
    const sweep = sweepSurvivors(scratchParent);
    if (sweep.failed) {
      cleanupViolations.push("the pgrep sweep itself failed - cleanup is UNVERIFIED, not clean");
    }
    for (const survivor of sweep.survivors) {
      cleanupViolations.push(
        `process ${survivor} still referenced the scratch tree at cleanup (SIGKILLed)`,
      );
    }
    rmSync(scratchParent, { recursive: true, force: true });
  }
  for (const violation of cleanupViolations) {
    error(`arm-audit: cleanup violation: ${violation}`);
  }
  if (failures > 0 || cleanupViolations.length > 0) {
    error(
      `arm-audit: ${failures} of ${total} registered guards unproven, ${cleanupViolations.length} cleanup violation(s)`,
    );
    return 1;
  }
  console.log(`arm-audit: all ${total} registered guards proved armed`);
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
