// The row's transport and its resolver, run as the workflows run them: the matrix spells no masked
// name, and each entry script's stdout is nothing but ::add-mask:: commands for every form of the
// name after ONE listing, the name leaving through GITHUB_ENV alone, every refusal naming no repository.

import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { supersededNotice } from "../../.github/scripts/fleet/newest_main.ts";
import { MIN_MASKED_NAME, maskForms } from "../../.github/scripts/shared/mask.ts";
import { matrixRows, resolveRow, rowKeyOf } from "../../.github/scripts/sync/resolve_row.ts";
import { boundedSpawnSync } from "../shared/bounded_spawn";
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

describe.each(ENTRIES)("$script", ({ script, label, handOn, newestWins }) => {
  /** The calls a row makes before its listing. */
  const before = newestWins ? [TIP_READ] : [];
  const root = temp.dir("resolve-row-");
  const bin = join(root, "bin");

  // The owner's listing as the stub `gh` answers user/repos: the rows, an archived and a read-only
  // repository the listing drops, and a cross-owner one the owner filter drops. Every call is logged.
  beforeAll(() => {
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
    // main's tip as the stub `git` answers ls-remote: STUB_MAIN_TIP (the run's commit unless a case
    // moves it), or a dead remote.
    writeFileSync(
      join(bin, "git"),
      [
        "#!/usr/bin/env bash",
        'echo "git $*" >> "$STUB_CALLS"',
        '[ "$1" = "ls-remote" ] || { echo "stub git: unexpected $*" >&2; exit 64; }',
        'if [ -n "$STUB_GIT_FAIL" ]; then',
        "  echo \"fatal: unable to access 'origin': Could not resolve host\" >&2",
        "  exit 128",
        "fi",
        'printf "%s\\trefs/heads/main\\n" "$STUB_MAIN_TIP"',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
  });

  /** The workflow's env for the step; a case sets a variable to undefined to leave it unset. */
  function run(env: Record<string, string | undefined>): Run {
    const work = temp.dir("resolve-row-run-");
    const envFile = join(work, "env.txt");
    const callsFile = join(work, "calls.txt");
    writeFileSync(envFile, "");
    writeFileSync(callsFile, "");
    const merged: Record<string, string | undefined> = {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: process.env.HOME,
      STUB_PAGES: join(root, "pages.json"),
      STUB_CALLS: callsFile,
      STUB_MAIN_TIP: SHA,
      GITHUB_ENV: envFile,
      GITHUB_RUN_ID: RUN_ID,
      GITHUB_SHA: SHA,
      PAT,
      OWNER: "Vivswan",
      ...env,
    };
    const result = boundedSpawnSync(
      ["bun", join(import.meta.dir, "../../.github/scripts", script)],
      {
        env: Object.fromEntries(
          Object.entries(merged).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
      },
    );
    return {
      ...result,
      env: readFileSync(envFile, "utf-8"),
      calls: readFileSync(callsFile, "utf-8")
        .split("\n")
        .filter((line) => line !== ""),
    };
  }

  const resolved = (row: Row): Run => ({
    exitCode: 0,
    stdout: maskForms(row.repo)
      .map((form) => `::add-mask::${form}\n`)
      .join(""),
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

  test.each([
    { visibility: "public", row: rows[1] },
    { visibility: "private", row: rows[0] },
  ])(
    "a $visibility row resolves after one listing and no probe, every form masked before the name is written",
    ({ row }) => {
      expect(run({ ROW_KEY: keyOf(row.repo) })).toEqual(resolved(row));
    },
  );

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
    {
      reason: "an empty key",
      env: { ROW_KEY: "" },
      outcome: refused(2, "ROW_KEY must be set", before),
    },
    { reason: "no key", env: {}, outcome: refused(2, "ROW_KEY must be set", before) },
    {
      reason: "no token to key with",
      env: { ROW_KEY: keyOf(HIDDEN), PAT: undefined },
      outcome: refused(2, "PAT must be set", before),
    },
    {
      reason: "an empty token",
      env: { ROW_KEY: keyOf(HIDDEN), PAT: "" },
      outcome: refused(2, "PAT must be set", before),
    },
    {
      reason: "no run id to key with",
      env: { ROW_KEY: keyOf(HIDDEN), GITHUB_RUN_ID: undefined },
      outcome: refused(2, "GITHUB_RUN_ID must be set", before),
    },
    {
      reason: "no owner to list",
      env: { ROW_KEY: keyOf(HIDDEN), OWNER: undefined },
      outcome: refused(2, "OWNER must be set", before),
    },
    {
      reason: "no GITHUB_ENV to write the name to",
      env: { ROW_KEY: keyOf(HIDDEN), GITHUB_ENV: undefined },
      outcome: refused(2, "GITHUB_ENV must be set", before),
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
      env: { ROW_KEY: keyOf(HIDDEN), STUB_PAGES: join(root, "malformed.json") },
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
            outcome: refused(
              1,
              "git ls-remote for refs/heads/main could not answer (exit 128); refusing to guess: fatal: unable to access 'origin': Could not resolve host",
              [TIP_READ],
            ),
          },
          {
            reason: "no commit to judge newest against",
            env: { ROW_KEY: keyOf(HIDDEN), GITHUB_SHA: undefined },
            outcome: refused(2, "GITHUB_SHA must be set", []),
          },
        ]
      : []),
  ])("$reason: the row writes no TARGET and names no repository", ({ env, outcome }) => {
    const result = run(env);
    expect(result).toEqual(outcome);
    for (const channel of [result.stdout, result.stderr, result.env]) {
      for (const name of ["pub-repo", "hidden-server", "revoked-mid-run", "shapeless"]) {
        expect(channel.toLowerCase()).not.toContain(name);
      }
    }
  });
});

describe("resolveRow", () => {
  test("the listed repository carrying the key, at whatever index the listing put it", () => {
    expect(resolveRow(rows, keyOf(HIDDEN), keyOf)).toEqual({ target: rows[0] });
    expect(resolveRow([...rows].reverse(), keyOf(HIDDEN), keyOf)).toEqual({ target: rows[0] });
    expect(resolveRow([...rows].reverse(), keyOf(PUBLIC), keyOf)).toEqual({ target: rows[1] });
  });

  test("a key no listed repository carries is a refusal naming no repository", () => {
    expect(resolveRow(rows, keyOf(GONE), keyOf)).toEqual({
      refusal:
        "the row's key names no repository in the owner's listing: the fleet moved since the plan job ran (a repository revoked or renamed mid-run)",
    });
  });
});

describe("the matrix rows", () => {
  const text = JSON.stringify(matrixRows(rows, keyOf));

  test("one row per repository: its index and its grouped key, and the resolver reads every row back", () => {
    expect(matrixRows(rows, keyOf)).toEqual(
      rows.map((row, index) => ({ row: index, key: keyOf(row.repo) })),
    );
    for (const { row, key } of matrixRows(rows, keyOf)) {
      expect(key).toMatch(/^([0-9a-f]{3}~){21}[0-9a-f]$/);
      expect(resolveRow(rows, key, keyOf)).toEqual({ target: rows[row] });
    }
  });

  // The runner drops a job output that carries a masked value, so a private name the matrix can
  // spell fails every row of the run. Each case is a bare name maskForms registers.
  test.each([
    { name: "beef", repo: BEEF, how: "its raw digest spells it" },
    { name: "include", repo: INCLUDE, how: "the matrix's structural word" },
  ])("a private repository named $name ($how) is spelled nowhere in the matrix", ({ repo }) => {
    if (repo === BEEF) expect(keyOf(BEEF).replaceAll("~", "")).toContain("beef");
    for (const form of maskForms(repo)) expect(text).not.toContain(form);
  });

  test("the matrix splits at its punctuation into pieces under the mask floor, in an alphabet no slug or URL form shares", () => {
    expect(text).toMatch(/^[0-9a-z~"{}[\]:,]+$/);
    for (const piece of text.split(/["{}[\]:,~]/)) {
      expect(piece.length).toBeLessThan(MIN_MASKED_NAME);
    }
  });

  test("the key changes with the run and the token, so a public log links no two runs' rows", () => {
    expect(rowKeyOf(PAT, "1")(HIDDEN)).not.toBe(rowKeyOf(PAT, "2")(HIDDEN));
    expect(rowKeyOf("other", RUN_ID)(HIDDEN)).not.toBe(keyOf(HIDDEN));
  });
});
