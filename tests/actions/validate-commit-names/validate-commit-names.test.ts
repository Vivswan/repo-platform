// The motivating refusal: a fleet committer read `style(contract,tests): ...` being refused as a validator bug,
// because the message showed only the generic grammar and not the one-scope rule that refused it.

import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { oneScopeRule, refusal } from "../../../actions/validate-commit-names/subject.ts";
import { boundedSpawnSync } from "../../shared/bounded_spawn.ts";
import { tempDirs } from "../../shared/temp_dir.ts";

const temp = tempDirs();
const root = join(import.meta.dir, "../../..");
const scratch = temp.dir("validate-commit-names-");
let serial = 0;

const COMMA_SCOPE_SUBJECT = "style(contract,tests): align the fixture layout";
const GENERIC_REASON = "not of the shape <type>(<scope>)?!?: <description>";

/** A zero `before` sha makes the validator read the payload's commit list, so no git repo is needed. */
function runValidator(subjects: string[]): { exitCode: number; stderr: string } {
  const eventPath = join(scratch, `event-${serial++}.json`);
  writeFileSync(
    eventPath,
    JSON.stringify({
      before: "0".repeat(40),
      after: "f".repeat(40),
      commits: subjects.map((message, index) => ({
        id: String(index + 1).padStart(40, "0"),
        message,
      })),
    }),
  );
  const { exitCode, stderr } = boundedSpawnSync(
    [process.execPath, "actions/validate-commit-names/validate-commit-names.ts"],
    {
      cwd: root,
      env: { PATH: process.env.PATH, GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: eventPath },
    },
  );
  return { exitCode, stderr };
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

describe("the CI validator's refusal message", () => {
  test("a comma-scoped subject is refused naming the one-scope rule beside the subject", () => {
    const { exitCode, stderr } = runValidator([COMMA_SCOPE_SUBJECT]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain(COMMA_SCOPE_SUBJECT);
    expect(stderr).toContain(oneScopeRule);
  });

  test("a non-conventional subject is refused for the grammar shape, not the one-scope rule", () => {
    const { exitCode, stderr } = runValidator(["wip: half-done things"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("wip: half-done things");
    expect(stderr).toContain(GENERIC_REASON);
    expect(stderr).not.toContain(oneScopeRule);
  });

  test("each refused subject carries its own reason in one run", () => {
    const { exitCode, stderr } = runValidator([
      "feat(sync): the accepted one",
      COMMA_SCOPE_SUBJECT,
      "wip: half-done things",
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).not.toContain("the accepted one");
    const lines = stderr.trimEnd().split("\n");
    const comma = lines.findIndex((line) => line.includes(COMMA_SCOPE_SUBJECT));
    const wip = lines.findIndex((line) => line.includes("wip: half-done things"));
    expect(lines[comma + 1]).toBe(`  ${oneScopeRule}`);
    expect(lines[wip + 1]).toBe(`  ${GENERIC_REASON}`);
  });

  test("control: a single-scope subject passes unchanged", () => {
    const { exitCode, stderr } = runValidator(["style(contract): align the fixture layout"]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
  });
});
