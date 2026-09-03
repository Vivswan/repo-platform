import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boundedSpawnSync } from "../shared/bounded_spawn";

const script = new URL("../../.github/scripts/ci/verify_dogfood_oracle.ts", import.meta.url)
  .pathname;
const repoRoot = new URL("../..", import.meta.url).pathname;

function run(renderRoot: string): { exitCode: number; stderr: string } {
  const proc = boundedSpawnSync(["bun", script, renderRoot], { cwd: repoRoot });
  return { exitCode: proc.exitCode, stderr: proc.stderr };
}

// The rendered .github/.copier-answers.yml crosses a trust boundary: a payload
// that is not a mapping must fail with the script's own diagnosis, never
// a raw TypeError from indexing it.
describe("verify_dogfood_oracle recorded answers boundary", () => {
  test.each([
    { reason: "scalar", payload: '"just a string"\n' },
    { reason: "null document", payload: "null\n" },
    // A sequence indexes by string key without a TypeError, so it is the
    // non-mapping shape a typeof-object check alone would let through.
    { reason: "sequence", payload: "- a\n" },
  ])("a $reason payload fails with a shape error, not a crash", ({ payload }) => {
    const root = mkdtempSync(join(tmpdir(), "dogfood-oracle-"));
    mkdirSync(join(root, ".github"));
    writeFileSync(join(root, ".github/.copier-answers.yml"), payload);
    const { exitCode, stderr } = run(root);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("expected a YAML mapping");
    expect(stderr).not.toContain("TypeError");
  });
});
