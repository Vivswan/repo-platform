import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { argvStub } from "../../shared/argv_stub";
import { boundedSpawnSync } from "../../shared/bounded_spawn";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();
const SCRIPT = join(import.meta.dir, "../../../actions/dedupe-bun-lockfile/dedupe-bun-lockfile.ts");
const TOKEN = "ghs_secret_token_value";
const REPO = "Vivswan/managed";
const HEAD_REF = "dependabot/npm_and_yarn/zod-4.4.3";
const WARNING =
  "::warning::lockfile fix pushed without REPO_PLATFORM_TOKEN: the new head's pull_request run waits for approval. " +
  "Open it in the Actions tab and choose Approve and run, or push an empty commit. " +
  "Durable fix: register REPO_PLATFORM_TOKEN as a Dependabot secret " +
  "(Settings > Secrets and variables > Dependabot) so the push comes from the PAT and its run starts on its own.";

const LS_FILES = ["git", "ls-files", "-z", "--", "bun.lock", "*/bun.lock"];
const DIFF = ["git", "diff", "--quiet", "--", "bun.lock", "*/bun.lock"];
const CONFIG = [
  ["git", "config", "user.name", "github-actions[bot]"],
  ["git", "config", "user.email", "github-actions[bot]@users.noreply.github.com"],
];
const ADD = ["git", "add", "--", "bun.lock", "pkg/bun.lock"];
const COMMIT = [
  "git",
  "commit",
  "-m",
  "build(deps): dedupe bun lockfile",
  "-m",
  "[dependabot skip]",
];
const PUSH = [
  "git",
  "push",
  `https://x-access-token:${TOKEN}@github.com/${REPO}.git`,
  `HEAD:${HEAD_REF}`,
];
const install = (dir: string) => [
  "bun",
  "install",
  "--lockfile-only",
  "--ignore-scripts",
  "--cwd",
  dir,
];

interface Scenario {
  name: string;
  env: Record<string, string>;
  exitCode: number;
  git: string[][];
  bun: string[][];
  output: string;
  stdoutHas: string[];
  stdoutLacks: string[];
  lockfiles: Record<string, string>;
}

const REGENERATED = { "bun.lock": "regenerated\n", "pkg/bun.lock": "regenerated\n" };

const SCENARIOS: Scenario[] = [
  {
    name: "nothing changed: the regeneration runs, then no commit, push, or output",
    env: { STUB_DIFF_EXIT: "0", CAN_RETRIGGER: "true" },
    exitCode: 0,
    git: [LS_FILES, DIFF],
    bun: [install("."), install("pkg")],
    output: "",
    stdoutHas: ["lockfiles already deduped"],
    stdoutLacks: ["::warning::", "::error::"],
    lockfiles: REGENERATED,
  },
  {
    name: "changed with the PAT: commit and push, no warning, no output",
    env: { STUB_DIFF_EXIT: "1", CAN_RETRIGGER: "true" },
    exitCode: 0,
    git: [LS_FILES, DIFF, ...CONFIG, ADD, COMMIT, PUSH],
    bun: [install("."), install("pkg")],
    output: "",
    stdoutHas: [],
    stdoutLacks: ["::warning::", "::error::", "lockfiles already deduped"],
    lockfiles: REGENERATED,
  },
  {
    name: "changed with github.token: push, then the no_retrigger output and the warning",
    env: { STUB_DIFF_EXIT: "1", CAN_RETRIGGER: "false" },
    exitCode: 0,
    git: [LS_FILES, DIFF, ...CONFIG, ADD, COMMIT, PUSH],
    bun: [install("."), install("pkg")],
    output: "no_retrigger=true\n",
    stdoutHas: [WARNING],
    stdoutLacks: ["::error::"],
    lockfiles: REGENERATED,
  },
  {
    name: "a lockfile bun emptied is restored from the index before the diff",
    env: { STUB_DIFF_EXIT: "0", CAN_RETRIGGER: "true", STUB_BUN_EMPTIES: "pkg" },
    exitCode: 0,
    git: [LS_FILES, ["git", "checkout", "--", "pkg/bun.lock"], DIFF],
    bun: [install("."), install("pkg")],
    output: "",
    stdoutHas: ["lockfiles already deduped"],
    stdoutLacks: ["::warning::", "::error::"],
    lockfiles: { "bun.lock": "regenerated\n", "pkg/bun.lock": "restored\n" },
  },
  {
    name: "a failed install ends the run with its code before the diff",
    env: { STUB_DIFF_EXIT: "1", CAN_RETRIGGER: "true", STUB_BUN_EXIT: "3" },
    exitCode: 3,
    git: [LS_FILES],
    bun: [install(".")],
    output: "",
    stdoutHas: ["::error::bun install failed: exit 3"],
    stdoutLacks: ["::warning::"],
    lockfiles: { "bun.lock": "regenerated\n", "pkg/bun.lock": "old\n" },
  },
  {
    name: "a failed push fails the run and flags no retrigger",
    env: { STUB_DIFF_EXIT: "1", CAN_RETRIGGER: "false", STUB_PUSH_EXIT: "128" },
    exitCode: 128,
    git: [LS_FILES, DIFF, ...CONFIG, ADD, COMMIT, PUSH],
    bun: [install("."), install("pkg")],
    output: "",
    stdoutHas: ["::error::git push failed: exit 128"],
    stdoutLacks: ["::warning::"],
    lockfiles: REGENERATED,
  },
];

