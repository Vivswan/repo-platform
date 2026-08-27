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

const MANIFEST = ".github/repo-platform-manifest.json";

// Absence and provenance checks are STRICT (every build ships the
// manifest), so every client-render fixture must carry a manifest listing
// each expected path whose file exists. This mirror of the validator's
// ownership tables stamps one from the fixture's final tree. Coverage is
// honest, not total: mirror drift on a path a fixture CARRIES fails
// loudly through the roster cross-check (the mirror-coverage test below
// carries the whole base marker roster plus the agents entry for exactly
// that reason), while entries for paths no fixture ever carries - the
// remaining MIRROR_MODULES workflow files - are inert until a fixture
// carries them. Tests probing manifest behavior itself pass their own
// manifest (which wins) or opt out via `noManifest`.
const TAIL_MARKER = "<!-- repo-platform:local-section -->";
const HASH_COMMENT_MARKER = "# repo-platform:local-section";
type MirrorEntry = {
  path: string;
  kind: "header" | "marker" | "class-only";
  marker?: string;
  publicOnly?: boolean;
  withoutModule?: string;
};
const MIRROR_BASE: MirrorEntry[] = [
  { path: ".copier-answers.yml", kind: "header" },
  { path: ".editorconfig", kind: "marker", marker: HASH_COMMENT_MARKER },
  { path: ".gitattributes", kind: "marker", marker: HASH_COMMENT_MARKER },
  { path: ".github/CODEOWNERS", kind: "marker", marker: HASH_COMMENT_MARKER },
  { path: ".github/dependabot.yml", kind: "header" },
  { path: ".github/workflows/ci.yml", kind: "header" },
  { path: ".repo-platform.yml", kind: "header" },
  { path: ".typography-allow", kind: "header" },
  { path: ".yamllint", kind: "header" },
  { path: "CODE_OF_CONDUCT.md", kind: "header", publicOnly: true },
  { path: "CONTRIBUTING.md", kind: "marker", marker: TAIL_MARKER, publicOnly: true },
  { path: "LICENSE.md", kind: "marker", marker: TAIL_MARKER, withoutModule: "custom-license" },
  { path: "SECURITY.md", kind: "marker", marker: TAIL_MARKER },
];
const MIRROR_MODULES: Record<string, MirrorEntry[]> = {
  agents: [
    { path: ".github/agents.md", kind: "class-only" },
    { path: ".github/copilot-instructions.md", kind: "class-only" },
    { path: "AGENTS.md", kind: "marker", marker: TAIL_MARKER },
    { path: "CLAUDE.md", kind: "class-only" },
  ],
  bun: [
    { path: ".bun-version", kind: "class-only" },
    { path: ".github/workflows/dependabot-bun-lockfile.yml", kind: "header" },
  ],
  node: [{ path: ".node-version", kind: "class-only" }],
  deno: [
    { path: ".dvmrc", kind: "class-only" },
    { path: ".github/workflows/deno-audit.yml", kind: "header" },
  ],
  pages: [{ path: ".github/workflows/pages.yml", kind: "header" }],
  "release-please": [{ path: ".github/workflows/release.yml", kind: "header" }],
  skills: [{ path: ".github/workflows/validate-skills.yml", kind: "header" }],
  "auto-assign": [{ path: ".github/workflows/auto-assign.yml", kind: "header" }],
  "settings-sync": [{ path: ".github/workflows/settings-sync.yml", kind: "header" }],
};

const shaLatin1 = (text: string) =>
  new Bun.CryptoHasher("sha256").update(Buffer.from(text, "latin1")).digest("hex");

/** Twin of the validator's managedHalf: through the first marker line's
 *  newline for "above", from the start of the marker line for "below". */
function managedHalfOf(content: string, marker: string, managed: "above" | "below"): string | null {
  let offset = 0;
  for (const line of content.split("\n")) {
    const end = offset + line.length;
    if (line.trim() === marker) {
      return managed === "above"
        ? content.slice(0, Math.min(end + 1, content.length))
        : content.slice(offset);
    }
    offset = end + 1;
  }
  return null;
}

