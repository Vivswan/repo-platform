import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const VALIDATOR = join(import.meta.dir, "validate_generated_files.ts");

// The smallest tree the validator accepts: registration files, the marked
// .gitignore, and a ci.yml carrying the all-green + typography convention.
const BASELINE: Record<string, string> = {
  ".copier-answers.yml": "_commit: templates/v1.0.0\n_src_path: gh:Vivswan/repo-platform\n",
  ".repo-platform.yml": "modules: [uv]\n",
  ".gitignore": [
    "# BEGIN REPOSITORY LOCAL",
    "# END REPOSITORY LOCAL",
    "# BEGIN REPO-PLATFORM MANAGED",
    "# END REPO-PLATFORM MANAGED",
    "",
  ].join("\n"),
  ".github/workflows/ci.yml": [
    "name: CI",
    "jobs:",
    "  typography:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: echo ok",
    "  all-green:",
    "    if: always()",
    "    needs: [typography]",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: |",
    '          if [ "$RESULT" != "success" ]; then exit 1; fi',
    "",
  ].join("\n"),
};

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** Writes BASELINE plus `extra` into a fresh temp repo and runs the
 *  validator against it. */
function runValidator(extra: Record<string, string> = {}): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  const root = mkdtempSync(join(tmpdir(), "validate-template-"));
  roots.push(root);
  for (const [rel, content] of Object.entries({ ...BASELINE, ...extra })) {
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  const result = Bun.spawnSync([process.execPath, VALIDATOR, root]);
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

const DUP_KEY_YAML = "homepage: https://a.example\nhomepage: https://b.example\n";

describe("duplicate mapping keys", () => {
  test("the baseline tree passes", () => {
    const { exitCode, stderr } = runValidator();
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });

  test("a duplicate key in .github/settings.yml fails with the tailored message", () => {
    const { exitCode, stderr } = runValidator({ ".github/settings.yml": DUP_KEY_YAML });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(".github/settings.yml: duplicate mapping key");
    expect(stderr).toContain("the later value silently wins");
  });

  test("a duplicate key in a registration file fails", () => {
    const { exitCode, stderr } = runValidator({
      ".repo-platform.yml": "modules: [uv]\nmodules: [bun]\n",
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(".repo-platform.yml: duplicate mapping key");
    // ...and not a second, wrong diagnostic: the list is present, it is
    // just written twice.
    expect(stderr).not.toContain("`modules` is missing");
  });

  test("a duplicate key in a repo-owned .github file is still an error", () => {
    // checks.yml is generated once then owned by the repo (_skip_if_exists),
    // so this pins the deliberate choice: strictness follows the .github/
    // prefix, not template ownership, because GitHub's own parser rejects
    // duplicate keys in a workflow anyway.
    const { exitCode, stderr } = runValidator({
      ".github/workflows/checks.yml": "name: Checks\nname: Checks again\non: [push]\n",
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(".github/workflows/checks.yml: duplicate mapping key");
  });

  test("a duplicate key in ci.yml does not also claim the file defines no jobs", () => {
    const withDup = `${BASELINE[".github/workflows/ci.yml"]}\nname: CI again\n`;
    const { exitCode, stderr } = runValidator({ ".github/workflows/ci.yml": withDup });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(".github/workflows/ci.yml: duplicate mapping key");
    // The structural checks re-read the file tolerantly, so they see the
    // real jobs instead of treating it as empty and prescribing a sync.
    expect(stderr).not.toContain("defines no jobs");
  });

  test("a duplicate key in a repo-owned fixture is an advisory, not an error", () => {
    const { exitCode, stdout, stderr } = runValidator({ "tests/fixtures/dup.yml": DUP_KEY_YAML });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("advisory: tests/fixtures/dup.yml: duplicate mapping key");
  });

  test("a repo-owned file with a duplicate key AND a syntax error still fails", () => {
    const { exitCode, stderr } = runValidator({
      "tests/fixtures/broken.yml": "a: 1\na: 2\nb: [unclosed\n",
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("tests/fixtures/broken.yml: does not parse as YAML");
  });

  test("plain broken YAML outside the managed set still fails", () => {
    const { exitCode, stderr } = runValidator({ "vendor/bad.yml": "a: [1, 2\n" });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("vendor/bad.yml: does not parse as YAML");
  });
});
