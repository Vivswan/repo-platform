import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boundedSpawnSync } from "./bounded_spawn";
import { tempDirs } from "./temp_dir";

const temp = tempDirs();

const script = join(import.meta.dir, "../../.github/scripts/shared/open_automation_pr.ts");

// Records every git/gh invocation to CALLS_LOG with arguments separated by
// \x1f and records by \x1e, so split arguments and multiline values stay
// distinguishable. `gh api` answers the canned PR_LOOKUP JSON and `gh pr
// create` prints CREATED_URL; GIT_FAIL/GH_FAIL pick a subcommand that
// exits 1, and GH_HANG picks a gh subcommand that stalls: exec, so the
// deadline's SIGKILL reaches the sleeper itself, and 10s (under the 15s
// harness bound), so an unarmed deadline (the registry's mutation) comes
// back to the exit-code assertion with no sleeper left behind.
const stub = (tool: string) => `#!/usr/bin/env bash
set -euo pipefail
{ printf '%s' "${tool}"; for a in "$@"; do printf '\\x1f%s' "$a"; done; printf '\\x1e'; } >>"$CALLS_LOG"
if [ "\${${tool.toUpperCase()}_FAIL:-}" = "\${1:-}" ]; then
  echo "${tool} \${1:-} failed" >&2
  exit 1
fi
case "\${GH_HANG:-}" in "\${1:-}"|"\${2:-}") exec sleep 10;; esac
if [ "${tool}" = "gh" ] && [ "\${1:-}" = "api" ]; then
  printf '%s' "\${PR_LOOKUP:-}"
fi
if [ "${tool}" = "gh" ] && [ "\${2:-}" = "create" ]; then
  printf '%s\\n' "$CREATED_URL"
fi
`;

// Multiline on purpose: the body must reach gh as ONE argv (the \x1f
// record separator keeps a split argument distinguishable from a newline).
const PR_BODY = "**MAJOR VERSION JUMP: bun 2 - review before merging.**\n\nAutomated refresh body.";
const PR_TITLE = "chore: refresh x from upstream";
const CREATED_URL = "https://github.com/Vivswan/repo-platform/pull/99";
const SLUG = "Vivswan/repo-platform";
const BRANCH = "automation/x-refresh";

// The six git records every successful run opens with, then the lookup:
// the REST listing qualified by OUR head (owner:branch, URL-encoded) pins
// owner and ref; the script then verifies each row's head repository.
const GIT_PREFIX = [
  ["git", "config", "user.name", "repo-platform-sync"],
  ["git", "config", "user.email", "repo-platform-sync@users.noreply.github.com"],
  ["git", "checkout", "-B", BRANCH],
  ["git", "add", "-A"],
  ["git", "commit", "-m", "chore: refresh x from upstream@abc"],
  ["git", "push", "--force", "origin", BRANCH],
];
const PR_LIST = [
  "gh",
  "api",
  `repos/${SLUG}/pulls?state=open&per_page=100&head=Vivswan%3Aautomation%2Fx-refresh`,
];
// biome-ignore format: one argv per line loses the record shape
const PR_CREATE = ["gh", "pr", "create", "-R", SLUG, "--base", "main", "--head", BRANCH, "--title", PR_TITLE, "--body", PR_BODY];
const PR_EDIT = ["gh", "pr", "edit", "17", "-R", SLUG, "--body", PR_BODY];
const PR_EDIT_TITLED = [
  "gh",
  "pr",
  "edit",
  "17",
  "-R",
  SLUG,
  "--title",
  PR_TITLE,
  "--body",
  PR_BODY,
];

/** One REST pulls row: a PR on the branch whose head repository is
 * `fullName` (null once a fork's repository is deleted). */
const pull = (number: number, fullName: string | null) => ({
  number,
  head: { repo: fullName === null ? null : { full_name: fullName } },
});
const OURS = pull(17, SLUG);

