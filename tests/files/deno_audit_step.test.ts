// The audit script EXECUTED as the workflow's run line names it, against a fixture index and a
// deno stub that records where and how it was called; each case names the fact it pins. The
// platform's CI has no deno, so the fixture runs the script under bun; the script's header says why
// the same file runs under both.

import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { parseFilesConfig } from "../../actions/plan/files_config";
import { REPO_ROOT } from "../shared/action_step";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { fixtureGit, fixtureGitEnv } from "../shared/fixture_git";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();

const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf8");
const workflow = parseYaml(read("files/deno/.github/workflows/deno-audit.yml")) as {
  jobs: { audit: { steps: { name?: string; run?: string }[] } };
};
const step = workflow.jobs.audit.steps.find((s) => s.name === "Audit dependencies (deno)");
const runLine = (step?.run ?? "").trimEnd();
// One line, `deno run <permission flags> <script>`: the shape the shell rule leaves a run: step.
const shape = /^deno run((?: --allow-[a-z]+(?:=[^\s]+)?)+) (\S+)$/.exec(runLine);
if (shape === null) throw new Error(`the audit step is not one deno run line: ${runLine}`);
const SCRIPT_PATH = shape[2];
const SCRIPT_SOURCE = join(REPO_ROOT, "files/deno", SCRIPT_PATH);

interface Fixture {
  /** Whether the repository directory is a git repository at all. */
  repository: boolean;
  tracked: string[];
  untracked: string[];
  /** Lockfile directories whose audit the stub fails with status 3. */
  red: string[];
}

function runScript(fixture: Fixture) {
  const root = temp.dir("deno-audit-script-");
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  const log = join(root, "audit.log");
  mkdirSync(repo);
  mkdirSync(bin);
  writeFileSync(log, "");
  // AUDIT_STUB_LOG, not DENO_LOG: deno reads the latter as its own logging spec.
  writeFileSync(
    join(bin, "deno"),
    `#!/bin/sh\nprintf '%s %s\\n' "$(pwd -P)" "$*" >> "$AUDIT_STUB_LOG"\n[ -e .deno-audit-red ] && exit 3\nexit 0\n`,
  );
  chmodSync(join(bin, "deno"), 0o755);
  if (fixture.repository) fixtureGit(repo, ["init", "-q"]);
  for (const path of [...fixture.tracked, ...fixture.untracked]) {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), "{}\n");
  }
  for (const dir of fixture.red) writeFileSync(join(repo, dir, ".deno-audit-red"), "");
  if (fixture.tracked.length > 0) fixtureGit(repo, ["add", "--", ...fixture.tracked]);
  const result = boundedSpawnSync(["bun", SCRIPT_SOURCE], {
    cwd: repo,
    env: {
      ...fixtureGitEnv(),
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      AUDIT_STUB_LOG: log,
    },
  });
  const audited = readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.replace(realpathSync(repo), "<repo>"));
  return { status: result.exitCode, stdout: result.stdout, audited };
}

const NO_LOCKFILE = "::error::no deno.lock tracked, so nothing was audited; commit the lockfile\n";

interface Case {
  name: string;
  fixture: Fixture;
  outcome: ReturnType<typeof runScript>;
}

const CASES: Case[] = [
  {
    name: "no deno.lock tracked is red: nothing was audited",
    fixture: { repository: true, tracked: [], untracked: [], red: [] },
    outcome: { status: 1, stdout: NO_LOCKFILE, audited: [] },
  },
  {
    name: "an untracked deno.lock counts as none",
    fixture: { repository: true, tracked: [], untracked: ["deno.lock"], red: [] },
    outcome: { status: 1, stdout: NO_LOCKFILE, audited: [] },
  },
  {
    name: "every tracked lockfile is audited from its own directory with the fleet's flags",
    fixture: {
      repository: true,
      tracked: ["deno.lock", "pkg/deno.lock"],
      untracked: ["other/deno.lock"],
      red: [],
    },
    outcome: {
      status: 0,
      stdout: "auditing deno.lock\nauditing pkg/deno.lock\n",
      audited: ["<repo> audit --frozen --level high", "<repo>/pkg audit --frozen --level high"],
    },
  },
  {
    name: "a red audit ends the run with the audit's own status",
    fixture: {
      repository: true,
      tracked: ["deno.lock", "pkg/deno.lock"],
      untracked: [],
      red: ["."],
    },
    outcome: {
      status: 3,
      stdout: "auditing deno.lock\n",
      audited: ["<repo> audit --frozen --level high"],
    },
  },
  {
    name: "a failed listing is git's own failure, never read as no lockfiles",
    fixture: { repository: false, tracked: [], untracked: ["deno.lock"], red: [] },
    outcome: { status: 128, stdout: "", audited: [] },
  },
];

describe("deno-audit.yml's audit step", () => {
  test("the run line names a managed file files.yml ships with the deno module", () => {
    const entry = parseFilesConfig(read("files.yml")).files.find((e) => e.path === SCRIPT_PATH);
    expect([entry?.class, entry?.when, existsSync(SCRIPT_SOURCE)]).toEqual([
      "managed",
      { modules: ["deno"] },
      true,
    ]);
  });

  test.each(CASES)("$name", ({ fixture, outcome }) => {
    expect(runScript(fixture)).toEqual(outcome);
  });
});
