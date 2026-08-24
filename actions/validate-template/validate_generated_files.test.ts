import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const VALIDATOR = join(import.meta.dir, "validate_generated_files.ts");

// The smallest tree the validator accepts: registration files (opening with
// the managed header check 8 requires), the marked .gitignore, and a ci.yml
// carrying the all-green + typography convention.
const MANAGED_HEADER = "# This file is managed by Vivswan/repo-platform.\n";
const BASELINE: Record<string, string> = {
  ".copier-answers.yml": `${MANAGED_HEADER}_commit: 0.0.0.post5.dev0+abc1234\n_src_path: gh:Vivswan/repo-platform\ngithub_username: Vivswan\n`,
  ".repo-platform.yml": `${MANAGED_HEADER}modules: [uv]\n`,
  ".gitignore": [
    "# BEGIN REPOSITORY LOCAL",
    "# END REPOSITORY LOCAL",
    "# BEGIN REPO-PLATFORM MANAGED",
    "# END REPO-PLATFORM MANAGED",
    "",
  ].join("\n"),
  ".github/workflows/ci.yml": [
    "# This file is managed by Vivswan/repo-platform.",
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
  opts: { gitInit?: boolean; gitAddForce?: string[]; env?: Record<string, string> } = {},
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
    env: { ...gitFreeEnv(), ...opts.env },
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

describe("multi-document YAML", () => {
  test("a valid multi-document file passes", () => {
    const { exitCode, stderr } = runValidator({
      "deploy/manifests.yml": "kind: Service\n---\nkind: Deployment\n",
    });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });

  test("a duplicate key inside a document of a .github/ file fails", () => {
    const { exitCode, stderr } = runValidator({
      ".github/multi.yml": "a: 1\na: 2\n---\nb: 3\n",
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(".github/multi.yml: duplicate mapping key");
  });

  test("a VALID multi-document .github/ file still fails - GitHub reads one mapping", () => {
    const { exitCode, stderr } = runValidator({
      ".github/dependabot.yml": "version: 2\nupdates: []\n---\nversion: 2\n",
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(".github/dependabot.yml: multi-document YAML stream");
  });

  test("a duplicate key inside a repo-owned multi-document file is an advisory", () => {
    const { exitCode, stdout, stderr } = runValidator({
      "deploy/manifests.yml": "a: 1\na: 2\n---\nb: 3\n",
    });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("advisory: deploy/manifests.yml: duplicate mapping key");
  });

  test("a syntax error in a later document still fails", () => {
    const { exitCode, stderr } = runValidator({
      "deploy/manifests.yml": "a: 1\n---\nb: [1, 2\n",
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("deploy/manifests.yml: does not parse as YAML");
  });

  test("a duplicate key cannot mask a resolution failure in the same file", () => {
    // doc.errors carries only composer-stage problems; the unresolved
    // alias surfaces at conversion and must still fail even though the
    // duplicate key already reported (as an advisory here).
    const { exitCode, stderr } = runValidator({
      "deploy/manifests.yml": "a: 1\na: 2\nb: *nope\n",
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("deploy/manifests.yml: does not parse as YAML");
  });
});

describe("base checks shape", () => {
  // private: true in the answers also silences the dependency-review
  // advisory, like a real private render's answers do; github_username pins
  // the owner the fleet's composite actions must come from.
  const PRIVATE_ANSWERS =
    `${MANAGED_HEADER}_commit: 0.0.0.post5.dev0+abc1234\n_src_path: gh:Vivswan/repo-platform\n` +
    "github_username: Vivswan\nprivate: true\n";

  /** A private merged render: base-checks carries the base checks as
   *  guarded steps, and all-green gates on it (unless `needs` says
   *  otherwise). */
  const mergedCi = (steps: string[], needs = "[base-checks]") =>
    [
      "# This file is managed by Vivswan/repo-platform.",
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
      ".copier-answers.yml":
        "_commit: 0.0.0.post5.dev0+abc1234\n_src_path: gh:Vivswan/repo-platform\n",
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("`github_username` is missing or not a GitHub username");
  });

  test("a malformed github_username (regex metacharacters, slashes) fails", () => {
    const { exitCode, stderr } = runValidator({
      ".copier-answers.yml":
        "_commit: 0.0.0.post5.dev0+abc1234\n_src_path: gh:Vivswan/repo-platform\n" +
        "github_username: attacker/repo.*\n",
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("`github_username` is missing or not a GitHub username");
  });

  test("a quoted github_username is read as its YAML value", () => {
    const { exitCode, stderr } = runValidator({
      ".copier-answers.yml":
        `${MANAGED_HEADER}_commit: 0.0.0.post5.dev0+abc1234\n_src_path: gh:Vivswan/repo-platform\n` +
        'github_username: "Vivswan"\nprivate: true\n',
      ".github/workflows/ci.yml": mergedCi(MERGED_STEPS),
    });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
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

  test("a rendered job absent from all-green's needs fails (the composer guards' backstop)", () => {
    // The composer's gate_jobs parity and preamble guards catch honest
    // mistakes at compose time but deliberately not obfuscated jinja; this
    // check, run by smoke-generate on every push, is the render-side
    // backstop they name: any job that ends up in a rendered ci.yml
    // without gating the merge is an error here.
    const { exitCode, stderr } = runValidator({
      ".github/workflows/ci.yml": [
        "# This file is managed by Vivswan/repo-platform.",
        "name: CI",
        "jobs:",
        "  typography:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: echo ok",
        "  release-freshness:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: echo rendered but undeclared",
        "  all-green:",
        "    if: always()",
        "    needs: [typography]",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: |",
        '          if [ "$RESULT" != "success" ]; then exit 1; fi',
        "",
      ].join("\n"),
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("all-green `needs:` is missing job(s): release-freshness");
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
    const { exitCode, stderr } = runValidator({
      "LICENSE.md": "# License\n\n<!-- repo-platform:local-section -->\n",
    });
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

describe("ownership self-declarations", () => {
  const C1 =
    "# This file is managed by Vivswan/repo-platform.\n" +
    "# Local edits may be replaced during template updates.\n";

  test("a sync-managed file without the managed header fails", () => {
    const { exitCode, stderr } = runValidator({ ".yamllint": "extends: default\n" });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(".yamllint: does not open with the managed header");
  });

  test("a sync-managed file opening with the managed header passes", () => {
    const { exitCode, stderr } = runValidator({ ".yamllint": `${C1}extends: default\n` });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });

  test("another owner's header does not satisfy the pinned owner", () => {
    const { exitCode, stderr } = runValidator({
      ".yamllint": "# This file is managed by attacker/repo-platform.\nextends: default\n",
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(".yamllint: does not open with the managed header");
  });

  test("a negated look-alike header does not count", () => {
    const { exitCode, stderr } = runValidator({
      ".yamllint": "# This file is not managed by Vivswan/repo-platform.\nextends: default\n",
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(".yamllint: does not open with the managed header");
  });

  test("a longer look-alike repo name does not count", () => {
    // GitHub repo names allow [A-Za-z0-9._-], so every continuation
    // character must fail the anchor.
    for (const name of ["repo-platform-fork", "repo-platform_fork", "repo-platform.fork"]) {
      const { exitCode, stderr } = runValidator({
        ".yamllint": `# This file is managed by Vivswan/${name}.\nextends: default\n`,
      });
      expect(exitCode).toBe(1);
      expect(stderr).toContain(".yamllint: does not open with the managed header");
    }
  });

  test("a header buried past the opening lines does not count", () => {
    const { exitCode, stderr } = runValidator({
      ".yamllint": `${"# filler\n".repeat(10)}${C1}extends: default\n`,
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(".yamllint: does not open with the managed header");
  });

  test("a split file carries the local-section marker exactly once", () => {
    const marker = "# repo-platform:local-section\n";
    const missing = runValidator({ ".editorconfig": "root = true\n" });
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain(".editorconfig: the 'repo-platform:local-section' marker");
    const once = runValidator({ ".editorconfig": `root = true\n${marker}` });
    expect(once.stderr).toBe("");
    expect(once.exitCode).toBe(0);
    const twice = runValidator({ ".editorconfig": `root = true\n${marker}${marker}` });
    expect(twice.exitCode).toBe(1);
    expect(twice.stderr).toContain("appears 2 times");
  });

  test("a prose mention of the marker is not the marker line", () => {
    const { exitCode, stderr } = runValidator({
      ".editorconfig": "root = true\n# rules go below the repo-platform:local-section marker\n",
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(".editorconfig: the 'repo-platform:local-section' marker");
  });

  test("CODE_OF_CONDUCT.md needs the header only on public renders", () => {
    const coc = { "CODE_OF_CONDUCT.md": "# Contributor Covenant Code of Conduct\n" };
    const publicRender = runValidator(coc);
    expect(publicRender.exitCode).toBe(1);
    expect(publicRender.stderr).toContain("CODE_OF_CONDUCT.md: does not open");
    // A private render never gets the managed file, so a repo-authored one
    // is its own business.
    const privateRender = runValidator({
      ...coc,
      ".copier-answers.yml": `${BASELINE[".copier-answers.yml"]}private: true\n`,
      ".github/workflows/ci.yml": BASELINE[".github/workflows/ci.yml"]
        .replace("  typography:", "  base-checks:")
        .replace("needs: [typography]", "needs: [base-checks]")
        .replace(
          "      - run: echo ok",
          "      - uses: Vivswan/repo-platform/actions/check-typography@main",
        ),
    });
    expect(privateRender.stderr).toBe("");
    expect(privateRender.exitCode).toBe(0);
  });

  test("LICENSE.md needs the marker unless custom-license owns licensing", () => {
    const fleet = runValidator({ "LICENSE.md": "# License\n" });
    expect(fleet.exitCode).toBe(1);
    expect(fleet.stderr).toContain("LICENSE.md: the 'repo-platform:local-section' marker");
    const custom = runValidator({
      "LICENSE.md": "# My own license\n",
      ".repo-platform.yml": `${BASELINE[".repo-platform.yml"]}`.replace(
        "modules: [uv]",
        "modules: [uv, custom-license]",
      ),
    });
    expect(custom.stderr).toBe("");
    expect(custom.exitCode).toBe(0);
  });

  test("a selected module's managed workflow needs the header", () => {
    const bunRender = {
      ".repo-platform.yml": BASELINE[".repo-platform.yml"].replace(
        "modules: [uv]",
        "modules: [bun]",
      ),
      ".bun-version": "1.3.14\n",
    };
    const bare = runValidator({
      ...bunRender,
      ".github/workflows/dependabot-bun-lockfile.yml": "name: x\non: [push]\n",
    });
    expect(bare.exitCode).toBe(1);
    expect(bare.stderr).toContain(".github/workflows/dependabot-bun-lockfile.yml: does not open");
    const headed = runValidator({
      ...bunRender,
      ".github/workflows/dependabot-bun-lockfile.yml": `${C1}name: x\non: [push]\n`,
    });
    expect(headed.stderr).toBe("");
    expect(headed.exitCode).toBe(0);
  });

  test("an unselected module's managed workflow is not required to declare", () => {
    const { exitCode, stderr } = runValidator({
      ".github/workflows/dependabot-bun-lockfile.yml": "name: x\non: [push]\n",
    });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });

  test("the agents module's AGENTS.md carries the marker", () => {
    const agentsRender = {
      ".repo-platform.yml": BASELINE[".repo-platform.yml"].replace(
        "modules: [uv]",
        "modules: [uv, agents]",
      ),
    };
    const bare = runValidator({ ...agentsRender, "AGENTS.md": "# AGENTS.md\n" });
    expect(bare.exitCode).toBe(1);
    expect(bare.stderr).toContain("AGENTS.md: the 'repo-platform:local-section' marker");
    const marked = runValidator({
      ...agentsRender,
      "AGENTS.md": "# AGENTS.md\n\n<!-- repo-platform:local-section -->\n",
    });
    expect(marked.stderr).toBe("");
    expect(marked.exitCode).toBe(0);
  });

  test("self mode skips ownership declarations", () => {
    const { exitCode, stderr } = runValidator({ ".yamllint": "extends: default\n" }, ["--self"]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });
});

describe("ownership-manifest byte parity", () => {
  const MANIFEST = ".repo-platform-manifest.json";
  const sha = (text: string) =>
    new Bun.CryptoHasher("sha256").update(Buffer.from(text, "latin1")).digest("hex");
  const manifestOf = (entries: Record<string, string>) =>
    `{\n  "$comment": "test",\n  "files": {\n${Object.entries(entries)
      .map(([path, body]) => `    ${JSON.stringify(path)}: ${body}`)
      .join(",\n")}\n  }\n}\n`;
  const SELF_ENTRY = { [MANIFEST]: '{"class": "managed", "hash": null}' };
  const stampedBaseline = () => ({
    ...SELF_ENTRY,
    ".github/workflows/ci.yml": `{"class": "managed", "hash": "${sha(
      BASELINE[".github/workflows/ci.yml"],
    )}"}`,
  });

  test("a missing manifest is an advisory, not an error", () => {
    const { exitCode, stdout, stderr } = runValidator();
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain(`advisory: ${MANIFEST} is missing`);
  });

  test("a stamped manifest with matching hashes passes", () => {
    const { exitCode, stderr } = runValidator({ [MANIFEST]: manifestOf(stampedBaseline()) });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });

  test("a drifted managed file fails parity", () => {
    const entries = {
      ...SELF_ENTRY,
      ".github/workflows/ci.yml": `{"class": "managed", "hash": "${"0".repeat(64)}"}`,
    };
    const { exitCode, stderr } = runValidator({ [MANIFEST]: manifestOf(entries) });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(".github/workflows/ci.yml: content does not match the sha256");
  });

  test("split parity covers the managed half only: tail edits pass, top edits fail", () => {
    const managedTop = "# Security\n<!-- repo-platform:local-section -->\n";
    const entries = {
      ...stampedBaseline(),
      "SECURITY.md":
        `{"class": "split", "marker": "<!-- repo-platform:local-section -->", ` +
        `"managed": "above", "hash": "${sha(managedTop)}"}`,
    };
    const tailEdited = runValidator({
      [MANIFEST]: manifestOf(entries),
      "SECURITY.md": `${managedTop}repo-owned tail, freely edited\n`,
    });
    expect(tailEdited.stderr).toBe("");
    expect(tailEdited.exitCode).toBe(0);
    const topEdited = runValidator({
      [MANIFEST]: manifestOf(entries),
      "SECURITY.md": `# Security, reworded\n<!-- repo-platform:local-section -->\ntail\n`,
    });
    expect(topEdited.exitCode).toBe(1);
    expect(topEdited.stderr).toContain("SECURITY.md: its managed half does");
  });

  test("an unstamped managed entry is an error naming the stamp hook", () => {
    const entries = { ...SELF_ENTRY, ".yamllint": '{"class": "managed", "hash": null}' };
    const { exitCode, stderr } = runValidator({
      [MANIFEST]: manifestOf(entries),
      ".yamllint": "extends: default\n",
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(".yamllint: .repo-platform-manifest.json records no hash");
  });

  test("a listed managed file missing from the repo is an advisory", () => {
    // Check 8's absence stance, and the warn-and-withhold push path leaves
    // exactly this state for an added workflow the token cannot deliver.
    // The path sits outside the ownership tables so only absence is probed.
    const entries = {
      ...stampedBaseline(),
      "docs/handbook.md": '{"class": "managed", "hash": null}',
    };
    const { exitCode, stdout, stderr } = runValidator({ [MANIFEST]: manifestOf(entries) });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("advisory: docs/handbook.md: listed as managed");
  });

  test("a roster path the manifest fails to list is an advisory", () => {
    const { exitCode, stdout, stderr } = runValidator({
      [MANIFEST]: manifestOf(stampedBaseline()),
    });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("advisory: .repo-platform-manifest.json does not list 'SECURITY.md'");
    // The baseline records a staging-form _commit, so absence runs in skew
    // mode and the advisory says why.
    expect(stdout).toContain("skew mode");
  });

  // Provenance: a templates/vX.Y.Z-form recorded _commit proves version
  // alignment (this validator and the manifest ride the same render), so
  // absence flips from skew advisories to hard errors there.
  const RELEASE_ANSWERS = {
    ".copier-answers.yml": BASELINE[".copier-answers.yml"].replace(
      "_commit: 0.0.0.post5.dev0+abc1234",
      "_commit: templates/v1.0.0",
    ),
  };
  const RELEASE_SELF = {
    [MANIFEST]: '{"class": "managed", "hash": null, "commit": "templates/v1.0.0"}',
  };

  test("release-aligned: a deleted roster entry is an error, not skew", () => {
    // THE deletion attack: drop ci.yml's entry, edit the file under its
    // header - without provenance this would ride the absence advisory.
    const entries = { ...RELEASE_SELF };
    const { exitCode, stderr } = runValidator({
      ...RELEASE_ANSWERS,
      [MANIFEST]: manifestOf(entries),
      ".github/workflows/ci.yml": `${BASELINE[".github/workflows/ci.yml"]}# local tweak\n`,
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(
      ".repo-platform-manifest.json does not list '.github/workflows/ci.yml'",
    );
    expect(stderr).toContain("the entry was deleted by hand");
  });

  test("release-aligned: a missing manifest is an error, not an advisory", () => {
    const { exitCode, stderr } = runValidator(RELEASE_ANSWERS);
    expect(exitCode).toBe(1);
    expect(stderr).toContain(
      `${MANIFEST} is missing, but the recorded render (templates/v1.0.0) is a release that ships it`,
    );
  });

  test("release-aligned: a nulled or mismatched provenance stamp is an error (no skew downgrade)", () => {
    // Nulling the self entry's commit must not buy the lenient skew path.
    const nulled = runValidator({
      ...RELEASE_ANSWERS,
      [MANIFEST]: manifestOf({
        ...SELF_ENTRY,
        ".github/workflows/ci.yml": `{"class": "managed", "hash": "${sha(
          BASELINE[".github/workflows/ci.yml"],
        )}"}`,
      }),
    });
    expect(nulled.exitCode).toBe(1);
    expect(nulled.stderr).toContain("its provenance stamp is null but the recorded render");
    const mismatched = runValidator({
      ...RELEASE_ANSWERS,
      [MANIFEST]: manifestOf({
        [MANIFEST]: '{"class": "managed", "hash": null, "commit": "templates/v0.9.0"}',
      }),
    });
    expect(mismatched.exitCode).toBe(1);
    expect(mismatched.stderr).toContain("stamped provenance");
  });

  test("any-form provenance mismatch is an error, even off the release channel", () => {
    // The stamper always writes the recorded _commit, so a differing (or
    // key-deleted) value is tampering on every channel; only a null stamp
    // stays lenient (legacy manifests).
    const differing = runValidator({
      [MANIFEST]: manifestOf({
        [MANIFEST]: '{"class": "managed", "hash": null, "commit": "zzz9999"}',
      }),
    });
    expect(differing.exitCode).toBe(1);
    expect(differing.stderr).toContain("stamped provenance");
    const keyDeleted = runValidator({
      ".copier-answers.yml": `${MANAGED_HEADER}_src_path: gh:Vivswan/repo-platform\ngithub_username: Vivswan\n`,
      [MANIFEST]: manifestOf({
        [MANIFEST]: '{"class": "managed", "hash": null, "commit": "0.0.0.post5.dev0+abc1234"}',
      }),
    });
    expect(keyDeleted.exitCode).toBe(1);
    expect(keyDeleted.stderr).toContain("no _commit in .copier-answers.yml");
  });

  test("strict absence stands down when the executing validator ref is not the render's version", () => {
    // The withheld-workflows fallback leaves an older pinned ci.yml behind:
    // that validator's tables can declare a path the newer manifest
    // legitimately omits (a retirement) whose restored file still exists.
    const entries = { ...RELEASE_SELF };
    const stale = runValidator(
      {
        ...RELEASE_ANSWERS,
        [MANIFEST]: manifestOf(entries),
      },
      [],
      { env: { VALIDATOR_REF: "v0.9.0" } },
    );
    expect(stale.stderr).toBe("");
    expect(stale.exitCode).toBe(0);
    expect(stale.stdout).toContain("this validator runs at ref 'v0.9.0'");
    // The matching ref keeps the strict error (the plain-tag form uses_ref
    // pins: v1.0.0 <-> templates/v1.0.0).
    const matching = runValidator(
      {
        ...RELEASE_ANSWERS,
        [MANIFEST]: manifestOf(entries),
      },
      [],
      { env: { VALIDATOR_REF: "v1.0.0" } },
    );
    expect(matching.exitCode).toBe(1);
    expect(matching.stderr).toContain("the entry was deleted by hand");
  });

  test("staging skew: matching sha-form provenance stays advisory", () => {
    // A staging render's commit is not a release form: a main-pinned
    // validator's tables may be newer than the render, so a missing roster
    // entry must not false-error. This also pins the visibility guarantee
    // behind the answers-side downgrade boundary (see the trust-model
    // comment): even in skew mode, every absence names its path.
    const entries = {
      [MANIFEST]: '{"class": "managed", "hash": null, "commit": "0.0.0.post5.dev0+abc1234"}',
    };
    const { exitCode, stdout, stderr } = runValidator({ [MANIFEST]: manifestOf(entries) });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("skew mode");
    expect(stdout).toContain("does not list '.github/workflows/ci.yml'");
  });

  test("release-aligned: a fully listed manifest passes, absent-file paths advisory", () => {
    // The strict deletion error requires the missing entry's FILE to still
    // exist: roster paths the baseline tree does not carry (SECURITY.md and
    // friends) stay advisories even under alignment - the version-split
    // states the fleet legitimately produces (withheld workflow files, a
    // channel switch) look exactly like this.
    const gitignoreHalf = "# BEGIN REPO-PLATFORM MANAGED\n# END REPO-PLATFORM MANAGED\n";
    const entries = {
      ...RELEASE_SELF,
      ".copier-answers.yml": `{"class": "managed", "hash": "${sha(
        BASELINE[".copier-answers.yml"].replace(
          "_commit: 0.0.0.post5.dev0+abc1234",
          "_commit: templates/v1.0.0",
        ),
      )}"}`,
      ".repo-platform.yml": `{"class": "managed", "hash": "${sha(BASELINE[".repo-platform.yml"])}"}`,
      ".github/workflows/ci.yml": `{"class": "managed", "hash": "${sha(
        BASELINE[".github/workflows/ci.yml"],
      )}"}`,
      ".gitignore":
        `{"class": "split", "marker": "# BEGIN REPO-PLATFORM MANAGED", ` +
        `"managed": "below", "hash": "${sha(gitignoreHalf)}"}`,
    };
    const { exitCode, stdout, stderr } = runValidator({
      ...RELEASE_ANSWERS,
      [MANIFEST]: manifestOf(entries),
    });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain(
      "does not list 'SECURITY.md', which this validator's ownership tables declare - the path is absent from the repo too",
    );
  });

  test("a managed entry hand-flipped to starter fails the roster cross-check", () => {
    // THE tamper scenario the cross-check exists for: sync baselines
    // non-conflicting local manifest edits, so without the tables this flip
    // would disable ci.yml's parity permanently and invisibly.
    const entries = { ...SELF_ENTRY, ".github/workflows/ci.yml": '{"class": "starter"}' };
    const { exitCode, stderr } = runValidator({
      [MANIFEST]: manifestOf(entries),
      // A drifted ci.yml that keeps the managed header, so neither check 8
      // nor the (now skipped) hash can be what flags it.
      ".github/workflows/ci.yml": `${BASELINE[".github/workflows/ci.yml"]}# local tweak\n`,
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(
      `${MANIFEST}: entry '.github/workflows/ci.yml' claims class "starter"`,
    );
    expect(stderr).toContain("ownership tables declare it managed");
  });

  test("tampered split metadata on a roster path fails the cross-check", () => {
    const managedTop = "# Security\n<!-- repo-platform:local-section -->\n";
    const entries = {
      ...stampedBaseline(),
      "SECURITY.md":
        `{"class": "split", "marker": "<!-- repo-platform:local-section -->", ` +
        `"managed": "below", "hash": "${sha(managedTop)}"}`,
    };
    const { exitCode, stderr } = runValidator({
      [MANIFEST]: manifestOf(entries),
      "SECURITY.md": `${managedTop}tail\n`,
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("carries split metadata outside the local-section grammar");
  });

  test("a tampered .gitignore entry fails its managed-section grammar", () => {
    const entries = {
      ...stampedBaseline(),
      ".gitignore": '{"class": "starter"}',
    };
    const { exitCode, stderr } = runValidator({ [MANIFEST]: manifestOf(entries) });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("'.gitignore' does not match the managed-section grammar");
  });

  test("an entry whose render condition is off is manifest drift", () => {
    // release.yml belongs to the release-please module; the baseline
    // selects only uv, so no template render can have listed it.
    const entries = {
      ...stampedBaseline(),
      ".github/workflows/release.yml": '{"class": "managed", "hash": null}',
    };
    const { exitCode, stderr } = runValidator({ [MANIFEST]: manifestOf(entries) });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(
      "entry '.github/workflows/release.yml' should not exist for this render",
    );
  });

  test("a starter entry never carries a hash", () => {
    const entries = {
      ...stampedBaseline(),
      ".github/workflows/checks.yml": `{"class": "starter", "hash": "${"a".repeat(64)}"}`,
    };
    const { exitCode, stderr } = runValidator({ [MANIFEST]: manifestOf(entries) });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("a starter carrying a hash");
  });

  test("the manifest's own entry must stay hash-null (self-hash is circular)", () => {
    const entries = {
      ...stampedBaseline(),
      [MANIFEST]: `{"class": "managed", "hash": "${"b".repeat(64)}"}`,
    };
    const { exitCode, stderr } = runValidator({ [MANIFEST]: manifestOf(entries) });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("self-hash would be circular");
  });

  test("a self entry reclassified as starter cannot slip past the invariant", () => {
    const entries = { ...stampedBaseline(), [MANIFEST]: '{"class": "starter"}' };
    const { exitCode, stderr } = runValidator({ [MANIFEST]: manifestOf(entries) });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("self-hash would be circular");
  });

  test("a split entry whose marker is missing from the file fails closed", () => {
    // A corrupted manifest reclassifying a managed file as split must not
    // silently exempt it from parity.
    const entries = {
      ...SELF_ENTRY,
      ".github/workflows/ci.yml":
        `{"class": "split", "marker": "# no-such-marker", "managed": "above", ` +
        `"hash": "${"c".repeat(64)}"}`,
    };
    const { exitCode, stderr } = runValidator({ [MANIFEST]: manifestOf(entries) });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(
      ".github/workflows/ci.yml: the split marker line '# no-such-marker' recorded in",
    );
  });

  test("a manifest that does not list itself is an error", () => {
    const entries = {
      ".github/workflows/ci.yml": `{"class": "managed", "hash": "${sha(
        BASELINE[".github/workflows/ci.yml"],
      )}"}`,
    };
    const { exitCode, stderr } = runValidator({ [MANIFEST]: manifestOf(entries) });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("does not list itself");
  });

  test("an unparseable manifest is its own error", () => {
    const { exitCode, stderr } = runValidator({ [MANIFEST]: "not json\n" });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(`${MANIFEST}: does not parse as an ownership manifest`);
  });

  test("a conflict-marked manifest is check 4's report, with no parity double", () => {
    const conflicted = [
      `${"<".repeat(7)} before updating`,
      manifestOf(stampedBaseline()),
      "=".repeat(7),
      `${">".repeat(7)} after updating`,
      "",
    ].join("\n");
    const { exitCode, stderr } = runValidator({ [MANIFEST]: conflicted });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(`${MANIFEST}: contains unresolved merge-conflict markers`);
    expect(stderr).not.toContain("does not parse as an ownership manifest");
  });

  test("self mode inverts: a present manifest is the error", () => {
    const present = runValidator({ [MANIFEST]: manifestOf(SELF_ENTRY) }, ["--self"]);
    expect(present.exitCode).toBe(1);
    expect(present.stderr).toContain(`${MANIFEST}: exists in the template repository`);
    const absent = runValidator({}, ["--self"]);
    expect(absent.stderr).toBe("");
    expect(absent.exitCode).toBe(0);
  });

  test("a managed symlink's hash covers the link target", () => {
    // BASELINE has no symlinks; exercise the rule through a manifest entry
    // pointing at one created next to it.
    const root = mkdtempSync(join(tmpdir(), "validate-template-link-"));
    roots.push(root);
    for (const [rel, content] of Object.entries(BASELINE)) {
      mkdirSync(join(root, dirname(rel)), { recursive: true });
      writeFileSync(join(root, rel), content);
    }
    symlinkSync("AGENTS.md", join(root, "CLAUDE.md"));
    writeFileSync(
      join(root, MANIFEST),
      manifestOf({
        ...stampedBaseline(),
        "CLAUDE.md": `{"class": "managed", "hash": "${sha("AGENTS.md")}"}`,
      }),
    );
    const result = Bun.spawnSync([process.execPath, VALIDATOR, root], { env: gitFreeEnv() });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
  });
});
