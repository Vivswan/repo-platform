// The motivating landing, `docs(all-green,build-provenance): ...` with a comma in the scope,
// reached main and went red there because the pre-commit gates run before the message exists.
// The equivalence table runs BOTH real consumers as subprocesses, so a fork of the shared grammar
// (actions/validate-commit-names/subject.ts) reds here even though each consumer stays green alone.

import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { oneScopeRule, refusal } from "../../../actions/validate-commit-names/subject.ts";
import { candidateSubjects } from "../../../scripts/check/check_commit_subject.ts";
import { type BoundedSpawnResult, boundedSpawnSync } from "../../shared/bounded_spawn";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();

const root = join(import.meta.dir, "../../..");
const bunExe = process.execPath;
const scratch = temp.dir("commit-subject-");
let serial = 0;

// The hook shells out to `git stripspace`, whose comment handling reads
// core.commentChar from git config: pin the global and system homes shut
// and pin commentChar at command scope (GIT_CONFIG_*, which outranks even
// repo-local config) so no developer or repository configuration can flip
// these verdicts.
const GIT_PINS = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "core.commentChar",
  GIT_CONFIG_VALUE_0: "#",
};
Object.assign(process.env, GIT_PINS);
const HOOK_ENV = { PATH: process.env.PATH, ...GIT_PINS };

function runHook(
  message: string,
  env: Record<string, string | undefined> = HOOK_ENV,
): BoundedSpawnResult {
  const messagePath = join(scratch, `msg-${serial++}.txt`);
  writeFileSync(messagePath, message);
  return boundedSpawnSync([bunExe, "scripts/check/check_commit_subject.ts", messagePath], {
    cwd: root,
    env,
  });
}

/** Run the way husky's shim runs the hook: `sh` from the repo root, the message path as $1. */
function runWiring(message: string): number {
  const messagePath = join(scratch, `msg-${serial++}.txt`);
  writeFileSync(messagePath, message);
  return boundedSpawnSync(["sh", ".husky/commit-msg", messagePath], { cwd: root, env: HOOK_ENV })
    .exitCode;
}

/** A zero `before` sha makes the validator read the payload's commit list, so no git repo is needed. */
function runCiValidator(subject: string): BoundedSpawnResult {
  const eventPath = join(scratch, `event-${serial++}.json`);
  writeFileSync(
    eventPath,
    JSON.stringify({
      before: "0".repeat(40),
      after: "f".repeat(40),
      commits: [{ id: "f".repeat(40), message: subject }],
    }),
  );
  return boundedSpawnSync([bunExe, "actions/validate-commit-names/validate-commit-names.ts"], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      GITHUB_EVENT_NAME: "push",
      GITHUB_EVENT_PATH: eventPath,
    },
  });
}

function refused(rows: [subject: string, reason: string][]): string {
  return `commit-subject: REFUSED\n${rows
    .map(([subject, reason]) => `- ${JSON.stringify(subject)}\n  ${reason}\n`)
    .join("")}`;
}

// The header is the action test's to pin; from the row on the whole tail is compared, so a line one consumer
// alone adds beneath the reason reds here instead of slipping past a per-line pick.
function ciRefused(subject: string, reason: string): string {
  return `\n- fffffff ${subject}\n  ${reason}\n`;
}

const COMMA_SCOPE_SUBJECT =
  "docs(all-green,build-provenance): restructure both guides for skimmability";

const TABLE: { subject: string; verdict: "pass" | "refuse" }[] = [
  { subject: "feat: add setup flow", verdict: "pass" },
  { subject: "chore(main): release 3.0.0", verdict: "pass" },
  { subject: "feat(sync/fleet): split the rehearsal tree", verdict: "pass" },
  { subject: "fix(proc.ts): hand every spawn live env", verdict: "pass" },
  { subject: "feat!: simplify bootstrap", verdict: "pass" },
  { subject: "refactor(build)!: retire the snapshot", verdict: "pass" },
  { subject: "style(contract): align the fixture layout", verdict: "pass" },
  { subject: COMMA_SCOPE_SUBJECT, verdict: "refuse" }, // the motivating landing
  { subject: "style(contract,tests): align the fixture layout", verdict: "refuse" },
  { subject: "docs(all-green, build-provenance): restructure both guides", verdict: "refuse" },
  { subject: "docs(a , b): update guides", verdict: "refuse" },
  { subject: "docs(a,  b): update guides", verdict: "refuse" },
  { subject: "fix(a,b,c): three scopes", verdict: "refuse" },
  { subject: "feat(sync,writer)!: cut the compat era", verdict: "refuse" },
  { subject: "wip: half-done things", verdict: "refuse" },
  { subject: "feat add setup flow", verdict: "refuse" },
  { subject: "feat:", verdict: "refuse" },
  { subject: "feat(): empty scope", verdict: "refuse" },
  { subject: "feat(,): only a separator", verdict: "refuse" },
  { subject: "feat(a b): space in scope", verdict: "refuse" },
  { subject: "Feat: capitalized type", verdict: "refuse" },
  { subject: "Feat(x,y): capitalized type with a comma", verdict: "refuse" },
  { subject: "feat(x,y) missing colon", verdict: "refuse" },
  { subject: "Merge pull request #12 from Vivswan/feature", verdict: "pass" }, // merge exemption
  { subject: "Merge branch 'main' into guards/commit-subject", verdict: "pass" },
  { subject: "Merge remote-tracking branch 'origin/main'", verdict: "pass" },
];

