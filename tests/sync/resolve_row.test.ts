// The row's transport and its resolver, run as the workflows run them: the matrix spells no masked
// name, and each entry script's stdout is nothing but ::add-mask:: commands for every form of the
// name after ONE listing, the name leaving through GITHUB_ENV alone, every refusal naming no repository.

import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { supersededNotice } from "../../.github/scripts/fleet/newest_main.ts";
import { MIN_MASKED_NAME, maskForms } from "../../.github/scripts/shared/mask.ts";
import { matrixRows, resolveRow, rowKeyOf } from "../../.github/scripts/sync/resolve_row.ts";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { STUB_GIT_FAIL_REFUSAL, writeStubGit } from "../shared/stub_git";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();
const PAT = "stub-token";
/** Under this run id the raw digest of BEEF's slug spells its bare name: the input the key's grouping exists for. */
const RUN_ID = "759";
const keyOf = rowKeyOf(PAT, RUN_ID);
const SHA = "8096c4920f84ec4122d14c5bd884703dd0d382ba";
const NEWER_SHA = "0f1e2d3c4b5a69788796a5b4c3d2e1f0a1b2c3d4";
const PUBLIC = "Vivswan/pub-repo";
const HIDDEN = "Vivswan/Hidden-Server";
/** Private, hex-only name: four characters a raw digest can spell. */
const BEEF = "Vivswan/beef";
/** Private, named for the matrix's own structural word. */
const INCLUDE = "Vivswan/include";
/** Selected by the plan, revoked from the grant before this row ran: in no listing. */
const GONE = "Vivswan/Revoked-mid-run";
/** The one network call a row makes: the listing discovery.ts reads. */
const LISTING = "gh api user/repos --method GET --paginate --slurp -F per_page=100";
/** The settings row's newest-wins read of main's tip, before its listing (fleet/newest_main.ts). */
const TIP_READ = "git ls-remote --exit-code origin refs/heads/main";

type Row = { repo: string; private: boolean };
const rows: Row[] = [
  { repo: HIDDEN, private: true },
  { repo: PUBLIC, private: false },
  { repo: BEEF, private: true },
  { repo: INCLUDE, private: true },
];

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
  env: string;
  calls: string[];
}

/** The two workflows' entry scripts: one resolver, each with its own GITHUB_ENV contract. The
 *  settings row asks newest wins (docs/settings.md) before its listing; the sync row asks nothing. */
const ENTRIES = [
  {
    script: "sync/resolve_row.ts",
    label: "resolve_row",
    handOn: (row: Row) => `TARGET=${row.repo}\nTARGET_PRIVATE=${row.private}\n`,
    newestWins: false,
  },
  {
    script: "fleet/resolve_settings_target.ts",
    label: "resolve_settings_target",
    handOn: (row: Row) => `TARGET=${row.repo}\n`,
    newestWins: true,
  },
];

