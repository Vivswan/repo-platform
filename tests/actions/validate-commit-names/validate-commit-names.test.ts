// The motivating refusal: a fleet committer read `style(contract,tests): ...` being refused as a validator bug,
// because the message showed only the generic grammar and not the one-scope rule that refused it.

import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { oneScopeRule, refusal } from "../../../actions/validate-commit-names/subject.ts";
import { type BoundedSpawnResult, boundedSpawnSync } from "../../shared/bounded_spawn.ts";
import { tempDirs } from "../../shared/temp_dir.ts";

const temp = tempDirs();
const root = join(import.meta.dir, "../../..");
const scratch = temp.dir("validate-commit-names-");
let serial = 0;

const COMMA_SCOPE_SUBJECT = "style(contract,tests): align the fixture layout";
const GENERIC_REASON = "not of the shape <type>(<scope>)?!?: <description>";

// A zero `before` sha makes the validator read the payload's commit list, so no git repo is needed.
// Each commit's id is its 1-based position repeated, so `2222222` in an expected stderr names the second subject.
function runValidator(subjects: string[]): BoundedSpawnResult {
  const eventPath = join(scratch, `event-${serial++}.json`);
  writeFileSync(
    eventPath,
    JSON.stringify({
      before: "0".repeat(40),
      after: "f".repeat(40),
      commits: subjects.map((message, index) => ({
        id: String(index + 1).repeat(40),
        message,
      })),
    }),
  );
  return boundedSpawnSync(
    [process.execPath, "actions/validate-commit-names/validate-commit-names.ts"],
    {
      cwd: root,
      env: { PATH: process.env.PATH, GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: eventPath },
    },
  );
}

const REFUSALS: { subject: string; reason: string | undefined }[] = [
  { subject: "style(contract): align the fixture layout", reason: undefined },
  { subject: "feat!: simplify bootstrap", reason: undefined },
  // Any comma list a committer would write, whatever the spacing around the separators.
  { subject: COMMA_SCOPE_SUBJECT, reason: oneScopeRule },
  { subject: "docs(all-green, build-provenance): restructure both guides", reason: oneScopeRule },
  { subject: "docs(a , b): update guides", reason: oneScopeRule },
  { subject: "docs(a,  b): update guides", reason: oneScopeRule },
  { subject: "fix(a,b,c): three scopes", reason: oneScopeRule },
  { subject: "feat(sync,writer)!: cut the compat era", reason: oneScopeRule },
  // Refused for something other than the comma: the grammar shape, never the one-scope rule.
  { subject: "wip: half-done things", reason: GENERIC_REASON },
  { subject: "feat(a b): space in scope", reason: GENERIC_REASON },
  { subject: "feat(): empty scope", reason: GENERIC_REASON },
  { subject: "feat(,): only a separator", reason: GENERIC_REASON },
  { subject: "Feat(x,y): capitalized type with a comma", reason: GENERIC_REASON },
  { subject: "feat(x,y) missing colon", reason: GENERIC_REASON },
];

describe("refusal", () => {
  for (const { subject, reason } of REFUSALS) {
    test(`${reason ?? "accepted"}: ${subject}`, () => {
      expect(refusal(subject)).toBe(reason);
    });
  }
});

const REFUSAL_HEADER =
  "Commit subjects must be Conventional Commits.\n" +
  "Examples: `feat: add setup flow`, `fix: repair installer`, `feat!: simplify bootstrap`, `chore(main): release 3.0.0`.\n" +
  "\n";

const RUNS: { name: string; subjects: string[]; outcome: BoundedSpawnResult }[] = [
  {
    name: "a single-scope subject passes with nothing on stderr",
    subjects: ["style(contract): align the fixture layout"],
    outcome: { exitCode: 0, stdout: "Checked 1 non-merge commit subject(s).\n", stderr: "" },
  },
  {
    name: "a comma-scoped subject is refused naming the one-scope rule beside the subject",
    subjects: [COMMA_SCOPE_SUBJECT],
    outcome: {
      exitCode: 1,
      stdout: "Checked 1 non-merge commit subject(s).\n",
      stderr: `${REFUSAL_HEADER}- 1111111 ${COMMA_SCOPE_SUBJECT}\n  ${oneScopeRule}\n`,
    },
  },
  {
    name: "a non-conventional subject is refused for the grammar shape, not the one-scope rule",
    subjects: ["wip: half-done things"],
    outcome: {
      exitCode: 1,
      stdout: "Checked 1 non-merge commit subject(s).\n",
      stderr: `${REFUSAL_HEADER}- 1111111 wip: half-done things\n  ${GENERIC_REASON}\n`,
    },
  },
  {
    name: "each refused subject carries its own reason in one run and the accepted one is not listed",
    subjects: ["feat(sync): the accepted one", COMMA_SCOPE_SUBJECT, "wip: half-done things"],
    outcome: {
      exitCode: 1,
      stdout: "Checked 3 non-merge commit subject(s).\n",
      stderr:
        `${REFUSAL_HEADER}- 2222222 ${COMMA_SCOPE_SUBJECT}\n  ${oneScopeRule}\n` +
        `- 3333333 wip: half-done things\n  ${GENERIC_REASON}\n`,
    },
  },
];

describe("the CI validator's whole outcome", () => {
  for (const { name, subjects, outcome } of RUNS) {
    test(name, () => {
      expect(runValidator(subjects)).toEqual(outcome);
    });
  }
});
