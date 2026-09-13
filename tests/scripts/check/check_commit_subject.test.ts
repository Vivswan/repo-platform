// The motivating landing, `docs(all-green,build-provenance): ...` with a comma in the scope, reached main and went
// red there because the pre-commit gates run before the message exists. The hook runs the CI action's commitlint
// over the message git is about to store, so every row is judged by the same config the commit-names step runs.

import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type BoundedSpawnResult, boundedSpawnSync } from "../../shared/bounded_spawn";
import { ONE_SCOPE, SUBJECT_CASE, TYPE_ENUM, verdict } from "../../shared/commitlint_verdict.ts";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();

const root = join(import.meta.dir, "../../..");
const bunExe = process.execPath;
const scratch = temp.dir("commit-subject-");
let serial = 0;

// The cleanup honors core.commentChar: pin the global and system homes shut and the char at command scope, so no
// developer or repository configuration can flip these verdicts.
const HOOK_ENV = {
  PATH: process.env.PATH,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "core.commentChar",
  GIT_CONFIG_VALUE_0: "#",
};

function messageFile(message: string): string {
  const messagePath = join(scratch, `msg-${serial++}.txt`);
  writeFileSync(messagePath, message);
  return messagePath;
}

function runHook(
  message: string,
  env: Record<string, string | undefined> = HOOK_ENV,
): BoundedSpawnResult {
  return boundedSpawnSync([bunExe, "scripts/check/check_commit_subject.ts", messageFile(message)], {
    cwd: root,
    env,
  });
}

const TYPE_EMPTY = "type may not be empty [type-empty]";
const SUBJECT_EMPTY = "subject may not be empty [subject-empty]";

const COMMA_SCOPE_SUBJECT =
  "docs(all-green,build-provenance): restructure both guides for skimmability";
const EDITOR_COMMENTS =
  "# Please enter the commit message for your changes. Lines starting\n# with '#' will be ignored.\n#\n# On branch main\n";
const SCISSORS =
  "# ------------------------ >8 ------------------------\n# Do not modify or remove the line above.\n";

// Both messages git could store are judged (the cleanup mode is unknowable in the hook): the comment-stripped one an
// editor commit stores, the whitespace-cleaned one `commit -m` stores. The gate passes when either passes.
const MESSAGES: [
  name: string,
  message: string,
  problems: string[],
  env?: Record<string, string | undefined>,
][] = [
  ["a Conventional Commit with a body", "feat(guards): close the gap\n\nbody\n", []],
  ["the editor template below the message", `feat: add setup flow\n\n${EDITOR_COMMENTS}`, []],
  [
    "a rebase squash message, comments first",
    "# This is a combination of 2 commits.\n# This is the 1st commit message:\n\nfeat: first\n\n# This is the commit message #2:\n\nfix: second\n",
    [],
  ],
  [
    "a commit -v buffer: the diff below the scissors line is not the message, however large",
    `feat: verbose\n${SCISSORS}diff --git a/x b/x\n+fix: Nope.\n+${"z".repeat(2 * 1024 * 1024)}\n`,
    [],
  ],
  [
    "a commit -v buffer under a letter as core.commentChar: git's scissors line still opens with that marker",
    `feat: verbose\n${SCISSORS.replaceAll("# ", "f ")}diff --git a/x b/x\n+${"z".repeat(2 * 1024 * 1024)}\n`,
    [],
    { ...HOOK_ENV, GIT_CONFIG_VALUE_0: "f" },
  ],
  [
    "a commit -v buffer under a three-character core.commentString: the diff is cut, not read as a body",
    `wip: verbose\n${SCISSORS.replaceAll("# ", "### ")}diff --git a/x b/x\n+zzz\n`,
    [TYPE_ENUM],
    {
      ...HOOK_ENV,
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_1: "core.commentString",
      GIT_CONFIG_VALUE_1: "###",
    },
  ],
  [
    "a scissors line after a bare CR is not a line to git: the subject keeps it and CI refuses it",
    "fix: valid\rf ------------------------ >8 ------------------------\n",
    [SUBJECT_EMPTY, TYPE_EMPTY],
  ],
  [
    "a subject that is the scissors text itself",
    "fix: ------------------------ >8 ------------------------\n",
    [],
  ],
  ["an unwrapped 150-character body line", `fix: x\n\n${"y".repeat(150)}\n`, []],
  ["a merge subject", "Merge branch 'main' into guards/commit-subject\n", []],
  [
    "a hostile core.commentChar eats the subject of the stripped candidate; `commit -m` stores the raw one",
    "fix: x\n\nbody text\n",
    [],
    { ...HOOK_ENV, GIT_CONFIG_VALUE_0: "f" },
  ],
  [
    "a hostile core.commentChar leaves a Unicode-whitespace line as the stripped candidate; the raw one is judged",
    "fix: x\n\n\u00a0\n",
    [],
    { ...HOOK_ENV, GIT_CONFIG_VALUE_0: "f" },
  ],
  ["a comma-scoped subject", `${COMMA_SCOPE_SUBJECT}\n\nbody text\n`, [ONE_SCOPE]],
  ["a Sentence-case description", "fix: Repair installer\n", [SUBJECT_CASE]],
  [
    "a subject the editor template follows, refused once, not once per candidate",
    `wip: x\n\n${EDITOR_COMMENTS}`,
    [TYPE_ENUM],
  ],
  [
    "a body line shaped like a merge subject exempts nothing",
    "docs(a,b): x\n\nMerge branch 'topic' into main\n",
    [ONE_SCOPE],
  ],
  [
    "a merge line after a bare CR (a line terminator to a JavaScript regex, not to git) exempts nothing",
    "docs(a,b): x\rMerge branch topic\n",
    [SUBJECT_EMPTY, TYPE_EMPTY],
  ],
  ["a comment line `commit -m` would store as the subject", "# wip\n", [SUBJECT_EMPTY, TYPE_EMPTY]],
  [
    "an aborted editor (only comments)",
    "# aborted\n#\n",
    [SUBJECT_EMPTY, TYPE_EMPTY, "body must have leading blank line [body-leading-blank]"],
  ],
];

describe("the commit-msg gate (scripts/check/check_commit_subject.ts)", () => {
  for (const [name, message, expected, env] of MESSAGES) {
    test(`${expected.length === 0 ? "accepted" : "refused"}: ${name}`, () => {
      const result = runHook(message, env);
      expect(verdict(result)).toEqual({
        exitCode: expected.length === 0 ? 0 : 1,
        stderr: "",
        problems: expected,
      });
      if (expected.length === 0) expect(result.stdout).toBe("");
    });
  }

  test("a missing message-file argument is a usage error and a blank file a refusal, never a pass", () => {
    const usage = boundedSpawnSync([bunExe, "scripts/check/check_commit_subject.ts"], {
      cwd: root,
    });
    expect([usage.exitCode, runHook("\n\n")]).toEqual([
      2,
      { exitCode: 1, stdout: "commit-subject: REFUSED, the message is empty\n", stderr: "" },
    ]);
  });

  test("the .husky/commit-msg wiring dispatches to the gate: a refused subject blocks the commit", () => {
    const wiring = (message: string): number =>
      boundedSpawnSync(["sh", ".husky/commit-msg", messageFile(message)], {
        cwd: root,
        env: HOOK_ENV,
      }).exitCode;
    expect([wiring(`${COMMA_SCOPE_SUBJECT}\n`), wiring("feat: add setup flow\n")]).toEqual([1, 0]);
  });
});
