// The audit step's bash EXECUTED as the runner runs it (`shell: bash` is
// `bash --noprofile --norc -eo pipefail`), against a fixture index and a
// deno stub that records where and how it was called.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { fixtureGit, fixtureGitEnv } from "../shared/fixture_git";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();

const source = readFileSync(
  join(import.meta.dir, "../../files/deno/.github/workflows/deno-audit.yml"),
  "utf8",
);
const workflow = parseYaml(source) as {
  jobs: { audit: { steps: { name?: string; shell?: string; run?: string }[] } };
};
const step = workflow.jobs.audit.steps.find((s) => s.name === "Audit dependencies (deno)");

interface Fixture {
  tracked: string[];
  untracked: string[];
}

function runStep(fixture: Fixture) {
  const root = temp.dir("deno-audit-step-");
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  const log = join(root, "deno.log");
  mkdirSync(repo);
  mkdirSync(bin);
  writeFileSync(log, "");
  writeFileSync(
    join(bin, "deno"),
    `#!/bin/sh\nprintf '%s %s\\n' "$(pwd -P)" "$*" >> "$DENO_LOG"\n`,
  );
  chmodSync(join(bin, "deno"), 0o755);
  fixtureGit(repo, ["init", "-q"]);
  for (const path of [...fixture.tracked, ...fixture.untracked]) {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), "{}\n");
  }
  if (fixture.tracked.length > 0) fixtureGit(repo, ["add", "--", ...fixture.tracked]);
  const result = spawnSync(
    "bash",
    ["--noprofile", "--norc", "-eo", "pipefail", "-c", step?.run ?? ""],
    {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...fixtureGitEnv(),
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        RUNNER_TEMP: root,
        DENO_LOG: log,
      },
    },
  );
  const audited = readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.replace(`${realpathSync(repo)}`, "<repo>"));
  return { status: result.status, stdout: result.stdout, audited };
}

interface Case {
  name: string;
  fixture: Fixture;
  status: number;
  stdoutHas: string;
  audited: string[];
}

const CASES: Case[] = [
  {
    name: "no deno.lock tracked is red: nothing was audited",
    fixture: { tracked: [], untracked: [] },
    status: 1,
    stdoutHas: "::error::no deno.lock tracked, so nothing was audited; commit the lockfile\n",
    audited: [],
  },
  {
    name: "an untracked deno.lock counts as none",
    fixture: { tracked: [], untracked: ["deno.lock"] },
    status: 1,
    stdoutHas: "::error::no deno.lock tracked, so nothing was audited; commit the lockfile\n",
    audited: [],
  },
  {
    name: "every tracked lockfile is audited from its own directory with the fleet's flags",
    fixture: { tracked: ["deno.lock", "pkg/deno.lock"], untracked: ["other/deno.lock"] },
    status: 0,
    stdoutHas: "auditing deno.lock\nauditing pkg/deno.lock\n",
    audited: ["<repo> audit --frozen --level high", "<repo>/pkg audit --frozen --level high"],
  },
];

describe("deno-audit.yml's audit step", () => {
  test.each(CASES)("$name", ({ fixture, status, stdoutHas, audited }) => {
    expect(step?.shell).toBe("bash");
    const result = runStep(fixture);
    expect(result.status).toBe(status);
    expect(result.stdout).toContain(stdoutHas);
    expect(result.audited).toEqual(audited);
  });
});