function manifestForTree(tree: Record<string, string>): string {
  const answers = tree[".copier-answers.yml"] ?? "";
  const isPrivate = /^private:\s*true\b/m.test(answers);
  const commit = /^_commit:[ \t]*(.+?)[ \t]*$/m.exec(answers)?.[1] ?? null;
  const modules = (/^modules:\s*\[([^\]]*)\]/m.exec(tree[".repo-platform.yml"] ?? "")?.[1] ?? "")
    .split(",")
    .map((name) => name.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
  const entries: Record<string, string> = {
    [MANIFEST]: `{"class": "managed", "hash": null, "commit": ${
      commit === null ? "null" : JSON.stringify(commit)
    }}`,
  };
  const expected = [
    ...MIRROR_BASE.filter(
      (entry) =>
        !(entry.publicOnly && isPrivate) &&
        !(entry.withoutModule !== undefined && modules.includes(entry.withoutModule)),
    ),
    ...modules.flatMap((name) => MIRROR_MODULES[name] ?? []),
  ];
  for (const { path, kind, marker } of expected) {
    const content = tree[path];
    if (content === undefined) continue;
    if (kind === "header" || kind === "class-only") {
      entries[path] = `{"class": "managed", "hash": "${shaLatin1(content)}"}`;
    } else {
      // A missing or duplicated marker is that check's own report; the
      // manifest still lists the half the first marker delimits.
      const half = managedHalfOf(content, marker as string, "above");
      if (half === null) continue;
      entries[path] =
        `{"class": "split", "grammar": "tail-marker", "marker": ${JSON.stringify(marker)}, ` +
        `"managed": "above", "hash": "${shaLatin1(half)}"}`;
    }
  }
  const gitignore = tree[".gitignore"];
  if (gitignore !== undefined) {
    const half = managedHalfOf(gitignore, "# BEGIN REPO-PLATFORM MANAGED", "below");
    if (half !== null) {
      entries[".gitignore"] =
        `{"class": "split", "grammar": "bounded-region", ` +
        `"marker": "# BEGIN REPO-PLATFORM MANAGED", "managed": "below", ` +
        `"managed_end": "# END REPO-PLATFORM MANAGED", ` +
        `"local_begin": "# BEGIN REPOSITORY LOCAL", ` +
        `"local_end": "# END REPOSITORY LOCAL", "hash": "${shaLatin1(half)}"}`;
    }
  }
  return `{\n  "$comment": "test-stamped", "files": {\n${Object.entries(entries)
    .map(([path, body]) => `    ${JSON.stringify(path)}: ${body}`)
    .join(",\n")}\n  }\n}\n`;
}

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
  opts: {
    gitInit?: boolean;
    gitAddForce?: string[];
    env?: Record<string, string>;
    noManifest?: boolean;
  } = {},
): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  const root = mkdtempSync(join(tmpdir(), "validate-template-"));
  roots.push(root);
  const tree: Record<string, string> = { ...BASELINE, ...extra };
  // Client renders need a stamped manifest (absence is strict); self mode
  // must NOT have one, and manifest-behavior tests bring their own.
  if (!opts.noManifest && !args.includes("--self") && !Object.hasOwn(tree, MANIFEST)) {
    tree[MANIFEST] = manifestForTree(tree);
  }
  for (const [rel, content] of Object.entries(tree)) {
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

  test("reordered .gitignore marker sections fail even when each appears once", () => {
    // Counting alone would pass this shape; a swap above the managed BEGIN
    // leaves the managed-half hash unchanged too, so order is its own rule.
    const { exitCode, stderr } = runValidator({
      ".gitignore": [
        "# BEGIN REPO-PLATFORM MANAGED",
        "# END REPO-PLATFORM MANAGED",
        "# BEGIN REPOSITORY LOCAL",
        "# END REPOSITORY LOCAL",
        "",
      ].join("\n"),
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(".gitignore: the managed/local markers appear out of order");
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
    "      - uses: Vivswan/repo-platform/actions/yamllint@main",
    "        if: '!cancelled()'",
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
      // The retired inline shape: a leftover run line is not the fleet's
      // yamllint action and must draw the advisory.
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
    expect(stdout).toContain("base-checks is missing the yamllint check");
  });

  test("yamllint from another owner does not satisfy the merged yamllint check", () => {
    const steps = [
      ...MERGED_STEPS.slice(0, 6),
      "      - uses: attacker/repo-platform/actions/yamllint@v1",
      "        if: '!cancelled()'",
      ...MERGED_STEPS.slice(8),
    ];
    const { exitCode, stdout, stderr } = runValidator({
      ".copier-answers.yml": PRIVATE_ANSWERS,
      ".github/workflows/ci.yml": mergedCi(steps),
    });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("base-checks is missing the yamllint check");
    expect(stdout).not.toContain("missing the actionlint check");
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

  test("a split file carries its declared marker line exactly once", () => {
    const marker = "# repo-platform:local-section\n";
    const missing = runValidator({ ".editorconfig": "root = true\n" });
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain(".editorconfig: the '# repo-platform:local-section' marker");
    const once = runValidator({ ".editorconfig": `root = true\n${marker}` });
    expect(once.stderr).toBe("");
    expect(once.exitCode).toBe(0);
    const twice = runValidator({ ".editorconfig": `root = true\n${marker}${marker}` });
    expect(twice.exitCode).toBe(1);
    expect(twice.stderr).toContain("appears 2 times");
  });

  test("the OTHER marker spelling does not satisfy the declared one", () => {
    // .editorconfig declares the hash spelling; an HTML-comment marker is
    // not its marker (the table carries the exact line, not a family).
    const { exitCode, stderr } = runValidator({
      ".editorconfig": "root = true\n<!-- repo-platform:local-section -->\n",
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(".editorconfig: the '# repo-platform:local-section' marker");
  });

  test("a prose mention of the marker is not the marker line", () => {
    const { exitCode, stderr } = runValidator({
      ".editorconfig": "root = true\n# rules go below the repo-platform:local-section marker\n",
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(".editorconfig: the '# repo-platform:local-section' marker");
  });

  test("an indented marker line still counts - markers match by trimmed equality", () => {
    // The fleet-wide marker-matching convention is exact TRIMMED lines:
    // this validator's marker count, its managed-half slicing, and the
    // sync side's split rebuild all share it, so an indented marker is
    // still the marker (and the auto-stamped manifest's half, sliced the
    // same way, passes parity against it).
    const { exitCode, stderr } = runValidator({
      ".editorconfig": "root = true\n  # repo-platform:local-section\nrepo tail\n",
    });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
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
    expect(fleet.stderr).toContain("LICENSE.md: the '<!-- repo-platform:local-section -->' marker");
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
    expect(bare.stderr).toContain("AGENTS.md: the '<!-- repo-platform:local-section -->' marker");
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
  const sha = shaLatin1;
  const manifestOf = (entries: Record<string, string>) =>
    `{\n  "$comment": "test",\n  "files": {\n${Object.entries(entries)
      .map(([path, body]) => `    ${JSON.stringify(path)}: ${body}`)
      .join(",\n")}\n  }\n}\n`;
  const SELF_ENTRY = {
    [MANIFEST]: '{"class": "managed", "hash": null, "commit": "0.0.0.post5.dev0+abc1234"}',
  };
  // The full roster for the BASELINE tree: absence checks are strict, so a
  // passing fixture must list every table-covered path whose file exists.
  const GITIGNORE_HALF = "# BEGIN REPO-PLATFORM MANAGED\n# END REPO-PLATFORM MANAGED\n";
  const stampedBaseline = () => ({
    ...SELF_ENTRY,
    ".copier-answers.yml": `{"class": "managed", "hash": "${sha(
      BASELINE[".copier-answers.yml"],
    )}"}`,
    ".repo-platform.yml": `{"class": "managed", "hash": "${sha(BASELINE[".repo-platform.yml"])}"}`,
    ".github/workflows/ci.yml": `{"class": "managed", "hash": "${sha(
      BASELINE[".github/workflows/ci.yml"],
    )}"}`,
    ".gitignore":
      `{"class": "split", "grammar": "bounded-region", ` +
      `"marker": "# BEGIN REPO-PLATFORM MANAGED", "managed": "below", ` +
      `"managed_end": "# END REPO-PLATFORM MANAGED", ` +
      `"local_begin": "# BEGIN REPOSITORY LOCAL", ` +
      `"local_end": "# END REPOSITORY LOCAL", "hash": "${sha(GITIGNORE_HALF)}"}`,
  });

  test("a missing manifest is an error", () => {
    const { exitCode, stderr } = runValidator({}, [], { noManifest: true });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(`${MANIFEST} is missing - every build ships it`);
  });

  test("a stamped manifest with matching hashes passes", () => {
    const { exitCode, stderr } = runValidator({ [MANIFEST]: manifestOf(stampedBaseline()) });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });

  test("a drifted managed file fails parity", () => {
    const entries = {
      ...stampedBaseline(),
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
        `{"class": "split", "grammar": "tail-marker", ` +
        `"marker": "<!-- repo-platform:local-section -->", ` +
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
    const entries = { ...stampedBaseline(), ".yamllint": '{"class": "managed", "hash": null}' };
    const { exitCode, stderr } = runValidator({
      [MANIFEST]: manifestOf(entries),
      ".yamllint": "extends: default\n",
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(".yamllint: .github/repo-platform-manifest.json records no hash");
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

  test("an unlisted roster path whose file is absent too stays an advisory", () => {
    // The strict deletion error requires the missing entry's FILE to still
    // exist: roster paths the baseline tree does not carry (SECURITY.md and
    // friends) stay advisories - the version splits the fleet legitimately
    // produces (withheld workflow files; a main-floating client validator
    // ahead of the render) look exactly like this.
    const { exitCode, stdout, stderr } = runValidator({
      [MANIFEST]: manifestOf(stampedBaseline()),
    });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain(
      "advisory: .github/repo-platform-manifest.json does not list 'SECURITY.md'",
    );
    expect(stdout).toContain("the path is absent from the repo too");
  });

  // Absence and provenance are STRICT: every build ships the manifest and
  // the stamper always writes the recorded _commit, so a missing manifest,
  // a stamp differing from the recorded value, and a deleted roster entry
  // whose file still exists are errors on every render.
  test("a deleted roster entry whose file still exists is an error", () => {
    // THE deletion attack: drop ci.yml's entry, edit the file under its
    // header - without strict absence this would ride an advisory.
    const entries = { ...stampedBaseline() } as Record<string, string>;
    delete entries[".github/workflows/ci.yml"];
    const { exitCode, stderr } = runValidator({
      [MANIFEST]: manifestOf(entries),
      ".github/workflows/ci.yml": `${BASELINE[".github/workflows/ci.yml"]}# local tweak\n`,
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(
      ".github/repo-platform-manifest.json does not list '.github/workflows/ci.yml'",
    );
    expect(stderr).toContain("the entry was deleted by hand");
  });

  test("a nulled or mismatched provenance stamp is an error", () => {
    // Nulling the self entry's commit must not buy any lenient path: the
    // stamper always writes the recorded _commit.
    const nulled = runValidator({
      [MANIFEST]: manifestOf({
        ...stampedBaseline(),
        [MANIFEST]: '{"class": "managed", "hash": null}',
      }),
    });
    expect(nulled.exitCode).toBe(1);
    expect(nulled.stderr).toContain("its provenance stamp is null but the render records _commit");
    const mismatched = runValidator({
      [MANIFEST]: manifestOf({
        ...stampedBaseline(),
        [MANIFEST]: '{"class": "managed", "hash": null, "commit": "0.0.0.post4.dev0+dead999"}',
      }),
    });
    expect(mismatched.exitCode).toBe(1);
    expect(mismatched.stderr).toContain("stamped provenance");
  });

  test("a provenance error downgrades absence to an advisory naming it", () => {
    // One diagnostic per cause: under an already-reported provenance error,
    // a missing roster entry must not pile a second error per path on the
    // same tamper - but every absence still surfaces as an advisory.
    const entries = { ...stampedBaseline() } as Record<string, string>;
    delete entries[".github/workflows/ci.yml"];
    entries[MANIFEST] = '{"class": "managed", "hash": null}';
    const { exitCode, stdout, stderr } = runValidator({ [MANIFEST]: manifestOf(entries) });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("its provenance stamp is null");
    expect(stderr).not.toContain("the entry was deleted by hand");
    expect(stdout).toContain("does not list '.github/workflows/ci.yml'");
    expect(stdout).toContain("its provenance stamp is unusable (error above)");
  });

  test("an exponent-shaped build sha reads as a string, not a YAML float", () => {
    // PyYAML (copier's writer) dumps shas like 95e1875 UNQUOTED (its float
    // pattern needs a dot or signed exponent); the yaml core schema reads
    // digits-e-digits as Infinity. A typed read turned ~2% of build shas
    // into a false tampering report; the failsafe re-read keeps them
    // strings, so a matching stamp passes with no missing-_commit text.
    const exponentSha = runValidator({
      ".copier-answers.yml": `${MANAGED_HEADER}_commit: 95e1875\n_src_path: gh:Vivswan/repo-platform\ngithub_username: Vivswan\n`,
      [MANIFEST]: manifestOf({
        [MANIFEST]: '{"class": "managed", "hash": null, "commit": "95e1875"}',
      }),
    });
    expect(exponentSha.stderr).not.toContain("stamped provenance");
    expect(exponentSha.stderr).not.toContain("no _commit in .copier-answers.yml");
  });

  test("the exponent-shaped sha still feeds the provenance check (positive oracle)", () => {
    // The absence assertions above would also pass if provenance checking
    // silently stopped running. Same bare-exponent _commit, mismatched
    // stamp: the error must fire AND quote 95e1875 as the recorded value,
    // proving the failsafe read returned the string and the check ran.
    const mismatched = runValidator({
      ".copier-answers.yml": `${MANAGED_HEADER}_commit: 95e1875\n_src_path: gh:Vivswan/repo-platform\ngithub_username: Vivswan\n`,
      [MANIFEST]: manifestOf({
        [MANIFEST]: '{"class": "managed", "hash": null, "commit": "zzz9999"}',
      }),
    });
    expect(mismatched.exitCode).toBe(1);
    expect(mismatched.stderr).toContain("stamped provenance");
    expect(mismatched.stderr).toContain(
      "(self-entry commit 'zzz9999') does not match the recorded render 95e1875",
    );
  });

  test("a key-deleted _commit against a non-null stamp is an error", () => {
    // The stamper always writes the recorded _commit, so a stamp with no
    // recorded counterpart is the same tamper as a differing value.
    const keyDeleted = runValidator({
      ".copier-answers.yml": `${MANAGED_HEADER}_src_path: gh:Vivswan/repo-platform\ngithub_username: Vivswan\n`,
      [MANIFEST]: manifestOf({
        [MANIFEST]: '{"class": "managed", "hash": null, "commit": "0.0.0.post5.dev0+abc1234"}',
      }),
    });
    expect(keyDeleted.exitCode).toBe(1);
    expect(keyDeleted.stderr).toContain("no _commit in .copier-answers.yml");
  });

  test("a public-only entry on a private render is manifest drift", () => {
    // CONTRIBUTING.md renders only on public repos: a manifest entry for
    // it on a private render cannot come from the template.
    const privateAnswers =
      `${MANAGED_HEADER}_commit: 0.0.0.post5.dev0+abc1234\n_src_path: gh:Vivswan/repo-platform\n` +
      "github_username: Vivswan\nprivate: true\n";
    const entries = {
      ...stampedBaseline(),
      ".copier-answers.yml": `{"class": "managed", "hash": "${sha(privateAnswers)}"}`,
      "CONTRIBUTING.md":
        `{"class": "split", "grammar": "tail-marker", ` +
        `"marker": "<!-- repo-platform:local-section -->", "managed": "above", ` +
        `"hash": "${"a".repeat(64)}"}`,
    };
    const { exitCode, stderr } = runValidator({
      ".copier-answers.yml": privateAnswers,
      [MANIFEST]: manifestOf(entries),
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("entry 'CONTRIBUTING.md' should not exist for this render");
  });

  test("a LICENSE.md entry with custom-license selected is manifest drift", () => {
    // The custom-license module de-renders the fleet LICENSE.md; the repo
    // owns its license, so a manifest entry claiming it cannot come from
    // the template.
    const registration = `${MANAGED_HEADER}modules: [uv, custom-license]\n`;
    const entries = {
      ...stampedBaseline(),
      ".repo-platform.yml": `{"class": "managed", "hash": "${sha(registration)}"}`,
      "LICENSE.md":
        `{"class": "split", "grammar": "tail-marker", ` +
        `"marker": "<!-- repo-platform:local-section -->", "managed": "above", ` +
        `"hash": "${"a".repeat(64)}"}`,
    };
    const { exitCode, stderr } = runValidator({
      ".repo-platform.yml": registration,
      [MANIFEST]: manifestOf(entries),
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("entry 'LICENSE.md' should not exist for this render");
  });

  test("a tree carrying the base marker roster passes against the mirror-stamped manifest", () => {
    // The mirror-coverage claim's teeth: this fixture carries every base
    // marker/header path the mirror declares (plus the agents module's
    // AGENTS.md), all validated through the auto-stamped manifest - a
    // drifted mirror entry for any of them fails the roster cross-check
    // here instead of sitting inert.
    const registration = `${MANAGED_HEADER}modules: [uv, agents]\n`;
    const { exitCode, stderr } = runValidator({
      ".repo-platform.yml": registration,
      ".editorconfig": "# repo-platform:local-section\n[*]\nindent_size = 2\n",
      ".gitattributes": "# repo-platform:local-section\n*.bin binary\n",
      ".github/CODEOWNERS": "# repo-platform:local-section\n/docs/ @Vivswan\n",
      ".github/dependabot.yml": `${MANAGED_HEADER}version: 2\nupdates: []\n`,
      ".typography-allow": `${MANAGED_HEADER}`,
      ".yamllint": `${MANAGED_HEADER}extends: default\n`,
      "CODE_OF_CONDUCT.md": `${MANAGED_HEADER}\n# Contributor Covenant Code of Conduct\n`,
      "CONTRIBUTING.md": "# Contributing\n\n<!-- repo-platform:local-section -->\n",
      "LICENSE.md": "# License\n\n<!-- repo-platform:local-section -->\n",
      "SECURITY.md": "# Security\n\n<!-- repo-platform:local-section -->\n",
      "AGENTS.md": "# AGENTS.md\n\n<!-- repo-platform:local-section -->\n",
    });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
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
        `{"class": "split", "grammar": "tail-marker", ` +
        `"marker": "<!-- repo-platform:local-section -->", ` +
        `"managed": "below", "hash": "${sha(managedTop)}"}`,
    };
    const { exitCode, stderr } = runValidator({
      [MANIFEST]: manifestOf(entries),
      "SECURITY.md": `${managedTop}tail\n`,
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("carries split metadata outside its declared tail-marker grammar");
  });

  test("a wrong marker spelling on a roster path fails the cross-check", () => {
    // The tables carry the DECLARED marker line: SECURITY.md's is the HTML
    // form, so the hash spelling is drift even though it is a real marker.
    const managedTop = "# Security\n# repo-platform:local-section\n";
    const entries = {
      ...stampedBaseline(),
      "SECURITY.md":
        `{"class": "split", "grammar": "tail-marker", ` +
        `"marker": "# repo-platform:local-section", ` +
        `"managed": "above", "hash": "${sha(managedTop)}"}`,
    };
    const { exitCode, stderr } = runValidator({
      [MANIFEST]: manifestOf(entries),
      "SECURITY.md": `${managedTop}tail\n<!-- repo-platform:local-section -->\n`,
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("carries split metadata outside its declared tail-marker grammar");
  });

  test("a grammar-bearing entry must name the declared grammar on a tail path", () => {
    const managedTop = "# Security\n<!-- repo-platform:local-section -->\n";
    const entries = {
      ...stampedBaseline(),
      "SECURITY.md":
        `{"class": "split", "grammar": "bounded-region", ` +
        `"marker": "<!-- repo-platform:local-section -->", "managed": "below", ` +
        `"managed_end": "x", "local_begin": "y", "local_end": "z", ` +
        `"hash": "${sha(managedTop)}"}`,
    };
    const { exitCode, stderr } = runValidator({
      [MANIFEST]: manifestOf(entries),
      "SECURITY.md": `${managedTop}tail\n`,
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("carries split metadata outside its declared tail-marker grammar");
  });

  test("a grammar-carrying tail entry matching the declaration passes", () => {
    const managedTop = "# Security\n<!-- repo-platform:local-section -->\n";
    const entries = {
      ...stampedBaseline(),
      "SECURITY.md":
        `{"class": "split", "grammar": "tail-marker", ` +
        `"marker": "<!-- repo-platform:local-section -->", "managed": "above", ` +
        `"hash": "${sha(managedTop)}"}`,
    };
    const { exitCode, stderr } = runValidator({
      [MANIFEST]: manifestOf(entries),
      "SECURITY.md": `${managedTop}repo tail\n`,
    });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
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

  test("a bounded-region .gitignore entry matching the declared grammar passes", () => {
    const gitignoreHalf = "# BEGIN REPO-PLATFORM MANAGED\n# END REPO-PLATFORM MANAGED\n";
    const entries = {
      ...stampedBaseline(),
      ".gitignore":
        `{"class": "split", "grammar": "bounded-region", ` +
        `"marker": "# BEGIN REPO-PLATFORM MANAGED", "managed": "below", ` +
        `"managed_end": "# END REPO-PLATFORM MANAGED", ` +
        `"local_begin": "# BEGIN REPOSITORY LOCAL", ` +
        `"local_end": "# END REPOSITORY LOCAL", "hash": "${sha(gitignoreHalf)}"}`,
    };
    const { exitCode, stderr } = runValidator({ [MANIFEST]: manifestOf(entries) });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });

  test("a bounded-region entry with drifted region markers fails the cross-check", () => {
    const gitignoreHalf = "# BEGIN REPO-PLATFORM MANAGED\n# END REPO-PLATFORM MANAGED\n";
    const entries = {
      ...stampedBaseline(),
      ".gitignore":
        `{"class": "split", "grammar": "bounded-region", ` +
        `"marker": "# BEGIN REPO-PLATFORM MANAGED", "managed": "below", ` +
        `"managed_end": "# END REPO-PLATFORM MANAGED", ` +
        `"local_begin": "# BEGIN SOMETHING ELSE", ` +
        `"local_end": "# END REPOSITORY LOCAL", "hash": "${sha(gitignoreHalf)}"}`,
    };
    const { exitCode, stderr } = runValidator({ [MANIFEST]: manifestOf(entries) });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("'.gitignore' does not match the managed-section grammar");
  });

  test("an unknown split grammar on an uncovered path is a structural error", () => {
    const entries = {
      ...stampedBaseline(),
      "docs/notes.md":
        `{"class": "split", "grammar": "prefix", "marker": "# m", "managed": "above", ` +
        `"hash": "${"d".repeat(64)}"}`,
    };
    const { exitCode, stderr } = runValidator({
      [MANIFEST]: manifestOf(entries),
      "docs/notes.md": "# m\n",
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain('declares unknown split grammar "prefix"');
  });

  test("a grammar disagreeing with its managed side is a structural error", () => {
    const entries = {
      ...stampedBaseline(),
      "docs/notes.md":
        `{"class": "split", "grammar": "tail-marker", "marker": "# m", "managed": "below", ` +
        `"hash": "${"d".repeat(64)}"}`,
    };
    const { exitCode, stderr } = runValidator({
      [MANIFEST]: manifestOf(entries),
      "docs/notes.md": "# m\n",
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain('tail-marker grammar with a managed half not "above"');
  });

  test("a bounded-region entry without its region strings is a structural error", () => {
    const entries = {
      ...stampedBaseline(),
      "docs/notes.md":
        `{"class": "split", "grammar": "bounded-region", "marker": "# m", ` +
        `"managed": "below", "hash": "${"d".repeat(64)}"}`,
    };
    const { exitCode, stderr } = runValidator({
      [MANIFEST]: manifestOf(entries),
      "docs/notes.md": "# m\n",
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain('bounded-region grammar without a "below" managed');
  });

  test("a split entry with no grammar field is an error", () => {
    // Every render stamps the grammar; a grammar-less split entry can only
    // be a hand edit, whatever path it sits on.
    const entries = {
      ...stampedBaseline(),
      "docs/notes.md": `{"class": "split", "marker": "# m", "managed": "above", "hash": "${"d".repeat(64)}"}`,
    };
    const { exitCode, stderr } = runValidator({
      [MANIFEST]: manifestOf(entries),
      "docs/notes.md": "# m\n",
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("lacks the split grammar field every render stamps");
  });

  test("a grammar-less split entry on a roster path draws ONE diagnostic", () => {
    // The missing field is the structural loop's report alone; the roster
    // cross-check judges only present-but-disagreeing metadata, so one
    // cause does not pile two conflicting recovery instructions.
    const managedTop = "# Security\n<!-- repo-platform:local-section -->\n";
    const entries = {
      ...stampedBaseline(),
      "SECURITY.md":
        `{"class": "split", "marker": "<!-- repo-platform:local-section -->", ` +
        `"managed": "above", "hash": "${sha(managedTop)}"}`,
    };
    const { exitCode, stderr } = runValidator({
      [MANIFEST]: manifestOf(entries),
      "SECURITY.md": `${managedTop}tail\n`,
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("lacks the split grammar field every render stamps");
    expect(stderr).not.toContain("carries split metadata outside its declared tail-marker grammar");
  });

  test("a grammar-less .gitignore split entry is the structural loop's single report", () => {
    // The marker/managed pair alone no longer passes silently: every
    // render stamps the grammar, so its absence is a hand edit even when
    // the derived pair still looks right.
    const entries = {
      ...stampedBaseline(),
      ".gitignore":
        `{"class": "split", "marker": "# BEGIN REPO-PLATFORM MANAGED", ` +
        `"managed": "below", "hash": "${sha(GITIGNORE_HALF)}"}`,
    };
    const { exitCode, stderr } = runValidator({ [MANIFEST]: manifestOf(entries) });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("lacks the split grammar field every render stamps");
    expect(stderr).not.toContain("does not match the managed-section grammar");
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

  test("a legacy mergeable entry is an error naming the retirement", () => {
    // Old renders' manifests still class settings.yml mergeable; the class
    // is retired (the file is a starter now), and a manifest claiming it
    // predates that sync - the error says the next sync re-renders it.
    const entries = {
      ...stampedBaseline(),
      ".github/settings.yml": '{"class": "mergeable"}',
    };
    const { exitCode, stderr } = runValidator({
      ".repo-platform.yml": `${MANAGED_HEADER}modules: [uv, settings-sync]\n`,
      [MANIFEST]: manifestOf(entries),
      ".github/settings.yml": "repository:\n  has_issues: true\n",
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain('has class "mergeable", which is retired');
  });

  test("a settings.yml starter entry passes: the file is repo-owned", () => {
    const registration = `${MANAGED_HEADER}modules: [uv, settings-sync]\n`;
    const entries = {
      ...stampedBaseline(),
      ".repo-platform.yml": `{"class": "managed", "hash": "${sha(registration)}"}`,
      ".github/settings.yml": '{"class": "starter"}',
    };
    const { exitCode, stdout, stderr } = runValidator({
      ".repo-platform.yml": registration,
      [MANIFEST]: manifestOf(entries),
      ".github/settings.yml": "repository:\n  has_issues: true\n  custom_addition: true\n",
    });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain(".github/settings.yml");
  });

  test("an unknown class names the whole vocabulary", () => {
    // An uncovered path, so the structural loop's report is probed alone
    // (a roster path would draw the cross-check error first).
    const entries = {
      ...stampedBaseline(),
      "docs/handbook.md": '{"class": "bespoke"}',
    };
    const { exitCode, stderr } = runValidator({ [MANIFEST]: manifestOf(entries) });
    expect(exitCode).toBe(1);
    expect(stderr).toContain('has unknown class "bespoke" (expected managed, split, or starter)');
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
        `{"class": "split", "grammar": "tail-marker", "marker": "# no-such-marker", ` +
        `"managed": "above", "hash": "${"c".repeat(64)}"}`,
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

  test("validator and stamper split a multibyte-whitespace decoy line the same way", () => {
    // A UTF-8 decode + trim reads these decoy lines as the marker (JS
    // trim() strips U+00A0 and U+2003), but the stamper and the sync
    // rebuild match latin1 BYTES, where the same lines carry
    // non-whitespace characters. The validator must count markers and
    // split halves exactly where the stamper stamped, or sync would
    // deliver trees the validator rejects (marker count 2) and parity
    // would report drift on a freshly stamped tree.
    const marker = "# repo-platform:local-section";
    for (const decoy of [`\u00a0${marker}`, `${marker}\u2003`]) {
      const content = `root = true\n${decoy}\nline the utf-8 view would exclude\n${marker}\nrepo tail\n`;
      const latin1 = Buffer.from(content, "utf-8").toString("latin1");
      const half = managedHalfOf(latin1, marker, "above");
      if (half === null) throw new Error("fixture lost its marker line");
      // The fixture is a real decoy: UTF-8 trim semantics would slice at
      // the decoy line instead.
      expect(managedHalfOf(content, marker, "above")).not.toBe(half);
      const entries = {
        ...stampedBaseline(),
        ".editorconfig":
          `{"class": "split", "grammar": "tail-marker", "marker": ${JSON.stringify(marker)}, ` +
          `"managed": "above", "hash": "${sha(half)}"}`,
      };
      const { exitCode, stderr } = runValidator({
        ".editorconfig": content,
        [MANIFEST]: manifestOf(entries),
      });
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
    }
  });

  // The agents module's CLAUDE.md is a symlink: a class-only roster path
  // with no comment channel. These fixtures select agents and land the
  // link so both the parity rule and the cross-check see a real symlink.
  const agentsLinkTree = (claudeEntry: string): string => {
    const root = mkdtempSync(join(tmpdir(), "validate-template-link-"));
    roots.push(root);
    const registration = `${MANAGED_HEADER}modules: [uv, agents]\n`;
    const agentsMd = "# AGENTS.md\n\n<!-- repo-platform:local-section -->\n";
    const tree = { ...BASELINE, ".repo-platform.yml": registration, "AGENTS.md": agentsMd };
    for (const [rel, content] of Object.entries(tree)) {
      mkdirSync(join(root, dirname(rel)), { recursive: true });
      writeFileSync(join(root, rel), content);
    }
    symlinkSync("AGENTS.md", join(root, "CLAUDE.md"));
    writeFileSync(
      join(root, MANIFEST),
      manifestOf({
        ...stampedBaseline(),
        ".repo-platform.yml": `{"class": "managed", "hash": "${sha(registration)}"}`,
        "AGENTS.md":
          `{"class": "split", "grammar": "tail-marker", ` +
          `"marker": "<!-- repo-platform:local-section -->", "managed": "above", ` +
          `"hash": "${sha(agentsMd)}"}`,
        "CLAUDE.md": claudeEntry,
      }),
    );
    return root;
  };

  test("a managed symlink's hash covers the link target", () => {
    const root = agentsLinkTree(`{"class": "managed", "hash": "${sha("AGENTS.md")}"}`);
    const result = Bun.spawnSync([process.execPath, VALIDATOR, root], { env: gitFreeEnv() });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
  });

  test("a symlink-classed path hand-flipped to starter fails the roster cross-check", () => {
    // Symlinks have no header or marker to enforce in-file, so without a
    // class-only roster entry this flip would disable CLAUDE.md's parity
    // permanently and invisibly (sync baselines manifest edits).
    const root = agentsLinkTree('{"class": "starter"}');
    const result = Bun.spawnSync([process.execPath, VALIDATOR, root], { env: gitFreeEnv() });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(`entry 'CLAUDE.md' claims class "starter"`);
    expect(result.stderr.toString()).toContain("ownership tables declare it managed");
  });

  test("a headerless pin dotfile hand-flipped to starter fails the roster cross-check", () => {
    // .bun-version carries no header; the class-only roster entry is what
    // keeps its manifest class honest.
    const registration = `${MANAGED_HEADER}modules: [bun]\n`;
    const entries = {
      ...stampedBaseline(),
      ".repo-platform.yml": `{"class": "managed", "hash": "${sha(registration)}"}`,
      ".bun-version": '{"class": "starter"}',
    };
    const { exitCode, stderr } = runValidator({
      ".repo-platform.yml": registration,
      ".bun-version": "1.3.14\n",
      [MANIFEST]: manifestOf(entries),
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(`entry '.bun-version' claims class "starter"`);
    expect(stderr).toContain("ownership tables declare it managed");
  });

  test("a duplicated manifest key is a hard error naming the path", () => {
    // Two entries for one path: JSON.parse keeps the LAST one silently, so
    // a conflicted resolution keeping a second, starter-classed ci.yml
    // line would switch that file's parity off invisibly. The duplicate is
    // refused before any consumer reads a last-win view.
    const base = stampedBaseline();
    const text = `{\n  "files": {\n${[
      `    ${JSON.stringify(MANIFEST)}: ${base[MANIFEST]}`,
      `    ".github/workflows/ci.yml": ${base[".github/workflows/ci.yml"]}`,
      `    ".github/workflows/ci.yml": {"class": "starter"}`,
    ].join(",\n")}\n  }\n}\n`;
    const { exitCode, stderr } = runValidator({ [MANIFEST]: text });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(`key ".github/workflows/ci.yml" is bound more than once`);
    // The last-win starter view must not have reached the parity loop.
    expect(stderr).not.toContain("a starter carrying a hash");
  });

  test("a duplicated key inside one entry object is refused too", () => {
    const base = stampedBaseline();
    const text = `{\n  "files": {\n${[
      `    ${JSON.stringify(MANIFEST)}: ${base[MANIFEST]}`,
      `    ".github/workflows/ci.yml": {"class": "managed", "class": "starter", "hash": null}`,
    ].join(",\n")}\n  }\n}\n`;
    const { exitCode, stderr } = runValidator({ [MANIFEST]: text });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(`key "class" is bound more than once`);
  });
});