interface Options {
  env?: Record<string, string>;
  lookup?: unknown[] | string;
  drop?: string[];
}

function run(opts: Options = {}) {
  const root = temp.dir("open-automation-pr-");
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "git"), stub("git"), { mode: 0o755 });
  writeFileSync(join(bin, "gh"), stub("gh"), { mode: 0o755 });
  const calls = join(root, "calls.log");
  const lookup = opts.lookup ?? [];
  // The stubs' controls are cleared so an ambient value cannot steer a
  // case that did not set it.
  const scriptEnv: Record<string, string | undefined> = {
    ...process.env,
    REFRESH_TITLE: undefined,
    GH_TIMEOUT_MS: undefined,
    GH_HANG: undefined,
    GH_FAIL: undefined,
    GIT_FAIL: undefined,
    PATH: `${bin}:${process.env.PATH}`,
    CALLS_LOG: calls,
    PR_LOOKUP: typeof lookup === "string" ? lookup : JSON.stringify(lookup),
    CREATED_URL,
    GITHUB_REPOSITORY: SLUG,
    BRANCH,
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
  // Rows are [reason, env overrides, dropped env, exit code, error line].
  // A missing env exits 2 (requireEnv); a present-but-invalid one exits 1.
  const slugError = (slug: string) =>
    `::error::GITHUB_REPOSITORY must be an owner/name slug, not "${slug}"`;
  const deadlineError = "::error::GH_TIMEOUT_MS must be a positive integer of milliseconds";
  test.each([
    ["a missing required env", {}, ["PR_BODY"], 2, "::error::PR_BODY must be set"],
    [
      "a missing repository slug",
      {},
      ["GITHUB_REPOSITORY"],
      2,
      "::error::GITHUB_REPOSITORY must be set",
    ],
    [
      "a slug without an owner",
      { GITHUB_REPOSITORY: "/repo-platform" },
      [],
      1,
      slugError("/repo-platform"),
    ],
    ["a slug without a name", { GITHUB_REPOSITORY: "Vivswan/" }, [], 1, slugError("Vivswan/")],
    ["a bare owner", { GITHUB_REPOSITORY: "Vivswan" }, [], 1, slugError("Vivswan")],
    ["a slug with a third segment", { GITHUB_REPOSITORY: "a/b/c" }, [], 1, slugError("a/b/c")],
    ["a non-numeric deadline", { GH_TIMEOUT_MS: "soon" }, [], 1, deadlineError],
    [
      "a zero deadline (spawnSync would read it as no bound)",
      { GH_TIMEOUT_MS: "0" },
      [],
      1,
      deadlineError,
    ],
  ])("%s fails before any command runs", (_reason, env, drop, exitCode, message) => {
    const r = run({ env, drop });
    expect(r.exitCode).toBe(exitCode);
    expect(r.output).toContain(message);
    expect(r.calls).toEqual([]);
  });

  // Rows are [reason, lookup rows, env, the one PR call after the lookup,
  // the log line]. The whole call list makes the road not taken explicit:
  // an edited PR is never re-created and a created one was never edited.
  test.each([
    ["no open PR on our head: creates one", [], {}, PR_CREATE, CREATED_URL],
    [
      "an existing same-repo PR: refreshes its body, no duplicate PR",
      [OURS],
      {},
      PR_EDIT,
      "refreshed PR #17",
    ],
    [
      "REFRESH_TITLE=true refreshes the title too",
      [OURS],
      { REFRESH_TITLE: "true" },
      PR_EDIT_TITLED,
      "refreshed PR #17",
    ],
    [
      "a same-repo head whose slug differs only by case is ours",
      [pull(17, "vivswan/Repo-Platform")],
      {},
      PR_EDIT,
      "refreshed PR #17",
    ],
  ])("%s", (_reason, lookup, env, prCall, line) => {
    const r = run({ lookup, env });
    expect(r.exitCode).toBe(0);
    expect(r.calls).toEqual([...GIT_PREFIX, PR_LIST, prCall]);
    expect(r.output).toContain(line);
  });

  // Rows are [reason, lookup rows, the refusal]. Nothing is created or
  // edited after a refusal: the call list ends at the lookup.
  test.each([
    [
      "a fork's same-named PR in the listing: refused, never edited",
      [pull(41, "forker/repo-platform")],
      `::error::the pulls listing for Vivswan:${BRANCH} returned PR #41 with a head outside ${SLUG}; refusing to touch it`,
    ],
    [
      "a fork's PR beside ours: refused, ours is not guessed at either",
      [pull(41, "forker/repo-platform"), OURS],
      `::error::the pulls listing for Vivswan:${BRANCH} returned PR #41 with a head outside ${SLUG}; refusing to touch it`,
    ],
    [
      "a same-owner repository that is not this one (the head filter pins owner and ref only)",
      [pull(43, "Vivswan/other-fork")],
      `::error::the pulls listing for Vivswan:${BRANCH} returned PR #43 with a head outside ${SLUG}; refusing to touch it`,
    ],
    [
      "a PR whose head repository was deleted is not ours",
      [pull(5, null)],
      `::error::the pulls listing for Vivswan:${BRANCH} returned PR #5 with a head outside ${SLUG}; refusing to touch it`,
    ],
    [
      "two open same-repo PRs on the branch: refuses by name instead of guessing",
      [OURS, pull(23, SLUG)],
      `::error::more than one open PR from Vivswan:${BRANCH} (#17, #23); refusing to guess which one to refresh`,
    ],
    [
      "a malformed listing payload: a value-free shape diagnosis",
      '[{"number":"17"}]',
      "::error::gh api pulls: unexpected shape - 0.number: invalid_type; 0.head: invalid_type",
    ],
  ])("%s", (_reason, lookup, message) => {
    const r = run({ lookup });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain(message);
    expect(r.output).not.toContain('"17"');
    expect(r.calls).toEqual([...GIT_PREFIX, PR_LIST]);
  });

  // Registered in scripts/guard_registry.ts: the deadline is the guard,
  // this test the forcing case. Each hung gh call is SIGKILLed at the
  // deadline (exit 128+9), the deadline is named, and nothing after the
  // hung call runs. Without the deadline the run waits out the 10s
  // sleeper, the stub returns empty, and the exit code is not 137.
  test("FORCED RED: a hung gh call hits the deadline and exits with the named refusal", () => {
    const hangs: [string, unknown[], string[][]][] = [
      ["api", [], [...GIT_PREFIX, PR_LIST]],
      ["create", [], [...GIT_PREFIX, PR_LIST, PR_CREATE]],
      ["edit", [OURS], [...GIT_PREFIX, PR_LIST, PR_EDIT]],
    ];
    for (const [hang, lookup, calls] of hangs) {
      const r = run({ lookup, env: { GH_HANG: hang, GH_TIMEOUT_MS: "300" } });
      expect(r.exitCode).toBe(137);
      expect(r.output).toContain(
        `command timed out after 300ms: gh ${calls.at(-1)?.slice(1, 3).join(" ")}`,
      );
      expect(r.calls).toEqual(calls);
    }
  });

  // Rows are [reason, env, exit code, the calls made]: a failed step stops
  // the run right there, so a PR is never created over a failed push or a
  // failed lookup.
  test.each([
    ["a failed push stops the run before any PR call", { GIT_FAIL: "push" }, GIT_PREFIX],
    [
      "a failed lookup fails the run instead of double-creating",
      { GH_FAIL: "api" },
      [...GIT_PREFIX, PR_LIST],
    ],
  ])("%s", (_reason, env, calls) => {
    const r = run({ env });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain(`${calls.at(-1)?.[0]} ${calls.at(-1)?.[1]} failed`);
    expect(r.calls).toEqual(calls);
  });
});
