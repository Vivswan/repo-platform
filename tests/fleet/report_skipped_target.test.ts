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
    env: { ...process.env, HINT: "h**-s**r", RENDER_SKIPPED: "", MERGE_SKIPPED: "", ...env },
  });
  return { exitCode: proc.exitCode, stdout: proc.stdout, stderr: proc.stderr };
}

describe("report_skipped_target.ts", () => {
  test.each([
    {
      reason: "the render skipped (the target left management)",
      env: { RENDER_SKIPPED: "true", MERGE_SKIPPED: "" },
      notice:
        "settings apply skipped for h**-s**r: it carries no .repo-platform.yml at the revision this run read (it left management), so its settings are not managed here any more.",
    },
    {
      reason: "the merge skipped (no settings.yml yet)",
      env: { RENDER_SKIPPED: "false", MERGE_SKIPPED: "true" },
      notice:
        "settings apply skipped for h**-s**r: it has no .github/settings.yml yet, so there is nothing to layer over the fleet defaults. The settings starter seeds the file on its next sync.",
    },
    {
      reason: "neither skipped (the branch moved)",
      env: { RENDER_SKIPPED: "false", MERGE_SKIPPED: "false" },
      notice:
        "settings apply skipped for h**-s**r: its default branch moved while this run was computing its settings, so the apply was skipped rather than applied from a stale snapshot. The next run reads the new revision.",
    },
    {
      // The render's skip wins when both read true: the first branch of the
      // workflow's chain, kept in that order.
      reason: "both skipped reads as the render's skip",
      env: { RENDER_SKIPPED: "true", MERGE_SKIPPED: "true" },
      notice:
        "settings apply skipped for h**-s**r: it carries no .repo-platform.yml at the revision this run read (it left management), so its settings are not managed here any more.",
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