/** One stub PATH and one listing for every describe in this file. */
const fixture = (() => {
  const root = temp.dir("resolve-row-");
  const bin = join(root, "bin");
  mkdirSync(bin);
  const entry = (full_name: string, overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      full_name,
      archived: false,
      private: true,
      owner: { login: full_name.split("/")[0] },
      permissions: { push: true },
      ...overrides,
    });
  const pages = `[[${[
    entry(HIDDEN),
    entry(PUBLIC, { private: false }),
    entry(BEEF),
    entry(INCLUDE),
    entry("Vivswan/archived-out", { archived: true }),
    entry("Vivswan/read-only", { permissions: { push: false } }),
    entry("Other/cross-owner"),
  ].join(",")}]]`;
  writeFileSync(join(root, "pages.json"), `${pages}\n`);
  writeFileSync(join(root, "malformed.json"), '[[{"full_name":"Vivswan/shapeless"}]]\n');
  writeFileSync(
    join(bin, "gh"),
    [
      "#!/usr/bin/env bash",
      'echo "gh $*" >> "$STUB_CALLS"',
      'if [ -n "$STUB_FAIL_DISCOVERY" ]; then',
      '  echo "HTTP 500 from stub" >&2',
      "  exit 1",
      "fi",
      'cat "$STUB_PAGES"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  writeStubGit(bin);
  return { bin, pages: join(root, "pages.json"), malformed: join(root, "malformed.json") };
})();

/** An entry script under the workflow's env for the step; a case sets a variable to undefined to leave it unset. */
function run(script: string, env: Record<string, string | undefined>): Run {
  const work = temp.dir("resolve-row-run-");
  const envFile = join(work, "env.txt");
  const callsFile = join(work, "calls.txt");
  writeFileSync(envFile, "");
  writeFileSync(callsFile, "");
  const merged: Record<string, string | undefined> = {
    PATH: `${fixture.bin}:${process.env.PATH}`,
    HOME: process.env.HOME,
    STUB_PAGES: fixture.pages,
    STUB_CALLS: callsFile,
    STUB_MAIN_TIP: SHA,
    GITHUB_ENV: envFile,
    GITHUB_RUN_ID: RUN_ID,
    GITHUB_SHA: SHA,
    PAT,
    OWNER: "Vivswan",
    ...env,
  };
  const result = boundedSpawnSync(["bun", join(import.meta.dir, "../../.github/scripts", script)], {
    env: Object.fromEntries(
      Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
  });
  return {
    ...result,
    env: readFileSync(envFile, "utf-8"),
    calls: readFileSync(callsFile, "utf-8")
      .split("\n")
      .filter((line) => line !== ""),
  };
}

const masks = (row: Row) =>
  maskForms(row.repo)
    .map((form) => `::add-mask::${form}\n`)
    .join("");

describe.each(ENTRIES)("$script", ({ script, label, handOn, newestWins }) => {
  /** The calls a row makes before its listing. */
  const before = newestWins ? [TIP_READ] : [];

  const resolved = (row: Row): Run => ({
    exitCode: 0,
    stdout: masks(row),
    stderr: "",
    env: handOn(row),
    calls: [...before, LISTING],
  });
  const refused = (exitCode: number, error: string, calls: string[]): Run => ({
    exitCode,
    stdout: `::error::${error}\n`,
    stderr: "",
    env: "",
    calls,
  });
  const MOVED =
    "the row's key names no repository in the owner's listing: the fleet moved since the plan job ran (a repository revoked or renamed mid-run); re-run the workflow";

  // The runner masks by exact form, so every spelling maskForms registers is masked before any name is written,
  // and the name leaves through GITHUB_ENV alone.
  test.each([
    { visibility: "public", row: rows[1] },
    { visibility: "private", row: rows[0] },
  ])(
    "a $visibility row resolves after one listing and no probe, every form masked before the name is written",
    ({ row }) => {
      expect(run(script, { ROW_KEY: keyOf(row.repo) })).toEqual(resolved(row));
    },
  );

  // The privacy invariant on every refusal path, executed: no channel (stdout, stderr, GITHUB_ENV) carries a
  // repository name in any case, and TARGET is never written.
  test.each<{ reason: string; env: Record<string, string | undefined>; outcome: Run }>([
    // A public repository stays listed with push after its PAT grant is revoked, so this case proves
    // only the missing-listing refusal.
    {
      reason: "a row whose repository left the owner's listing since the plan",
      env: { ROW_KEY: keyOf(GONE) },
      outcome: refused(1, MOVED, [...before, LISTING]),
    },
    {
      reason: "a key under another run's id",
      env: { ROW_KEY: rowKeyOf(PAT, "1")(PUBLIC) },
      outcome: refused(1, MOVED, [...before, LISTING]),
    },
    {
      reason: "a key under another token",
      env: { ROW_KEY: rowKeyOf("other", RUN_ID)(PUBLIC) },
      outcome: refused(1, MOVED, [...before, LISTING]),
    },
    {
      reason: "a bare slug where the key should be",
      env: { ROW_KEY: HIDDEN },
      outcome: refused(1, MOVED, [...before, LISTING]),
    },
    // An empty value is unset to requireEnv, and the refusal comes before any listing; the other required variables
    // pass through the same gate, so these two rows stand for them.
    { reason: "no key", env: {}, outcome: refused(2, "ROW_KEY must be set", before) },
    {
      reason: "an empty key",
      env: { ROW_KEY: "" },
      outcome: refused(2, "ROW_KEY must be set", before),
    },
    {
      reason: "a listing that fails (gh's own stderr, no row resolved)",
      env: { ROW_KEY: keyOf(HIDDEN), STUB_FAIL_DISCOVERY: "1" },
      outcome: {
        exitCode: 1,
        stdout: "",
        stderr: "HTTP 500 from stub\n",
        env: "",
        calls: [...before, LISTING],
      },
    },
    {
      reason: "a listing off user/repos' shape (paths and codes, never the payload)",
      env: { ROW_KEY: keyOf(HIDDEN), STUB_PAGES: fixture.malformed },
      outcome: refused(
        1,
        `${label}: user/repos response: unexpected shape - 0.0.archived: invalid_type; 0.0.private: invalid_type; 0.0.owner: invalid_type`,
        [...before, LISTING],
      ),
    },
    // Newest wins at the write (the settings row alone): a re-run of failed rows reuses the plan's
    // answer, so the row reads main's tip itself before listing anything.
    ...(newestWins
      ? [
          {
            reason:
              "a row whose commit main moved past stands down green with no TARGET, listing nothing",
            env: { ROW_KEY: keyOf(HIDDEN), STUB_MAIN_TIP: NEWER_SHA },
            outcome: {
              exitCode: 0,
              stdout: `::notice::${supersededNotice(SHA, NEWER_SHA)}\n`,
              stderr: "",
              env: "",
              calls: [TIP_READ],
            },
          },
          {
            reason: "a tip that cannot be read fails the row, never guessing",
            env: { ROW_KEY: keyOf(HIDDEN), STUB_GIT_FAIL: "1" },
            outcome: refused(1, STUB_GIT_FAIL_REFUSAL, [TIP_READ]),
          },
          {
            reason: "no commit to judge newest against",
            env: { ROW_KEY: keyOf(HIDDEN), GITHUB_SHA: undefined },
            outcome: refused(2, "GITHUB_SHA must be set", []),
          },
        ]
      : []),
  ])("$reason: the row writes no TARGET and names no repository", ({ env, outcome }) => {
    const result = run(script, env);
    expect(result).toEqual(outcome);
    for (const channel of [result.stdout, result.stderr, result.env]) {
      for (const name of ["pub-repo", "hidden-server", "revoked-mid-run", "shapeless"]) {
        expect(channel.toLowerCase()).not.toContain(name);
      }
    }
  });
});

// The sync row alone probes a dispatched branch, after the listing and before the name is written: the probe is one
// ls-remote of that ref, and a missing branch is a refusal, so the row prints the unresolved line and delivers nothing.
describe("resolve_row.ts with a dispatched branch", () => {
  const { script, handOn } = ENTRIES[0];
  const BRANCH = "feat/add-site";
  const eventFile = join(temp.dir("resolve-row-branch-"), "event.json");
  writeFileSync(eventFile, JSON.stringify({ inputs: { branch: BRANCH } }));
  const probe = (row: Row) =>
    `git ls-remote --exit-code --symref https://x-access-token:${PAT}@github.com/${row.repo}.git HEAD refs/heads/${BRANCH}`;
  const dispatched = (env: Record<string, string>) =>
    run(script, { GITHUB_EVENT_PATH: eventFile, ...env });

  test("a branch the target carries: the row resolves after the listing and one probe", () => {
    expect(dispatched({ ROW_KEY: keyOf(rows[1].repo) })).toEqual({
      exitCode: 0,
      stdout: masks(rows[1]),
      stderr: "",
      env: handOn(rows[1]),
      calls: [LISTING, probe(rows[1])],
    });
  });

  test.each<{ reason: string; env: Record<string, string>; error: string }>([
    {
      reason: "the target's default branch",
      env: { STUB_DEFAULT_BRANCH: BRANCH },
      error:
        "the dispatched branch is the target's default branch: a branch sync commits onto a PR branch; a plain dispatch syncs the default branch through a PR",
    },
    {
      reason: "a branch the target does not carry",
      env: { STUB_MISSING_REF: `refs/heads/${BRANCH}` },
      error: "the dispatched branch does not exist in the target repository",
    },
    {
      reason: "a ref that only ends in the branch's name (ls-remote matches ref suffixes)",
      env: { STUB_REF_PREFIX: "refs/heads/nested/" },
      error: "the dispatched branch does not exist in the target repository",
    },
    {
      reason: "a probe git cannot answer",
      env: { STUB_GIT_FAIL: "1" },
      error: "git ls-remote could not read the target's branches (exit 128); re-run the workflow",
    },
  ])("$reason refuses after the masks, writing no TARGET", ({ env, error }) => {
    expect(dispatched({ ROW_KEY: keyOf(rows[0].repo), ...env })).toEqual({
      exitCode: 1,
      stdout: `${masks(rows[0])}::error::${error}\n`,
      stderr: "",
      env: "",
      calls: [LISTING, probe(rows[0])],
    });
  });
});

describe("resolveRow", () => {
  // A row bound by index instead of key synced the wrong repository when the listing moved (#223); a key no
  // listed repository carries is a refusal that names no repository.
  test("the listed repository carrying the key, at whatever index the listing put it; a key nobody carries is a refusal naming no repository", () => {
    expect(resolveRow(rows, keyOf(HIDDEN), keyOf)).toEqual({ target: rows[0] });
    expect(resolveRow([...rows].reverse(), keyOf(HIDDEN), keyOf)).toEqual({ target: rows[0] });
    expect(resolveRow([...rows].reverse(), keyOf(PUBLIC), keyOf)).toEqual({ target: rows[1] });
    expect(resolveRow(rows, keyOf(GONE), keyOf)).toEqual({
      refusal:
        "the row's key names no repository in the owner's listing: the fleet moved since the plan job ran (a repository revoked or renamed mid-run)",
    });
  });
});

describe("the matrix rows", () => {
  const matrix = matrixRows(rows, keyOf);
  const text = JSON.stringify(matrix);

  // The runner drops a job output that carries a masked value, so a private name the matrix can
  // spell fails every row of the run. Each case is a bare name maskForms registers.
  test.each([
    { name: "beef", repo: BEEF, how: "its raw digest spells it" },
    { name: "include", repo: INCLUDE, how: "the matrix's structural word" },
  ])("a private repository named $name ($how) is spelled nowhere in the matrix", ({ repo }) => {
    if (repo === BEEF) expect(keyOf(BEEF).replaceAll("~", "")).toContain("beef");
    for (const form of maskForms(repo)) expect(text).not.toContain(form);
  });

  // The general property behind the two names above, cross-file with shared/mask.ts: no piece between the matrix's
  // punctuation reaches the mask floor, and its alphabet is one no slug or URL form shares; every row still reads back.
  test("the matrix splits at its punctuation into pieces under the mask floor, in an alphabet no slug or URL form shares, one row per repository", () => {
    expect(matrix).toEqual(rows.map((row, index) => ({ row: index, key: keyOf(row.repo) })));
    expect(text).toMatch(/^[0-9a-z~"{}[\]:,]+$/);
    for (const piece of text.split(/["{}[\]:,~]/)) {
      expect(piece.length).toBeLessThan(MIN_MASKED_NAME);
    }
    for (const { row, key } of matrix) {
      expect(key).toMatch(/^([0-9a-f]{3}~){21}[0-9a-f]$/);
      expect(resolveRow(rows, key, keyOf)).toEqual({ target: rows[row] });
    }
  });
});
