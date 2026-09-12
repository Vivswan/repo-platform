// The apply job's resolver is the mask boundary: run as the workflow runs it, its stdout is nothing
// but ::add-mask:: commands for every form of the name, the name leaves through GITHUB_ENV alone,
// and every refusal names no repository.

import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { maskForms } from "../../.github/scripts/shared/mask.ts";
import { rowKeyOf } from "../../.github/scripts/sync/resolve_row.ts";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();
const SCRIPT = join(import.meta.dir, "../../.github/scripts/fleet/resolve_settings_target.ts");
const PAT = "stub-token";
const RUN_ID = "4242";
const keyOf = rowKeyOf(PAT, RUN_ID);
const HIDDEN = "Vivswan/Hidden-Server";
const PUBLIC = "Vivswan/steady";
/** Selected by the plan, revoked from the token's grant before this row ran: in no listing. */
const GONE = "Vivswan/Revoked-mid-run";

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
  env: string;
}

describe("resolve_settings_target.ts", () => {
  const root = temp.dir("resolve-settings-target-");
  const bin = join(root, "bin");

  // The owner's listing as the stub `gh` answers user/repos: the two targets, an archived and a
  // read-only repository the listing drops, and a cross-owner one the owner filter drops.
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
      entry("Vivswan/archived-out", { archived: true }),
      entry("Vivswan/read-only", { permissions: { push: false } }),
      entry("Other/cross-owner"),
    ].join(",")}]]`;
    writeFileSync(join(root, "pages.json"), `${pages}\n`);
    writeFileSync(
      join(bin, "gh"),
      [
        "#!/usr/bin/env bash",
        'if [ -n "$STUB_FAIL_DISCOVERY" ]; then',
        '  echo "HTTP 500 from stub" >&2',
        "  exit 1",
        "fi",
        'cat "$STUB_PAGES"',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
  });

  /** The workflow's env for the step; a case sets a variable to undefined to leave it unset. */
  function run(env: Record<string, string | undefined>): Run {
    const work = temp.dir("resolve-settings-target-run-");
    const envFile = join(work, "env.txt");
    writeFileSync(envFile, "");
    const merged: Record<string, string | undefined> = {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: process.env.HOME,
      STUB_PAGES: join(root, "pages.json"),
      GITHUB_ENV: envFile,
      GITHUB_RUN_ID: RUN_ID,
      PAT,
      OWNER: "Vivswan",
      ...env,
    };
    const result = boundedSpawnSync(["bun", SCRIPT], {
      env: Object.fromEntries(
        Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
    });
    return { ...result, env: readFileSync(envFile, "utf-8") };
  }

  const resolved = (repo: string): Run => ({
    exitCode: 0,
    stdout: maskForms(repo)
      .map((form) => `::add-mask::${form}\n`)
      .join(""),
    stderr: "",
    env: `TARGET=${repo}\n`,
  });
  const refused = (exitCode: number, error: string): Run => ({
    exitCode,
    stdout: `::error::${error}\n`,
    stderr: "",
    env: "",
  });
  const MOVED =
    "the row no longer names a repository the plan selected: the selection changed since the plan job ran (the fleet or a repository's registration moved mid-run); re-run the workflow";

  test.each([
    { visibility: "public", repo: PUBLIC },
    { visibility: "private", repo: HIDDEN },
  ])(
    "a $visibility row resolves to its slug, every form masked before the name is written",
    ({ repo }) => {
      expect(run({ ROW_KEY: keyOf(repo) })).toEqual(resolved(repo));
    },
  );

  test("a private row's masks cover the slug, the bare name, the URLs, and their lowercase forms", () => {
    const result = run({ ROW_KEY: keyOf(HIDDEN) });
    for (const form of [
      HIDDEN,
      HIDDEN.toLowerCase(),
      "Hidden-Server",
      "hidden-server",
      `https://github.com/${HIDDEN}`,
      `https://github.com/${HIDDEN}.git`,
      `git@github.com:${HIDDEN}.git`,
    ]) {
      expect(result.stdout).toContain(`::add-mask::${form}\n`);
    }
  });

  test.each<{ reason: string; env: Record<string, string | undefined>; outcome: Run }>([
    {
      reason: "a row whose repository left the token's grant since the plan",
      env: { ROW_KEY: keyOf(GONE) },
      outcome: refused(1, MOVED),
    },
    {
      reason: "a key under another run's id",
      env: { ROW_KEY: rowKeyOf(PAT, "1")(PUBLIC) },
      outcome: refused(1, MOVED),
    },
    {
      reason: "a key under another token",
      env: { ROW_KEY: rowKeyOf("other", RUN_ID)(PUBLIC) },
      outcome: refused(1, MOVED),
    },
    {
      reason: "a bare slug where the key should be",
      env: { ROW_KEY: HIDDEN },
      outcome: refused(1, MOVED),
    },
    { reason: "an empty key", env: { ROW_KEY: "" }, outcome: refused(2, "ROW_KEY must be set") },
    { reason: "no key", env: {}, outcome: refused(2, "ROW_KEY must be set") },
    {
      reason: "no token to key with",
      env: { ROW_KEY: keyOf(HIDDEN), PAT: undefined },
      outcome: refused(2, "PAT must be set"),
    },
    {
      reason: "no run id to key with",
      env: { ROW_KEY: keyOf(HIDDEN), GITHUB_RUN_ID: undefined },
      outcome: refused(2, "GITHUB_RUN_ID must be set"),
    },
    {
      reason: "no owner to list",
      env: { ROW_KEY: keyOf(HIDDEN), OWNER: undefined },
      outcome: refused(2, "OWNER must be set"),
    },
    {
      reason: "no GITHUB_ENV to write the name to",
      env: { ROW_KEY: keyOf(HIDDEN), GITHUB_ENV: undefined },
      outcome: refused(2, "GITHUB_ENV must be set"),
    },
    {
      reason: "a listing that fails (gh's own stderr, no row resolved)",
      env: { ROW_KEY: keyOf(HIDDEN), STUB_FAIL_DISCOVERY: "1" },
      outcome: { exitCode: 1, stdout: "", stderr: "HTTP 500 from stub\n", env: "" },
    },
  ])("$reason is refused without naming a repository", ({ env, outcome }) => {
    const result = run(env);
    expect(result).toEqual(outcome);
    for (const channel of [result.stdout, result.stderr, result.env]) {
      for (const name of ["steady", "hidden-server", "revoked-mid-run"]) {
        expect(channel.toLowerCase()).not.toContain(name);
      }
    }
  });
});
