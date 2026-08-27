// open_pr.ts: the PR-body section collection and the auto-merge decision.
// The script is gh-bound, so a stub gh on PATH records every invocation
// and serves canned answers; the assertions read the recorded `pr create`
// body and the presence/absence of the `pr merge` arm call. The section
// fixtures write through the SAME filename constants the production
// writers use (section_files.ts), so a renamed report file fails here.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REMOVED_SPLITS_NAME,
  SETTINGS_LAYERING_NAME,
  TAIL_SHRANK_NAME,
} from "../../.github/scripts/sync/section_files.ts";

const script = join(import.meta.dir, "../../.github/scripts/sync/open_pr.ts");

const ghStub = `#!/usr/bin/env bash
set -euo pipefail
{ printf '%s' "gh"; for a in "$@"; do printf '\\x1f%s' "$a"; done; printf '\\x1e'; } >>"$CALLS_LOG"
case "$1 $2" in
  "pr list") printf '' ;;
  "pr create") echo "https://github.com/o/r/pull/1" ;;
  "pr view") echo "https://github.com/o/r/pull/1" ;;
  *) : ;;
esac
`;

interface Options {
  /** RUNNER_TEMP files by name (old_commit.txt is always written). */
  temp?: Record<string, string>;
  /** Contents for the env-named flag files ("" = present but empty). */
  files?: Record<string, string>;
  env?: Record<string, string>;
}

function run(opts: Options = {}) {
  const root = mkdtempSync(join(tmpdir(), "open-pr-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), ghStub, { mode: 0o755 });
  const runnerTemp = join(root, "runner-temp");
  mkdirSync(runnerTemp);
  writeFileSync(join(runnerTemp, "old_commit.txt"), "template@oldsha");
  for (const [name, content] of Object.entries(opts.temp ?? {})) {
    writeFileSync(join(runnerTemp, name), content);
  }
  const fileEnv: Record<string, string> = {};
  const fileVars = [
    "DRIFT_FILE",
    "CARRIED_FILE",
    "CARRY_REVIEW_FILE",
    "RETIRED_MODULES_FILE",
    "REMOVED_PATHS_FILE",
    "WITHHELD_FILE",
    "MANIFEST_LICENSE_FILE",
  ];
  for (const name of fileVars) {
    const path = join(root, `${name.toLowerCase()}.txt`);
    fileEnv[name] = path;
    const content = opts.files?.[name];
    if (content !== undefined) writeFileSync(path, content);
  }
  const calls = join(root, "calls.log");
  const proc = Bun.spawnSync(["bun", script], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      CALLS_LOG: calls,
      TARGET: "Vivswan/target",
      RUNNER_TEMP: runnerTemp,
      GITHUB_REPOSITORY: "Vivswan/repo-platform",
      GITHUB_OUTPUT: join(root, "gh-output.txt"),
      BRANCH: "automation/repo-platform",
      BASE_BRANCH: "main",
      DISPLAY: "template@newsha",
      RECOVER: "",
      RESOLVED: "",
      VALIDATION: "passed",
      HIDE_DETAILS: "",
      ...fileEnv,
      ...opts.env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const raw = existsSync(calls) ? readFileSync(calls, "utf-8") : "";
  const records = raw
    .split("\x1e")
    .filter(Boolean)
    .map((record) => record.split("\x1f"));
  const create = records.find((args) => args[1] === "pr" && args[2] === "create");
  const body = create ? (create[create.indexOf("--body") + 1] ?? "") : "";
  return {
    exitCode: proc.exitCode,
    output: proc.stdout.toString() + proc.stderr.toString(),
    records,
    body,
    merged: records.some((args) => args[1] === "pr" && args[2] === "merge"),
  };
}

describe("open_pr sections and auto-merge", () => {
  test("a clean update carries no sections and arms auto-merge", () => {
    const r = run();
    expect(r.exitCode).toBe(0);
    expect(r.body).toContain("Automated template update");
    expect(r.body).toContain("- New: `template@newsha`");
    expect(r.body).not.toContain("TAIL TRIPWIRE");
    expect(r.merged).toBe(true);
    expect(r.output).toContain("auto-merge armed");
  });

  test("a tail-shrank report becomes a body section and forces review", () => {
    const report = "> [!WARNING]\n> TAIL TRIPWIRE: lines missing\n";
    const r = run({ temp: { [TAIL_SHRANK_NAME]: report } });
    expect(r.exitCode).toBe(0);
    expect(r.body).toContain("TAIL TRIPWIRE: lines missing");
    expect(r.merged).toBe(false);
    expect(r.output).toContain("auto-merge left off");
  });

  test("a settings-layering report becomes a body section and forces review", () => {
    const r = run({ temp: { [SETTINGS_LAYERING_NAME]: "### settings.yml layering\ndropped" } });
    expect(r.exitCode).toBe(0);
    expect(r.body).toContain("settings.yml layering");
    expect(r.merged).toBe(false);
  });

  test("the carry summary is a section WITHOUT forcing review", () => {
    const r = run({ files: { CARRIED_FILE: "- `AGENTS.md`: rebuilt structurally" } });
    expect(r.exitCode).toBe(0);
    expect(r.body).toContain("rebuilt structurally");
    expect(r.merged).toBe(true);
  });

  test("the carry-review flag forces review without a body section of its own", () => {
    const r = run({ files: { CARRY_REVIEW_FILE: "AGENTS.md: managed-half edits reset\n" } });
    expect(r.exitCode).toBe(0);
    expect(r.body).not.toContain("managed-half edits reset");
    expect(r.merged).toBe(false);
    expect(r.output).toContain("auto-merge left off");
  });

  test("withheld workflow files and a removed-splits report both force review", () => {
    const withheld = run({ files: { WITHHELD_FILE: ".github/workflows/ci.yml\n" } });
    expect(withheld.body).toContain("WITHHELD");
    expect(withheld.merged).toBe(false);
    const report =
      "> [!WARNING]\n> This update DELETES file(s) whose previous copy carries a\n> repository-owned half.\n\n- `AGENTS.md`: this repository-owned content leaves with the deletion:\n\n  ````text\n  local agents tail\n  ````\n";
    const removed = run({ temp: { [REMOVED_SPLITS_NAME]: report } });
    expect(removed.body).toContain("This update DELETES");
    expect(removed.body).toContain("local agents tail");
    expect(removed.merged).toBe(false);
  });

  test("informational sections (retired modules, removed paths, manifest license) stay auto-merge-eligible", () => {
    const r = run({
      files: {
        RETIRED_MODULES_FILE: "fuzzer\n",
        REMOVED_PATHS_FILE: ".github/old.yml\n",
        MANIFEST_LICENSE_FILE: "license metadata note\n",
      },
    });
    expect(r.body).toContain("Retired modules dropped from the selection: fuzzer");
    expect(r.body).toContain("- .github/old.yml");
    expect(r.body).toContain("license metadata note");
    expect(r.merged).toBe(true);
  });

  test("out-of-band settings drift prepends to the top and forces review", () => {
    const r = run({ files: { DRIFT_FILE: "> [!WARNING]\n> drift detected\n" } });
    expect(r.body.startsWith("> [!WARNING]\n> drift detected")).toBe(true);
    expect(r.merged).toBe(false);
  });
});