function plant(root: string) {
  const checkout = join(root, "checkout");
  mkdirSync(join(checkout, "pkg"), { recursive: true });
  writeFileSync(join(checkout, "bun.lock"), "old\n");
  writeFileSync(join(checkout, "pkg/bun.lock"), "old\n");
  const git = argvStub(root, "git", [
    'case "$1" in',
    "  ls-files) printf 'bun.lock\\0pkg/bun.lock\\0' ;;",
    '  diff) exit "$STUB_DIFF_EXIT" ;;',
    "  checkout) printf 'restored\\n' > \"$3\" ;;",
    '  push) exit "${STUB_PUSH_EXIT:-0}" ;;',
    "esac",
  ]);
  const bun = argvStub(root, "bun", [
    'dir="${@: -1}"',
    'case " ${STUB_BUN_EMPTIES:-} " in',
    '  *" $dir "*) ;;',
    "  *) printf 'regenerated\\n' > \"$dir/bun.lock\" ;;",
    "esac",
    'exit "${STUB_BUN_EXIT:-0}"',
  ]);
  return { checkout, git, bun };
}

describe("dedupe-bun-lockfile.ts", () => {
  test.each(SCENARIOS)("$name", (scenario) => {
    const root = temp.dir("dedupe-bun-lockfile-");
    const { checkout, git, bun } = plant(root);
    const output = join(root, "output");
    writeFileSync(output, "");
    const proc = boundedSpawnSync([process.execPath, SCRIPT], {
      cwd: checkout,
      env: {
        ...process.env,
        PATH: `${git.bin}:${process.env.PATH}`,
        TOKEN,
        HEAD_REF,
        GITHUB_REPOSITORY: REPO,
        GITHUB_OUTPUT: output,
        ...scenario.env,
      },
    });
    const log = proc.stdout + proc.stderr;
    expect({
      exitCode: proc.exitCode,
      git: git.calls(),
      bun: bun.calls(),
      output: readFileSync(output, "utf-8"),
      lockfiles: Object.fromEntries(
        Object.keys(scenario.lockfiles).map((path) => [
          path,
          readFileSync(join(checkout, path), "utf-8"),
        ]),
      ),
    }).toEqual({
      exitCode: scenario.exitCode,
      git: scenario.git,
      bun: scenario.bun,
      output: scenario.output,
      lockfiles: scenario.lockfiles,
    });
    for (const text of scenario.stdoutHas) expect(proc.stdout).toContain(text);
    for (const text of scenario.stdoutLacks) expect(log).not.toContain(text);
    // The push argv carries the token; nothing the script prints may.
    expect(log).not.toContain(TOKEN);
  });
});
