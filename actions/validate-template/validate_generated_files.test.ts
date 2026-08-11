import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const VALIDATOR = join(import.meta.dir, "validate_generated_files.ts");

// The smallest tree the validator accepts: registration files, the marked
// .gitignore, and a ci.yml carrying the all-green + typography convention.
const BASELINE: Record<string, string> = {
  ".copier-answers.yml":
    "_commit: templates/v1.0.0\n_src_path: gh:Vivswan/repo-platform\ngithub_username: Vivswan\n",
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
 *  validator against it, with any extra CLI `args` (e.g. --self).
 *  `opts.gitInit` makes the tree a real git checkout first, so the --self
 *  gitignore skip has ignore rules to consult; `opts.gitAddForce`
 *  force-tracks paths despite matching an ignore pattern. */
function gitFreeEnv(): Record<string, string> {
  // Hook-driven runs (husky pre-commit) export GIT_DIR/GIT_INDEX_FILE, which
  // would make the spawned validator's git calls resolve the enclosing repo
  // instead of the scratch tree (or lack thereof).
  const env = { ...process.env } as Record<string, string>;
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  return env;
}

function runValidator(
  extra: Record<string, string> = {},
  args: string[] = [],
  opts: { gitInit?: boolean; gitAddForce?: string[] } = {},
): {
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
  if (opts.gitInit) {
    const init = Bun.spawnSync(["git", "-C", root, "init", "-q"], { env: gitFreeEnv() });
    if (init.exitCode !== 0) throw new Error(`git init failed: ${init.stderr.toString()}`);
  }
  if (opts.gitAddForce?.length) {
    const add = Bun.spawnSync(["git", "-C", root, "add", "-f", "--", ...opts.gitAddForce], {
      env: gitFreeEnv(),
    });
    if (add.exitCode !== 0) throw new Error(`git add -f failed: ${add.stderr.toString()}`);
  }
  const result = Bun.spawnSync([process.execPath, VALIDATOR, ...args, root], {
    env: gitFreeEnv(),
  });
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

describe("base checks shape", () => {
  // private: true in the answers also silences the dependency-review
  // advisory, like a real private render's answers do; github_username pins
  // the owner the fleet's composite actions must come from.
  const PRIVATE_ANSWERS =
    "_commit: templates/v1.0.0\n_src_path: gh:Vivswan/repo-platform\n" +
    "github_username: Vivswan\nprivate: true\n";

  /** A private merged render: base-checks carries the base checks as
   *  guarded steps, and all-green gates on it (unless `needs` says
   *  otherwise). */
  const mergedCi = (steps: string[], needs = "[base-checks]") =>
    [
      "name: CI",
      "jobs:",
      "  base-checks:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/checkout@v7",
      ...steps,
      "  all-green:",
      "    if: always()",
      `    needs: ${needs}`,
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: |",
      '          if [ "$RESULT" != "success" ]; then exit 1; fi',
      "",
    ].join("\n");

  const MERGED_STEPS = [
    "      - uses: Vivswan/repo-platform/actions/check-typography@main",
    "        if: '!cancelled()'",
    "      - uses: Vivswan/repo-platform/actions/validate-commit-names@main",
    "        if: '!cancelled()'",
    "      - uses: raven-actions/actionlint@v2",
    "        if: '!cancelled()'",
    "      - name: Lint YAML",
    "        if: '!cancelled()'",
    "        run: yamllint -s .",
    "      - uses: gitleaks/gitleaks-action@v3",
    "        if: '!cancelled()'",
  ];

  test("a full private merged ci.yml passes with no advisories", () => {
    const { exitCode, stdout, stderr } = runValidator({
      ".copier-answers.yml": PRIVATE_ANSWERS,
      ".github/workflows/ci.yml": mergedCi(MERGED_STEPS),
    });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain("consider adding");
  });

  test("each check missing from the merged job gets its own advisory", () => {
    // Steps 0-3: check-typography and validate-commit-names only.
    const { exitCode, stdout, stderr } = runValidator({
      ".copier-answers.yml": PRIVATE_ANSWERS,
      ".github/workflows/ci.yml": mergedCi(MERGED_STEPS.slice(0, 4)),
    });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("base-checks is missing the actionlint check");
    expect(stdout).toContain("base-checks is missing the yamllint check");
    expect(stdout).toContain("base-checks is missing the gitleaks check");
    expect(stdout).not.toContain("missing the commit-names check");
  });

  test("a check-typography step disabled by if: false fails", () => {
    const steps = [
      "      - uses: Vivswan/repo-platform/actions/check-typography@main",
      "        if: false",
      ...MERGED_STEPS.slice(2),
    ];
    const { exitCode, stderr } = runValidator({
      ".copier-answers.yml": PRIVATE_ANSWERS,
      ".github/workflows/ci.yml": mergedCi(steps),
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("no unconditional check-typography step");
  });

  test("a look-alike action name does not satisfy the typography check", () => {
    const steps = [
      "      - uses: Vivswan/repo-platform/actions/check-typography-disabled@main",
      ...MERGED_STEPS.slice(2),
    ];
    const { exitCode, stderr } = runValidator({
      ".copier-answers.yml": PRIVATE_ANSWERS,
      ".github/workflows/ci.yml": mergedCi(steps),
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("no unconditional check-typography step");
  });

  test("check-typography from another repository does not count", () => {
    const steps = [
      "      - uses: attacker/repo/actions/check-typography@v1",
      ...MERGED_STEPS.slice(2),
    ];
    const { exitCode, stderr } = runValidator({
      ".copier-answers.yml": PRIVATE_ANSWERS,
      ".github/workflows/ci.yml": mergedCi(steps),
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("no unconditional check-typography step");
  });

  test("check-typography from another owner does not count", () => {
    const steps = [
      "      - uses: attacker/repo-platform/actions/check-typography@v1",
      ...MERGED_STEPS.slice(2),
    ];
    const { exitCode, stderr } = runValidator({
      ".copier-answers.yml": PRIVATE_ANSWERS,
      ".github/workflows/ci.yml": mergedCi(steps),
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("no unconditional check-typography step");
  });

  test("a managed render missing github_username in its answers fails", () => {
    const { exitCode, stderr } = runValidator({
      ".copier-answers.yml": "_commit: templates/v1.0.0\n_src_path: gh:Vivswan/repo-platform\n",
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("`github_username` is missing or not a GitHub username");
  });

  test("a malformed github_username (regex metacharacters, slashes) fails", () => {
    const { exitCode, stderr } = runValidator({
      ".copier-answers.yml":
        "_commit: templates/v1.0.0\n_src_path: gh:Vivswan/repo-platform\n" +
        "github_username: attacker/repo.*\n",
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("`github_username` is missing or not a GitHub username");
  });

  test("self mode accepts any well-formed owner without answers to pin from", () => {
    const steps = [
      "      - uses: SomeFork/repo-platform/actions/check-typography@main",
      "        if: '!cancelled()'",
      ...MERGED_STEPS.slice(2),
    ];
    const { exitCode, stderr } = runValidator(
      {
        ".copier-answers.yml": "_commit: abc\n_src_path: /tmp/src\n",
        ".github/workflows/ci.yml": mergedCi(steps),
      },
      ["--self"],
    );
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });

  test("the wrapped expression form of the guard counts as unconditional", () => {
    const steps = [
      ...MERGED_STEPS.slice(0, MERGED_STEPS.length - 1),
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression fixture
      "        if: ${{ !cancelled() }}",
    ];
    const { exitCode, stdout, stderr } = runValidator({
      ".copier-answers.yml": PRIVATE_ANSWERS,
      ".github/workflows/ci.yml": mergedCi(steps),
    });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain("missing the gitleaks check");
  });

  test("look-alike or disabled marker steps still draw their advisories", () => {
    const steps = [
      ...MERGED_STEPS.slice(0, 4),
      "      - uses: raven-actions/actionlint-disabled@v2",
      "        if: '!cancelled()'",
      "      - name: Lint YAML",
      "        if: '!cancelled()'",
      "        run: yamllint -s .",
      "      - uses: gitleaks/gitleaks-action@v3",
      "        if: false",
    ];
    const { exitCode, stdout, stderr } = runValidator({
      ".copier-answers.yml": PRIVATE_ANSWERS,
      ".github/workflows/ci.yml": mergedCi(steps),
    });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("base-checks is missing the actionlint check");
    expect(stdout).toContain("base-checks is missing the gitleaks check");
    expect(stdout).not.toContain("missing the yamllint check");
  });

  test("base-checks outside all-green's needs fails", () => {
    const { exitCode, stderr } = runValidator({
      ".copier-answers.yml": PRIVATE_ANSWERS,
      ".github/workflows/ci.yml": mergedCi(MERGED_STEPS, "[]"),
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("all-green `needs:` is missing job(s): base-checks");
  });

  test("a ci.yml with neither a typography job nor a merged shape fails", () => {
    const { exitCode, stderr } = runValidator({
      ".github/workflows/ci.yml": [
        "name: CI",
        "jobs:",
        "  lint:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: echo ok",
        "  all-green:",
        "    if: always()",
        "    needs: [lint]",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: |",
        '          if [ "$RESULT" != "success" ]; then exit 1; fi',
        "",
      ].join("\n"),
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("no `typography` job");
  });
});

describe("gitignored paths in self mode", () => {
  // The operator checkout carries gitignored working state (agent
  // worktrees with in-progress rebases, composed template/ output) that a
  // --self walk must not fail on; client renders are plain trees where
  // everything is content.
  const IGNORED_TREE: Record<string, string> = {
    ".gitignore": `${BASELINE[".gitignore"]}.claude/worktrees/\n`,
    ".claude/worktrees/agent-x/broken.yml": "a: [1, 2\n",
    ".claude/worktrees/agent-x/conflicted.md": `${"<".repeat(7)} ours\ntheirs\n${"=".repeat(7)}\n`,
  };

  test("--self skips gitignored paths in a git checkout", () => {
    const { exitCode, stderr } = runValidator(IGNORED_TREE, ["--self"], { gitInit: true });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });

  test("--self on a plain tree (no git) still scans everything", () => {
    const { exitCode, stderr } = runValidator(IGNORED_TREE, ["--self"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain(".claude/worktrees/agent-x/broken.yml: does not parse as YAML");
  });

  test("a managed render's walk ignores no paths even in a git checkout", () => {
    const { exitCode, stderr } = runValidator(IGNORED_TREE, [], { gitInit: true });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(".claude/worktrees/agent-x/broken.yml: does not parse as YAML");
    expect(stderr).toContain("conflicted.md: contains unresolved merge-conflict markers");
  });

  test("--self skips an ignored file while validating its siblings in the same directory", () => {
    const { exitCode, stderr } = runValidator(
      {
        ".gitignore": `${BASELINE[".gitignore"]}vendor/generated.yml\n`,
        "vendor/generated.yml": "a: [1, 2\n",
        "vendor/checked.yml": "b: [1, 2\n",
      },
      ["--self"],
      { gitInit: true },
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("vendor/checked.yml: does not parse as YAML");
    expect(stderr).not.toContain("vendor/generated.yml");
  });

  test("--self still validates a tracked file matching an ignore pattern", () => {
    const { exitCode, stderr } = runValidator(
      {
        ".gitignore": `${BASELINE[".gitignore"]}vendor/generated.yml\n`,
        "vendor/generated.yml": "a: [1, 2\n",
      },
      ["--self"],
      { gitInit: true, gitAddForce: ["vendor/generated.yml"] },
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("vendor/generated.yml: does not parse as YAML");
  });
});

describe("one license file", () => {
  test("LICENSE.md alone passes (fleet repos)", () => {
    const { exitCode, stderr } = runValidator({ "LICENSE.md": "# License\n" });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });

  test("LICENSE alone passes with a rename advisory (custom-license repos)", () => {
    const { exitCode, stdout, stderr } = runValidator({ LICENSE: "MIT License\n" });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("advisory: LICENSE: the fleet convention is LICENSE.md");
  });

  test("both spellings together fail", () => {
    const { exitCode, stderr } = runValidator({
      LICENSE: "MIT License\n",
      "LICENSE.md": "# License\n",
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("LICENSE and LICENSE.md both exist");
  });
});
