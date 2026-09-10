// report_skipped_target.ts: the public notice for a skipped settings
// target, one fixed sentence per skip reason, naming only the row's hint.
// The expected texts are typed here from the workflow's landed wording,
// so a reworded script shows as a diff.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { boundedSpawnSync } from "../shared/bounded_spawn";

const script = join(import.meta.dir, "../../.github/scripts/fleet/report_skipped_target.ts");

function run(env: Record<string, string | undefined>) {
  const proc = boundedSpawnSync(["bun", script], {
    env: { ...process.env, HINT: "h**-s**r", SKIP_REASON: "", ...env },
  });
  return { exitCode: proc.exitCode, stdout: proc.stdout, stderr: proc.stderr };
}

describe("report_skipped_target.ts", () => {
  test.each([
    {
      reason: "the target left management",
      env: { SKIP_REASON: "left-management" },
      notice:
        "settings apply skipped for h**-s**r: it carries no .repo-platform.yml at the revision this run read (it left management), so its settings are not managed here any more.",
    },
    {
      reason: "the target is not onboarded (no settings.yml yet)",
      env: { SKIP_REASON: "not-onboarded" },
      notice:
        "settings apply skipped for h**-s**r: it has no .github/settings.yml yet, so there is nothing to layer over the fleet defaults. The settings starter seeds the file on its next template sync.",
    },
    {
      reason: "no reason published (the branch moved)",
      env: { SKIP_REASON: "" },
      notice:
        "settings apply skipped for h**-s**r: its default branch moved while this run was computing its settings, so the apply was skipped rather than applied from a stale snapshot. The next run reads the new revision.",
    },
    {
      // An unknown category is never echoed: the notice is public and the
      // reason rides a step output, so only the fixed sentences print.
      reason: "an unknown reason reads as the moved skip",
      env: { SKIP_REASON: "something-else" },
      notice:
        "settings apply skipped for h**-s**r: its default branch moved while this run was computing its settings, so the apply was skipped rather than applied from a stale snapshot. The next run reads the new revision.",
    },
  ])("$reason prints exactly one public notice", ({ env, notice }) => {
    expect(run(env)).toEqual({ exitCode: 0, stdout: `::notice::${notice}\n`, stderr: "" });
  });

  test("a missing HINT is a misconfiguration, not a notice about nothing", () => {
    expect(run({ HINT: "" })).toEqual({
      exitCode: 2,
      stdout: "::error::HINT must be set\n",
      stderr: "",
    });
  });
});