describe("the commit-msg gate (scripts/check/check_commit_subject.ts)", () => {
  test("a comma-scoped subject is REFUSED by the commit-msg gate, naming the subject", () => {
    const { exitCode, stderr } = runHook(`${COMMA_SCOPE_SUBJECT}\n\nbody text\n`);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain(COMMA_SCOPE_SUBJECT);
  });

  test("a valid Conventional Commit subject passes the commit-msg gate", () => {
    expect(runHook("feat(guards): close the commit-subject gap\n\nbody\n").exitCode).toBe(0);
  });

  test("the gate judges the post-cleanup subject: a leading editor comment block is not the subject", () => {
    const message = "# Please enter the commit message.\n#\n\nfeat: add setup flow\n";
    expect(runHook(message).exitCode).toBe(0);
  });

  test("an empty message (everything commented out) is refused, not crashed on", () => {
    const { exitCode, stderr } = runHook("# aborted\n#\n");
    expect(exitCode).toBe(1);
    expect(stderr).toContain('""');
  });

  test("a hostile core.commentChar cannot false-refuse a valid subject: the raw candidate still passes", () => {
    // With commentChar=f, stripspace eats `feat: ...` lines wholesale;
    // `git commit -m` (whitespace cleanup) would still store the subject
    // verbatim, so the gate must let the raw candidate carry it.
    const env = { ...HOOK_ENV, GIT_CONFIG_VALUE_0: "f" };
    expect(runHook("feat: valid under any commentChar\n", env).exitCode).toBe(0);
  });

  test("a missing message-file argument is a usage error, never a pass", () => {
    const { exitCode } = boundedSpawnSync([bunExe, "scripts/check/check_commit_subject.ts"], {
      cwd: root,
    });
    expect(exitCode).toBe(2);
  });
});

describe("candidateSubjects", () => {
  test("a commit -v buffer's subject is judged, never the diff below the scissors line", () => {
    const raw =
      "feat: add setup flow\n# ------------------------ >8 ------------------------\ndiff --git a/x b/x\n";
    expect(candidateSubjects(raw)).toEqual(["feat: add setup flow"]);
  });

  test("a multi-megabyte -v diff does not burst the cleanup child's pipe", () => {
    const raw = `feat: add setup flow\n# ------------------------ >8 ------------------------\n${"x".repeat(4 * 1024 * 1024)}\n`;
    expect(candidateSubjects(raw)[0]).toBe("feat: add setup flow");
  });

  test("both cleanup modes' candidates, deduplicated", () => {
    // -m keeps the comment line (whitespace cleanup); an editor commit
    // strips it - the gate judges both possible stored subjects.
    expect(candidateSubjects("# c\n\nfeat: x\n")).toEqual(["# c", "feat: x"]);
    expect(candidateSubjects("\n  feat: x  \nbody\n")).toEqual(["feat: x"]);
    expect(candidateSubjects("# only comments\n#\n")).toEqual(["# only comments", ""]);
  });
});

describe("single source: the hook and the CI validator judge identically", () => {
  test("the grammar's bytes live ONLY in subject.ts - both consumers import it, neither redefines it", () => {
    const shared = readFileSync(join(root, "actions/validate-commit-names/subject.ts"), "utf-8");
    const hook = readFileSync(join(root, "scripts/check/check_commit_subject.ts"), "utf-8");
    const ci = readFileSync(
      join(root, "actions/validate-commit-names/validate-commit-names.ts"),
      "utf-8",
    );
    expect(shared).toContain("A-Za-z0-9._/-");
    expect(hook).toContain('from "../../actions/validate-commit-names/subject.ts"');
    expect(ci).toContain('from "./subject.ts"');
    for (const consumer of [hook, ci]) {
      // No character class, type list, merge-subject prefix, or fresh
      // regex construction outside the shared module: a duplicated (and
      // then forkable) grammar reds here even for subjects no table row
      // covers.
      expect(consumer).not.toMatch(/A-Za-z0-9|new RegExp|allowedTypes\s*=|Merge \(pull request/);
    }
  });

  // tests/actions/validate-commit-names pins what the shared reasons say; this file pins that both consumers print them.
  for (const { subject, verdict } of TABLE) {
    test(`${verdict.toUpperCase()}: ${subject}`, () => {
      const hook = runHook(`${subject}\n`);
      const ci = runCiValidator(subject);
      if (verdict === "pass") {
        expect(hook).toEqual({ exitCode: 0, stdout: "", stderr: "" });
        expect(ci.exitCode).toBe(0);
        expect(ci.stderr).toBe("");
        return;
      }
      const reason = `${refusal(subject)}`;
      expect(hook).toEqual({ exitCode: 1, stdout: "", stderr: refused([[subject, reason]]) });
      expect(ci.exitCode).toBe(1);
      expect(ci.stderr).toEndWith(ciRefused(subject, reason));
    });
  }

  test("a message whose two cleanup candidates differ lists each with its own reason", () => {
    const comment = "# wip: a comment kept by -m";
    const { exitCode, stderr } = runHook(`${comment}\n\nfix(a,b): two scopes\n`);
    expect(exitCode).toBe(1);
    expect(stderr).toBe(
      refused([
        [comment, refusal(comment) as string],
        ["fix(a,b): two scopes", oneScopeRule],
      ]),
    );
  });
});

describe("the .husky/commit-msg wiring", () => {
  test("the .husky/commit-msg wiring dispatches to the gate - a refused subject blocks the commit", () => {
    expect(runWiring(`${COMMA_SCOPE_SUBJECT}\n`)).not.toBe(0);
    expect(runWiring("feat: add setup flow\n")).toBe(0);
  });
});
