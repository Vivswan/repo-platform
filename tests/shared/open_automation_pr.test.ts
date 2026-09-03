import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boundedSpawnSync } from "./bounded_spawn";

const script = join(import.meta.dir, "../../.github/scripts/shared/open_automation_pr.ts");

// Records every git/gh invocation to CALLS_LOG with arguments separated by
// \x1f and records by \x1e, so split arguments and multiline values stay
// distinguishable. `gh pr list` answers the canned PR_LOOKUP, and
// GIT_FAIL/GH_FAIL pick a subcommand that exits 1.
const stub = (tool: string) => `#!/usr/bin/env bash
set -euo pipefail
{ printf '%s' "${tool}"; for a in "$@"; do printf '\\x1f%s' "$a"; done; printf '\\x1e'; } >>"$CALLS_LOG"
if [ "\${${tool.toUpperCase()}_FAIL:-}" = "\${1:-}" ]; then
  echo "${tool} \${1:-} failed" >&2
  exit 1
fi
if [ "${tool}" = "gh" ] && [ "\${2:-}" = "list" ]; then
  printf '%s' "\${PR_LOOKUP:-}"
fi
`;

// Multiline on purpose: the body must reach gh as ONE argv (the \x1f
// record separator keeps a split argument distinguishable from a newline).
const PR_BODY = "**MAJOR VERSION JUMP: bun 2 - review before merging.**\n\nAutomated refresh body.";
const PR_TITLE = "chore: refresh x from upstream";

// The six git records every successful run opens with, then the lookup.
const GIT_PREFIX = [
  ["git", "config", "user.name", "repo-platform-sync"],
  ["git", "config", "user.email", "repo-platform-sync@users.noreply.github.com"],
  ["git", "checkout", "-B", "automation/x-refresh"],
  ["git", "add", "-A"],
  ["git", "commit", "-m", "chore: refresh x from upstream@abc"],
  ["git", "push", "--force", "origin", "automation/x-refresh"],
];
// biome-ignore format: one argv per line loses the record shape
const PR_LIST = ["gh", "pr", "list", "--head", "automation/x-refresh", "--json", "number", "--jq", ".[0].number // empty"];

interface Options {
  env?: Record<string, string>;
  lookup?: string;
  drop?: string[];
}

function run(opts: Options = {}) {
  const root = mkdtempSync(join(tmpdir(), "open-automation-pr-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "git"), stub("git"), { mode: 0o755 });
  writeFileSync(join(bin, "gh"), stub("gh"), { mode: 0o755 });
  const calls = join(root, "calls.log");
  const scriptEnv: Record<string, string | undefined> = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    CALLS_LOG: calls,
    PR_LOOKUP: opts.lookup ?? "",
    BRANCH: "automation/x-refresh",
    BASE_BRANCH: "main",
    COMMIT_MESSAGE: "chore: refresh x from upstream@abc",
    PR_TITLE,
    PR_BODY,
    ...opts.env,
  };
  for (const name of opts.drop ?? []) delete scriptEnv[name];
  const proc = boundedSpawnSync(["bun", script], { env: scriptEnv });
  const raw = existsSync(calls) ? readFileSync(calls, "utf-8") : "";
  return {
    exitCode: proc.exitCode,
    output: proc.stdout + proc.stderr,
    calls: raw
      .split("\x1e")
      .filter(Boolean)
      .map((record) => record.split("\x1f")),
  };
}

describe("open_automation_pr.ts", () => {
  test("a missing required env fails before any command runs", () => {
    const r = run({ drop: ["PR_BODY"] });
    expect(r.exitCode).toBe(2);
    expect(r.output).toContain("::error::PR_BODY must be set");
    expect(r.calls).toEqual([]);
  });

  test("commits the tree onto the branch, force-pushes, and creates the PR with the multiline body as one argument", () => {
    const r = run();
    expect(r.exitCode).toBe(0);
    expect(r.calls).toEqual([
      ...GIT_PREFIX,
      PR_LIST,
      // biome-ignore format: one argv per line loses the record shape
      ["gh", "pr", "create", "--base", "main", "--head", "automation/x-refresh", "--title", PR_TITLE, "--body", PR_BODY],
    ]);
  });

  // An existing PR is edited, never re-created: the whole call list makes
  // the absent `gh pr create` explicit. Rows are [reason, env, edit record].
  test.each([
    [
      "an existing PR gets its body refreshed, not a duplicate PR",
      {},
      ["gh", "pr", "edit", "17", "--body", PR_BODY],
    ],
    [
      "REFRESH_TITLE=true refreshes an existing PR's title too",
      { REFRESH_TITLE: "true" },
      ["gh", "pr", "edit", "17", "--title", PR_TITLE, "--body", PR_BODY],
    ],
  ])("%s", (_reason, env, edit) => {
    const r = run({ lookup: "17", env });
    expect(r.exitCode).toBe(0);
    expect(r.calls).toEqual([...GIT_PREFIX, PR_LIST, edit]);
  });

  test("a failed push stops the run before any PR call", () => {
    const r = run({ env: { GIT_FAIL: "push" } });
    expect(r.exitCode).toBe(1);
    expect(r.calls).toEqual(GIT_PREFIX);
  });

  test("a failed PR lookup fails the run instead of double-creating", () => {
    const r = run({ env: { GH_FAIL: "pr" } });
    expect(r.exitCode).toBe(1);
    expect(r.calls).toEqual([...GIT_PREFIX, PR_LIST]);
  });
});
