// `bun run validate` is the gate every local `bun run check` ends on, so what it runs and what it leaves behind are
// pinned here on a checkout of this suite's making: the check.ts of the recorded commit's tree (not the checkout's), the
// hygiene validator after it, and no extract left on any exit.

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { MANIFEST_NAME, PLATFORM_SLUG } from "../../actions/shared/platform";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { fixtureGit, fixtureGitEnv } from "../shared/fixture_git";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();
const WRAPPER = join(import.meta.dir, "../../scripts/validate_self.ts");
const CHECK = "actions/validate-managed-files/check.ts";
const HYGIENE = "actions/validate-managed-files/validator/validate_managed_files.ts";

const stub = (name: string) => `import { writeFileSync } from "node:fs";
writeFileSync(process.env.${name}_RAN, JSON.stringify({ dir: import.meta.dir, argv: process.argv.slice(2) }));
process.exit(Number(process.env.${name}_EXIT ?? "0"));
`;

interface Ran {
  dir: string;
  argv: string[];
}

/** A checkout whose one commit carries the stand-ins, its manifest recording that commit (or not). */
function checkout(
  stamped: boolean,
  packageJson = '{"name": "fake", "private": true}\n',
): { root: string; commit: string } {
  // Resolved as a script's import.meta.dir is (macOS's /var is /private/var), so the stand-ins' records compare whole.
  const root = realpathSync(temp.dir("validate-self-"));
  const files: Record<string, string> = {
    "package.json": packageJson,
    [CHECK]: stub("CHECK"),
    [HYGIENE]: stub("HYGIENE"),
  };
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  fixtureGit(root, ["init", "-q", "-b", "main"]);
  fixtureGit(root, ["add", "-A"]);
  fixtureGit(root, ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-q", "-m", "recorded"]);
  const commit = fixtureGit(root, ["rev-parse", "HEAD"]);
  const self = stamped
    ? `{"class": "managed", "hash": null, "commit": "${commit}"}`
    : '{"class": "managed", "hash": null}';
  mkdirSync(join(root, dirname(MANIFEST_NAME)), { recursive: true });
  writeFileSync(
    join(root, MANIFEST_NAME),
    `{\n  "files": {\n    ${JSON.stringify(MANIFEST_NAME)}: ${self}\n  }\n}\n`,
  );
  return { root, commit };
}

function validate(root: string, env: Record<string, string>) {
  const scratch = temp.dir("validate-self-scratch-");
  const ran = { check: join(scratch, "check.json"), hygiene: join(scratch, "hygiene.json") };
  const run = boundedSpawnSync([process.execPath, WRAPPER, root], {
    cwd: root,
    env: {
      ...fixtureGitEnv(),
      TMPDIR: scratch,
      CHECK_RAN: ran.check,
      HYGIENE_RAN: ran.hygiene,
      ...env,
    },
    timeoutMs: 60_000,
  });
  const read = (path: string): Ran | null =>
    existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Ran) : null;
  return {
    exitCode: run.exitCode,
    stderr: run.stderr,
    check: read(ran.check),
    hygiene: read(ran.hygiene),
    // The stand-ins' own records are the only files the scratch may hold once the extract is gone.
    leftovers: readdirSync(scratch).filter((name) => !name.endsWith(".json")),
  };
}

describe("bun run validate", () => {
  test.each<{ reason: string; env: Record<string, string>; exitCode: number }>([
    { reason: "both pass", env: {}, exitCode: 0 },
    {
      reason: "the recorded commit's check finds a difference",
      env: { CHECK_EXIT: "1" },
      exitCode: 1,
    },
    { reason: "the writer at the recorded commit refused", env: { CHECK_EXIT: "2" }, exitCode: 2 },
    { reason: "a hygiene finding", env: { HYGIENE_EXIT: "1" }, exitCode: 1 },
  ])(
    "runs the recorded commit's check from its extract, then the checkout's hygiene validator, and removes the extract: $reason",
    ({ env, exitCode }) => {
      const { root, commit } = checkout(true);
      const run = validate(root, env);
      expect(run.exitCode).toBe(exitCode);
      expect(run.leftovers).toEqual([]);
      expect(run.check?.argv).toEqual([
        "--target",
        root,
        "--repository",
        PLATFORM_SLUG,
        "--private",
        "false",
        "--build",
        commit,
      ]);
      // Under the scratch TMPDIR and not under the checkout: the extract's copy ran, not the checkout's.
      expect(run.check?.dir.startsWith(root)).toBe(false);
      expect(run.check?.dir.endsWith(`/tree/${dirname(CHECK)}`)).toBe(true);
      expect(run.hygiene).toEqual({ dir: join(root, dirname(HYGIENE)), argv: ["--self", root] });
    },
  );

  // must() in proc.ts exits the process on a failed command, which skips a finally: the extract has to be removed by a
  // path that exit cannot bypass.
  test("a recorded commit whose dependencies will not install fails with nothing left in the scratch", () => {
    const { root } = checkout(true, "{");
    const run = validate(root, {});
    expect([run.exitCode === 0, run.check, run.hygiene, run.leftovers]).toEqual([
      false,
      null,
      null,
      [],
    ]);
  });

  test("a manifest without the commit fails with the fleet action's message before anything runs", () => {
    const { root } = checkout(false);
    const run = validate(root, {});
    expect([run.exitCode, run.stderr, run.check, run.hygiene, run.leftovers]).toEqual([
      1,
      "error: no synced commit recorded; merge the pending sync PR or dispatch a sync\n",
      null,
      null,
      [],
    ]);
  });
});
