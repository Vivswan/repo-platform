import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const VALIDATOR = join(import.meta.dir, "validate_generated_files.ts");

// The smallest tree the validator accepts: registration files (opening with
// the managed header check 8 requires), the marked .gitignore, and a ci.yml
// carrying the all-green + typography convention.
const MANAGED_HEADER = "# This file is managed by Vivswan/repo-platform.\n";
const B = "<!-- BEGIN REPO-PLATFORM MANAGED -->";
const E = "<!-- END REPO-PLATFORM MANAGED -->";
const HB = "# BEGIN REPO-PLATFORM MANAGED";
const HE = "# END REPO-PLATFORM MANAGED";
const BASELINE: Record<string, string> = {
  ".github/.copier-answers.yml": `${MANAGED_HEADER}_commit: 0.0.0.post5.dev0+abc1234\n_src_path: gh:Vivswan/repo-platform\ngithub_username: Vivswan\n`,
  // A repo-owned starter (generated once, never rewritten): no managed
  // header, no manifest hash.
  ".repo-platform.yml": "# Generated once by Vivswan/repo-platform; repo-owned.\nmodules: [uv]\n",
  // The ungated base region files: their ABSENCE is strict (the template
  // always generates them), so the minimal accepted tree carries each.
  ".gitignore": `# local patterns go here\n\n${HB}\n${HE}\n`,
  ".editorconfig": `${HB}\nroot = true\n${HE}\n`,
  ".gitattributes": `${HB}\n* text=auto eol=lf\n${HE}\n`,
  ".github/CODEOWNERS": `${HB}\n* @vivswan\n${HE}\n`,
  "SECURITY.md": `${B}\n# Security policy\n${E}\n`,
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
type MirrorEntry = {
  path: string;
  kind: "header" | "region" | "class-only";
  begin?: string;
  end?: string;
  publicOnly?: boolean;
  withoutModule?: string;
};
const MIRROR_BASE: MirrorEntry[] = [
  { path: ".github/.copier-answers.yml", kind: "header" },
  { path: ".editorconfig", kind: "region", begin: HB, end: HE },
  { path: ".gitattributes", kind: "region", begin: HB, end: HE },
  { path: ".github/CODEOWNERS", kind: "region", begin: HB, end: HE },
  { path: ".github/dependabot.yml", kind: "header" },
  { path: ".github/workflows/ci.yml", kind: "header" },
  { path: ".gitignore", kind: "region", begin: HB, end: HE },
  { path: ".typography-allow", kind: "header" },
  { path: ".yamllint", kind: "header" },
  { path: "CODE_OF_CONDUCT.md", kind: "header", publicOnly: true },
  { path: "CONTRIBUTING.md", kind: "region", begin: B, end: E, publicOnly: true },
  { path: "LICENSE.md", kind: "region", begin: B, end: E, withoutModule: "custom-license" },
  { path: "SECURITY.md", kind: "region", begin: B, end: E },
];
const MIRROR_MODULES: Record<string, MirrorEntry[]> = {
  agents: [
    { path: ".github/agents.md", kind: "class-only" },
    { path: ".github/copilot-instructions.md", kind: "class-only" },
    { path: "AGENTS.md", kind: "region", begin: B, end: E },
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

/** Twin of the validator's splitManagedRegion: the managed region from the
 *  first BEGIN marker line through the first END marker line after it
 *  (newline included). */
function regionOf(content: string, begin: string, end: string): string | null {
  const lines = content.split("\n");
  let offset = 0;
  let start = -1;
  for (const line of lines) {
    const lineEnd = offset + line.length;
    if (start === -1) {
      if (line.trim() === begin) start = offset;
    } else if (line.trim() === end) {
      return content.slice(start, Math.min(lineEnd + 1, content.length));
    }
    offset = lineEnd + 1;
  }
  return null;
}

function manifestForTree(tree: Record<string, string>): string {
  const answers = tree[".github/.copier-answers.yml"] ?? "";
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
    // The registration file is a repo-owned starter and every render's
    // manifest lists it hash-free, like the real stamp.
    ".repo-platform.yml": '{"class": "starter"}',
  };
  const expected = [
    ...MIRROR_BASE.filter(
      (entry) =>
        !(entry.publicOnly && isPrivate) &&
        !(entry.withoutModule !== undefined && modules.includes(entry.withoutModule)),
    ),
    ...modules.flatMap((name) => MIRROR_MODULES[name] ?? []),
  ];
  for (const { path, kind, begin, end } of expected) {
    const content = tree[path];
    if (content === undefined) continue;
    if (kind === "header" || kind === "class-only") {
      entries[path] = `{"class": "managed", "hash": "${shaLatin1(content)}"}`;
    } else {
      // A missing or duplicated marker is that check's own report; the
      // manifest still lists the first region the marker pair delimits.
      const region = regionOf(content, begin as string, end as string);
      if (region === null) continue;
      entries[path] =
        `{"class": "split", "grammar": "managed-region", "begin": ${JSON.stringify(begin)}, ` +
        `"end": ${JSON.stringify(end)}, "hash": "${shaLatin1(region)}"}`;
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

  test("reordered .gitignore markers fail even when each appears once", () => {
    // Counting alone would pass this shape, so order is its own rule.
    const { exitCode, stderr } = runValidator({
      ".gitignore": [HE, HB, ""].join("\n"),
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(
      ".gitignore: the BEGIN/END managed-region markers appear out of order",
    );
  });

  // Strictness follows the .github/ prefix (plus the registration file),
  // not template ownership: GitHub's own parsers reject duplicate keys in a
  // workflow anyway, and a three-way merge can duplicate settings.yml's
  // identity keys, where the later value silently wins at apply time.
  test.each([
    {
      reason: "a template-owned settings.yml",
      path: ".github/settings.yml",
      content: DUP_KEY_YAML,
    },
    {
      reason: "a repo-owned (_skip_if_exists) workflow, checks.yml",
      path: ".github/workflows/checks.yml",
      content: "name: Checks\nname: Checks again\non: [push]\n",
    },
    {
      reason: "a document of a multi-document stream (itself a second error there)",
      path: ".github/multi.yml",
      content: "a: 1\na: 2\n---\nb: 3\n",
    },
  ])(
    "a duplicate key under .github/ fails with the tailored message: $reason",
    ({ path, content }) => {
      const { exitCode, stderr } = runValidator({ [path]: content });
      expect(exitCode).toBe(1);
      expect(stderr).toContain(`${path}: duplicate mapping key`);
      expect(stderr).toContain("the later value silently wins");
    },
  );

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

  test("a duplicate key in ci.yml does not also claim the file defines no jobs", () => {
    const withDup = `${BASELINE[".github/workflows/ci.yml"]}\nname: CI again\n`;
    const { exitCode, stderr } = runValidator({ ".github/workflows/ci.yml": withDup });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(".github/workflows/ci.yml: duplicate mapping key");
    // The structural checks re-read the file tolerantly, so they see the
    // real jobs instead of treating it as empty and prescribing a sync.
    expect(stderr).not.toContain("defines no jobs");
  });

  test.each([
    { reason: "a single-document fixture", path: "tests/fixtures/dup.yml", content: DUP_KEY_YAML },
    {
      reason: "a multi-document file",
      path: "deploy/manifests.yml",
      content: "a: 1\na: 2\n---\nb: 3\n",
    },
  ])(
    "a duplicate key outside the strict set is an advisory, not an error: $reason",
    ({ path, content }) => {
      const { exitCode, stdout, stderr } = runValidator({ [path]: content });
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(stdout).toContain(`advisory: ${path}: duplicate mapping key`);
    },
  );
});

describe("YAML syntax errors", () => {
  // Composer-stage errors (doc.errors), reported per document. Outside the
  // strict set a duplicate key is only an advisory, so the masking row pins
  // that a duplicate in the same document cannot hide the syntax error.
  test.each([
    {
      reason: "an unterminated flow sequence in the first document",
      path: "vendor/bad.yml",
      content: "a: [1, 2\n",
    },
    {
      reason: "an unterminated flow sequence in a later document",
      path: "deploy/manifests.yml",
      content: "a: 1\n---\nb: [1, 2\n",
    },
    {
      reason: "a duplicate key cannot mask a syntax error",
      path: "tests/fixtures/broken.yml",
      content: "a: 1\na: 2\nb: [unclosed\n",
    },
  ])("broken YAML outside the managed set still fails: $reason", ({ path, content }) => {
    const { exitCode, stderr } = runValidator({ [path]: content });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(`${path}: does not parse as YAML`);
  });

  test("a duplicate key cannot mask a resolution failure in the same file", () => {
    // doc.errors carries only composer-stage problems; the unresolved
    // alias surfaces at conversion (doc.toJS) and must still fail even
    // though the duplicate key already reported (as an advisory here).
    const { exitCode, stderr } = runValidator({
      "deploy/manifests.yml": "a: 1\na: 2\nb: *nope\n",
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("deploy/manifests.yml: does not parse as YAML");
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

  test("a VALID multi-document .github/ file still fails - GitHub reads one mapping", () => {
    const { exitCode, stderr } = runValidator({
      ".github/dependabot.yml": "version: 2\nupdates: []\n---\nversion: 2\n",
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(".github/dependabot.yml: multi-document YAML stream");
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
      ".github/.copier-answers.yml": PRIVATE_ANSWERS,
      ".github/workflows/ci.yml": mergedCi(MERGED_STEPS),
    });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain("consider adding");
  });

  test("each check missing from the merged job gets its own advisory", () => {
    // Steps 0-3: check-typography and validate-commit-names only.
    const { exitCode, stdout, stderr } = runValidator({
      ".github/.copier-answers.yml": PRIVATE_ANSWERS,
      ".github/workflows/ci.yml": mergedCi(MERGED_STEPS.slice(0, 4)),
    });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("base-checks is missing the actionlint check");
    expect(stdout).toContain("base-checks is missing the yamllint check");
    expect(stdout).toContain("base-checks is missing the gitleaks check");
    expect(stdout).not.toContain("missing the commit-names check");
  });

  // One predicate decides the merged typography step: a uses matcher
  // anchored to the pinned owner's full action identity, AND the step must
  // be unconditional. Each row substitutes the first step of MERGED_STEPS.
  test.each([
    {
      reason: "the step is disabled by if: false",
      stepLines: [
        "      - uses: Vivswan/repo-platform/actions/check-typography@main",
        "        if: false",
      ],
    },
    {
      reason: "a look-alike action name",
      stepLines: ["      - uses: Vivswan/repo-platform/actions/check-typography-disabled@main"],
    },
    {
      reason: "check-typography from another repository of the pinned owner",
      stepLines: ["      - uses: Vivswan/repo/actions/check-typography@v1"],
    },
    {
      reason: "check-typography from another owner",
      stepLines: ["      - uses: attacker/repo-platform/actions/check-typography@v1"],
    },
  ])(
    "a merged ci.yml lacking an owned, unconditional check-typography step fails: $reason",
    ({ stepLines }) => {
      const { exitCode, stderr } = runValidator({
        ".github/.copier-answers.yml": PRIVATE_ANSWERS,
        ".github/workflows/ci.yml": mergedCi([...stepLines, ...MERGED_STEPS.slice(2)]),
      });
      expect(exitCode).toBe(1);
      expect(stderr).toContain("no unconditional check-typography step");
    },
  );

  test.each([
    {
      reason: "the key is absent",
      answers: "_commit: 0.0.0.post5.dev0+abc1234\n_src_path: gh:Vivswan/repo-platform\n",
    },
    {
      reason: "the value carries regex metacharacters and a slash",
      answers:
        "_commit: 0.0.0.post5.dev0+abc1234\n_src_path: gh:Vivswan/repo-platform\n" +
        "github_username: attacker/repo.*\n",
    },
  ])("a managed render whose answers cannot pin an owner fails: $reason", ({ answers }) => {
    const { exitCode, stderr } = runValidator({ ".github/.copier-answers.yml": answers });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("`github_username` is missing or not a GitHub username");
  });

  test("a quoted github_username is read as its YAML value", () => {
    const { exitCode, stderr } = runValidator({
      ".github/.copier-answers.yml":
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
        ".github/.copier-answers.yml": "_commit: abc\n_src_path: /tmp/src\n",
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
      "        if: ${{ !cancelled() }}",
    ];
    const { exitCode, stdout, stderr } = runValidator({
      ".github/.copier-answers.yml": PRIVATE_ANSWERS,
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
      ".github/.copier-answers.yml": PRIVATE_ANSWERS,
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
      ".github/.copier-answers.yml": PRIVATE_ANSWERS,
      ".github/workflows/ci.yml": mergedCi(steps),
    });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("base-checks is missing the yamllint check");
    expect(stdout).not.toContain("missing the actionlint check");
  });

  test("base-checks outside all-green's needs fails", () => {
    const { exitCode, stderr } = runValidator({
      ".github/.copier-answers.yml": PRIVATE_ANSWERS,
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

describe("the single-call gate shape", () => {
  // The meta-check inversion: the required check is the all-green JOB's
  // own check run, so client renders carry checks + ci + all-green, and
  // the fleet-ci caller must exist unconditional (a skipped caller
  // stands down from the gate and every fleet gate silently drops).
  const gateCi = (ciJob: string[] = [], gate: string[] = []): string =>
    [
      "# This file is managed by Vivswan/repo-platform.",
      "name: CI",
      "jobs:",
      "  checks:",
      "    uses: ./.github/workflows/checks.yml",
      ...(ciJob.length > 0
        ? ciJob
        : ["  ci:", "    uses: Vivswan/repo-platform/.github/workflows/fleet-ci.yml@build"]),
      ...(gate.length > 0
        ? gate
        : [
            "  all-green:",
            "    needs: [checks, ci]",
            "    if: always()",
            "    runs-on: ubuntu-latest",
            "    steps:",
            "      - uses: Vivswan/repo-platform/actions/all-green@build",
            "        with:",
            "          needs: ${{ toJSON(needs) }}",
          ]),
      "",
    ].join("\n");
  const GATE_CI = gateCi();

  test("the single-call gate shape passes", () => {
    const { exitCode, stderr } = runValidator({
      ".github/workflows/ci.yml": GATE_CI,
    });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });

  test.each<{ reason: string; ciJob: string[] }>([
    {
      reason: "no job calls it at all (a decoy run job in its place)",
      ciJob: ["  ci:", "    runs-on: ubuntu-latest", "    steps: [{ run: echo decoy }]"],
    },
    {
      reason: "a look-alike under another owner",
      ciJob: ["  ci:", "    uses: evil/repo-platform/.github/workflows/fleet-ci.yml@build"],
    },
  ])(
    "a ci.yml without the owned fleet-ci caller fails (every fleet gate silently dropped): $reason",
    ({ ciJob }) => {
      const { exitCode, stderr } = runValidator({ ".github/workflows/ci.yml": gateCi(ciJob) });
      expect(exitCode).toBe(1);
      expect(stderr).toContain("no job calls repo-platform's fleet-ci.yml");
    },
  );

  test("a conditioned fleet-ci caller fails (a skipped caller stands down from the gate)", () => {
    const { exitCode, stderr } = runValidator({
      ".github/workflows/ci.yml": gateCi([
        "  ci:",
        "    if: false",
        "    uses: Vivswan/repo-platform/.github/workflows/fleet-ci.yml@build",
      ]),
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("fleet-ci caller job carries a job-level if:");
  });

  test("no all-green job fails - the required check is never created", () => {
    const { exitCode, stderr } = runValidator({
      ".github/workflows/ci.yml": gateCi([], ["  info-none:", "    needs: [checks, ci]"]),
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("no `all-green` job");
  });

  // One predicate (judgesThroughAction) decides the judgment step: the
  // repo-platform all-green action (any owner), unconditioned and
  // unsoftened, with the live needs context wired in.
  const ACTION_STEP = "      - uses: Vivswan/repo-platform/actions/all-green@build";
  const mutateGate = (from: string, to: string): string => {
    if (!GATE_CI.includes(from)) throw new Error(`GATE_CI fixture lost its ${from.trim()} line`);
    return GATE_CI.replace(from, to);
  };
  test.each([
    {
      reason: "a bare run step",
      ci: gateCi(
        [],
        [
          "  all-green:",
          "    needs: [checks, ci]",
          "    if: always()",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - run: echo unjudged",
        ],
      ),
    },
    {
      reason: "an all-green action from another repository",
      ci: mutateGate(
        "Vivswan/repo-platform/actions/all-green@build",
        "Vivswan/other-repo/actions/all-green@main",
      ),
    },
    {
      reason: "a conditioned action step (the YAML parser normalizes a quoted if: key too)",
      ci: mutateGate(
        ACTION_STEP,
        '      - "if": false\n        uses: Vivswan/repo-platform/actions/all-green@build',
      ),
    },
    {
      reason: "a softened action step (continue-on-error)",
      ci: mutateGate(
        ACTION_STEP,
        "      - continue-on-error: true\n        uses: Vivswan/repo-platform/actions/all-green@build",
      ),
    },
    {
      reason: "a canned needs input (judges a fiction of the run)",
      ci: mutateGate(
        "          needs: ${{ toJSON(needs) }}",
        '          needs: \'{"ci": {"result": "success"}}\'',
      ),
    },
  ])(
    "an all-green job without the owned, wired, unconditioned action has no judgment step: $reason",
    ({ ci }) => {
      const { exitCode, stderr } = runValidator({ ".github/workflows/ci.yml": ci });
      expect(exitCode).toBe(1);
      expect(stderr).toContain("no judgment step");
    },
  );

  test("a caller job missing from the gate's needs fails", () => {
    const unneeded = GATE_CI.replace("needs: [checks, ci]", "needs: [checks]");
    const { exitCode, stderr } = runValidator({ ".github/workflows/ci.yml": unneeded });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("all-green `needs:` is missing job(s): ci");
  });

  test("a gate without exactly if: always() fails", () => {
    for (const mutated of [
      GATE_CI.replace("    if: always()\n", ""),
      GATE_CI.replace("if: always()", "if: success()"),
    ]) {
      const { exitCode, stderr } = runValidator({ ".github/workflows/ci.yml": mutated });
      expect(exitCode).toBe(1);
      expect(stderr).toContain("must carry exactly `if: always()`");
    }
  });

  test("gate-downstream jobs (needs: [all-green]) are exempt from the needs census", () => {
    const withRelease = `${GATE_CI}  release:\n    needs: [all-green]\n    uses: ./.github/workflows/release.yml\n`;
    const { exitCode, stderr } = runValidator({ ".github/workflows/ci.yml": withRelease });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
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
      "LICENSE.md": `${B}\n# License\n${E}\n`,
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

describe("release-please-config.json never pins a version", () => {
  const config = (pkg: Record<string, unknown>, top: Record<string, unknown> = {}) =>
    JSON.stringify({ ...top, packages: { ".": { "release-type": "simple", ...pkg } } });

  test.each([
    {
      reason: "a pin-free config passes",
      file: config({ "force-tag-creation": true }),
      exitCode: 0,
      stderr: "",
    },
    {
      reason: "a package-level release-as fails, naming the package and the footer",
      file: config({ "release-as": "4.0.0" }),
      exitCode: 1,
      stderr: 'release-please-config.json pins a version with release-as at package ".": ',
    },
    {
      reason: "a top-level release-as fails too",
      file: config({}, { "release-as": "4.0.0" }),
      exitCode: 1,
      stderr: "release-please-config.json pins a version with release-as at the top level: ",
    },
    {
      reason: "both spots are named at once",
      file: config({ "release-as": "4.0.0" }, { "release-as": "4.0.0" }),
      exitCode: 1,
      stderr: 'pins a version with release-as at the top level and package ".": ',
    },
    {
      reason: "a null value is still a pin (release-please reads key presence)",
      file: config({ "release-as": null }),
      exitCode: 1,
      stderr: 'release-please-config.json pins a version with release-as at package ".": ',
    },
    {
      reason: "an empty string is still a pin",
      file: config({ "release-as": "" }),
      exitCode: 1,
      stderr: 'release-please-config.json pins a version with release-as at package ".": ',
    },
    {
      reason: "a malformed config is an error, not a silent pass",
      file: "{ not json",
      exitCode: 1,
      stderr: "release-please-config.json: not valid JSON",
    },
  ])("$reason", ({ file, exitCode, stderr }) => {
    const r = runValidator({ "release-please-config.json": file });
    expect(r.exitCode).toBe(exitCode);
    if (stderr === "") expect(r.stderr).toBe("");
    else {
      expect(r.stderr).toContain(stderr);
      expect(r.stderr).toContain("1 error(s).");
      // Every pin report carries the footer recipe; a parse failure has
      // nothing to recommend yet.
      expect(r.stderr.includes('-m "Release-As: 5.0.0"')).toBe(stderr.includes("pins a version"));
    }
  });

  test("a conflict-marked config gets check 4's report alone, not a JSON error on top", () => {
    const r = runValidator({
      "release-please-config.json": `<<<<<<< HEAD\n${config({})}\n=======\n${config({ "release-as": "4.0.0" })}\n>>>>>>> theirs\n`,
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("release-please-config.json");
    expect(r.stderr).toContain("conflict");
    expect(r.stderr).not.toContain("not valid JSON");
    expect(r.stderr).not.toContain("pins a version");
  });

  test("self mode checks the config too", () => {
    const r = runValidator({ "release-please-config.json": config({ "release-as": "4.0.0" }) }, [
      "--self",
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("pins a version with release-as at package");
  });

  test("no config file means nothing to check", () => {
    const r = runValidator();
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
  });
});

describe("ownership self-declarations", () => {
  const C1 =
    "# This file is managed by Vivswan/repo-platform.\n" +
    "# Local edits may be replaced during template updates.\n";

  // One anchored regex over the file's opening HEADER_WINDOW lines decides
  // the header: the pinned owner, then the canonical repo name and period
  // with no repo-name character after it (GitHub allows [A-Za-z0-9._-], so
  // every continuation character must fail the anchor).
  test.each([
    { reason: "no header at all", content: "extends: default\n" },
    {
      reason: "another owner's header",
      content: "# This file is managed by attacker/repo-platform.\nextends: default\n",
    },
    {
      reason: "a negated look-alike ('is not managed by')",
      content: "# This file is not managed by Vivswan/repo-platform.\nextends: default\n",
    },
    {
      reason: "a longer repo name continued with '-'",
      content: "# This file is managed by Vivswan/repo-platform-fork.\nextends: default\n",
    },
    {
      reason: "a longer repo name continued with '_'",
      content: "# This file is managed by Vivswan/repo-platform_fork.\nextends: default\n",
    },
    {
      reason: "a longer repo name continued with '.'",
      content: "# This file is managed by Vivswan/repo-platform.fork.\nextends: default\n",
    },
    {
      reason: "the header buried past the opening lines",
      content: `${"# filler\n".repeat(10)}${C1}extends: default\n`,
    },
  ])("a sync-managed file not opening with the managed header fails: $reason", ({ content }) => {
    const { exitCode, stderr } = runValidator({ ".yamllint": content });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(".yamllint: does not open with the managed header");
  });

  test("a sync-managed file opening with the managed header passes", () => {
    const { exitCode, stderr } = runValidator({ ".yamllint": `${C1}extends: default\n` });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });

  test("a split file carries each region marker exactly once, in order", () => {
    const missing = runValidator({ ".editorconfig": `${HB}\nroot = true\n` });
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain(`.editorconfig: marker '${HE}' appears 0 times`);
    const once = runValidator({ ".editorconfig": `${HB}\nroot = true\n${HE}\n` });
    expect(once.stderr).toBe("");
    expect(once.exitCode).toBe(0);
    const twice = runValidator({ ".editorconfig": `${HB}\n${HB}\nroot = true\n${HE}\n` });
    expect(twice.exitCode).toBe(1);
    expect(twice.stderr).toContain("appears 2 times");
  });

  test("an ungated base region file's ABSENCE is an error (the template always lands it)", () => {
    const root = mkdtempSync(join(tmpdir(), "validate-template-"));
    roots.push(root);
    const tree: Record<string, string> = { ...BASELINE };
    delete tree[".editorconfig"];
    tree[MANIFEST] = manifestForTree(tree);
    for (const [rel, content] of Object.entries(tree)) {
      mkdirSync(join(root, dirname(rel)), { recursive: true });
      writeFileSync(join(root, rel), content);
    }
    const result = Bun.spawnSync([process.execPath, VALIDATOR, root], { env: gitFreeEnv() });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      ".editorconfig is missing - the template always generates it",
    );
  });

  test("the OTHER marker spelling does not satisfy the declared one", () => {
    // .editorconfig declares the hash spelling; the HTML-comment pair is
    // not its pair (the table carries the exact lines, not a family).
    const { exitCode, stderr } = runValidator({
      ".editorconfig": `${B}\nroot = true\n${E}\n`,
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(`.editorconfig: marker '${HB}' appears 0 times`);
  });

  test("a mid-line mention of a region marker counts as a duplicate (substring rule)", () => {
    // The fleet-wide region convention counts SUBSTRINGS: a buried mention
    // would confuse every reader about where the managed region runs, and
    // the sync's appendix neutralization counts the same way.
    const { exitCode, stderr } = runValidator({
      ".editorconfig": `${HB}\n# rules go below the ${HE} marker\nroot = true\n${HE}\n`,
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("appears 2 times");
  });

  test("an indented marker line still slices parity where the stamper stamped", () => {
    // Marker LINES match by trimmed equality (the slicing convention every
    // splitter shares), while exactly-once counts substrings: an indented
    // BEGIN is one substring occurrence AND the slice anchor, so the
    // auto-stamped manifest's region, sliced the same way, passes parity.
    const { exitCode, stderr } = runValidator({
      ".editorconfig": `above\n  ${HB}\nroot = true\n${HE}\nrepo tail\n`,
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
      ".github/.copier-answers.yml": `${BASELINE[".github/.copier-answers.yml"]}private: true\n`,
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

  test("LICENSE.md needs the region markers unless custom-license owns licensing", () => {
    const fleet = runValidator({ "LICENSE.md": "# License\n" });
    expect(fleet.exitCode).toBe(1);
    expect(fleet.stderr).toContain(`LICENSE.md: marker '${B}' appears 0 times`);
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
      ".bun-version": "1.4.0\n",
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

  test("the agents module's AGENTS.md carries the region markers", () => {
    const agentsRender = {
      ".repo-platform.yml": BASELINE[".repo-platform.yml"].replace(
        "modules: [uv]",
        "modules: [uv, agents]",
      ),
    };
    const bare = runValidator({ ...agentsRender, "AGENTS.md": "# AGENTS.md\n" });
    expect(bare.exitCode).toBe(1);
    expect(bare.stderr).toContain(`AGENTS.md: marker '${B}' appears 0 times`);
    const marked = runValidator({
      ...agentsRender,
      "AGENTS.md": `${B}\n# AGENTS.md\n${E}\n`,
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
  const regionEntry = (path: string, begin: string, end: string) =>
    `{"class": "split", "grammar": "managed-region", "begin": ${JSON.stringify(begin)}, ` +
    `"end": ${JSON.stringify(end)}, "hash": "${sha(regionOf(BASELINE[path] ?? "", begin, end) ?? "")}"}`;
  const splitEntry = (grammar: string, begin: string, end: string, hash: string) =>
    `{"class": "split", "grammar": ${JSON.stringify(grammar)}, "begin": ${JSON.stringify(begin)}, ` +
    `"end": ${JSON.stringify(end)}, "hash": "${hash}"}`;
  const stampedBaseline = () => ({
    ...SELF_ENTRY,
    ".github/.copier-answers.yml": `{"class": "managed", "hash": "${sha(
      BASELINE[".github/.copier-answers.yml"],
    )}"}`,
    ".repo-platform.yml": '{"class": "starter"}',
    ".github/workflows/ci.yml": `{"class": "managed", "hash": "${sha(
      BASELINE[".github/workflows/ci.yml"],
    )}"}`,
    ".gitignore": regionEntry(".gitignore", HB, HE),
    ".editorconfig": regionEntry(".editorconfig", HB, HE),
    ".gitattributes": regionEntry(".gitattributes", HB, HE),
    ".github/CODEOWNERS": regionEntry(".github/CODEOWNERS", HB, HE),
    "SECURITY.md": regionEntry("SECURITY.md", B, E),
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

  test("split parity covers the managed region only: side edits pass, region edits fail", () => {
    const region = `${B}\n# Security\n${E}\n`;
    const entries = {
      ...stampedBaseline(),
      "SECURITY.md":
        `{"class": "split", "grammar": "managed-region", "begin": ${JSON.stringify(B)}, ` +
        `"end": ${JSON.stringify(E)}, "hash": "${sha(region)}"}`,
    };
    const sidesEdited = runValidator({
      [MANIFEST]: manifestOf(entries),
      "SECURITY.md": `repo-owned preamble, freely edited\n${region}repo-owned tail, freely edited\n`,
    });
    expect(sidesEdited.stderr).toBe("");
    expect(sidesEdited.exitCode).toBe(0);
    const regionEdited = runValidator({
      [MANIFEST]: manifestOf(entries),
      "SECURITY.md": `${B}\n# Security, reworded\n${E}\ntail\n`,
    });
    expect(regionEdited.exitCode).toBe(1);
    expect(regionEdited.stderr).toContain("SECURITY.md: its managed region does");
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
      "advisory: .github/repo-platform-manifest.json does not list 'CONTRIBUTING.md'",
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
    // strings, so a render whose auto-stamped manifest carries the same
    // sha as its self-entry commit passes clean (no "stamped provenance"
    // mismatch, no missing-_commit text, nothing else).
    const { exitCode, stderr } = runValidator({
      ".github/.copier-answers.yml": `${MANAGED_HEADER}_commit: 95e1875\n_src_path: gh:Vivswan/repo-platform\ngithub_username: Vivswan\n`,
    });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });

  test("the exponent-shaped sha still feeds the provenance check (positive oracle)", () => {
    // The absence assertions above would also pass if provenance checking
    // silently stopped running. Same bare-exponent _commit, mismatched
    // stamp: the error must fire AND quote 95e1875 as the recorded value,
    // proving the failsafe read returned the string and the check ran.
    const mismatched = runValidator({
      ".github/.copier-answers.yml": `${MANAGED_HEADER}_commit: 95e1875\n_src_path: gh:Vivswan/repo-platform\ngithub_username: Vivswan\n`,
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
      ".github/.copier-answers.yml": `${MANAGED_HEADER}_src_path: gh:Vivswan/repo-platform\ngithub_username: Vivswan\n`,
      [MANIFEST]: manifestOf({
        [MANIFEST]: '{"class": "managed", "hash": null, "commit": "0.0.0.post5.dev0+abc1234"}',
      }),
    });
    expect(keyDeleted.exitCode).toBe(1);
    expect(keyDeleted.stderr).toContain("no _commit in .github/.copier-answers.yml");
  });

  // One condition judges a roster-covered entry whose render condition is
  // off (the path is covered by SOME render, not this one): such an entry
  // cannot come from the template, so it is manifest drift.
  const PRIVATE_ANSWERS =
    `${MANAGED_HEADER}_commit: 0.0.0.post5.dev0+abc1234\n_src_path: gh:Vivswan/repo-platform\n` +
    "github_username: Vivswan\nprivate: true\n";
  test.each<{ reason: string; path: string; tree: Record<string, string> }>([
    {
      reason: "a public-only file (CONTRIBUTING.md) listed on a private render",
      path: "CONTRIBUTING.md",
      tree: {
        ".github/.copier-answers.yml": PRIVATE_ANSWERS,
        [MANIFEST]: manifestOf({
          ...stampedBaseline(),
          ".github/.copier-answers.yml": `{"class": "managed", "hash": "${sha(PRIVATE_ANSWERS)}"}`,
          "CONTRIBUTING.md": splitEntry("managed-region", B, E, "a".repeat(64)),
        }),
      },
    },
    {
      reason:
        "the fleet LICENSE.md listed with custom-license selected (the repo owns its license)",
      path: "LICENSE.md",
      tree: {
        ".repo-platform.yml": BASELINE[".repo-platform.yml"].replace(
          "modules: [uv]",
          "modules: [uv, custom-license]",
        ),
        [MANIFEST]: manifestOf({
          ...stampedBaseline(),
          "LICENSE.md": splitEntry("managed-region", B, E, "a".repeat(64)),
        }),
      },
    },
    {
      reason: "an unselected module's workflow (release.yml; the baseline selects only uv)",
      path: ".github/workflows/release.yml",
      tree: {
        [MANIFEST]: manifestOf({
          ...stampedBaseline(),
          ".github/workflows/release.yml": '{"class": "managed", "hash": null}',
        }),
      },
    },
  ])(
    "a roster entry whose render condition is off is manifest drift: $reason",
    ({ path, tree }) => {
      const { exitCode, stderr } = runValidator(tree);
      expect(exitCode).toBe(1);
      expect(stderr).toContain(`entry '${path}' should not exist for this render`);
    },
  );

  test("a tree carrying the base marker roster passes against the mirror-stamped manifest", () => {
    // The mirror-coverage claim's teeth: this fixture carries every base
    // marker/header path the mirror declares (plus the agents module's
    // AGENTS.md), all validated through the auto-stamped manifest - a
    // drifted mirror entry for any of them fails the roster cross-check
    // here instead of sitting inert.
    const registration = BASELINE[".repo-platform.yml"].replace(
      "modules: [uv]",
      "modules: [uv, agents]",
    );
    const { exitCode, stderr } = runValidator({
      ".repo-platform.yml": registration,
      ".editorconfig": `${HB}\n[*]\nindent_size = 2\n${HE}\n`,
      ".gitattributes": `${HB}\n*.bin binary\n${HE}\n`,
      ".github/CODEOWNERS": `${HB}\n/docs/ @Vivswan\n${HE}\n`,
      ".github/dependabot.yml": `${MANAGED_HEADER}version: 2\nupdates: []\n`,
      ".typography-allow": `${MANAGED_HEADER}`,
      ".yamllint": `${MANAGED_HEADER}extends: default\n`,
      "CODE_OF_CONDUCT.md": `${MANAGED_HEADER}\n# Contributor Covenant Code of Conduct\n`,
      "CONTRIBUTING.md": `${B}\n# Contributing\n${E}\n`,
      "LICENSE.md": `${B}\n# License\n${E}\n`,
      "SECURITY.md": `${B}\n# Security\n${E}\n`,
      "AGENTS.md": `${B}\n# AGENTS.md\n${E}\n`,
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

  // One roster cross-check condition judges a region entry's present
  // metadata: begin, end, and grammar must each match the DECLARED pair
  // (SECURITY.md's is the HTML form), or parity would cover a skewed
  // region. Each row's hash matches the region ITS OWN pair slices, so
  // parity is not what reports the disagreement.
  test.each([
    {
      reason: "a drifted end string",
      entry: splitEntry(
        "managed-region",
        B,
        "# NOT THE END",
        sha(`${B}\n# Security\n# NOT THE END\n`),
      ),
      body: `${B}\n# Security\n# NOT THE END\n${E}\ntail\n`,
    },
    {
      reason: "the hash marker spelling (a real pair, not the declared one)",
      entry: splitEntry("managed-region", HB, HE, sha(`${HB}\n# Security\n${HE}\n`)),
      body: `${HB}\n# Security\n${HE}\ntail\n`,
    },
    {
      reason: "a RETIRED grammar (tail-marker) on the declared pair",
      entry: splitEntry("tail-marker", B, E, sha(`${B}\n# Security\n${E}\n`)),
      body: `${B}\n# Security\n${E}\ntail\n`,
    },
  ])(
    "split metadata disagreeing with the declared pair fails the cross-check: $reason",
    ({ entry, body }) => {
      const { exitCode, stderr } = runValidator({
        [MANIFEST]: manifestOf({ ...stampedBaseline(), "SECURITY.md": entry }),
        "SECURITY.md": body,
      });
      expect(exitCode).toBe(1);
      expect(stderr).toContain(
        "carries split metadata outside its declared managed-region grammar",
      );
    },
  );

  test("a grammar-carrying region entry matching the declaration passes", () => {
    const region = `${B}\n# Security\n${E}\n`;
    const entries = {
      ...stampedBaseline(),
      "SECURITY.md":
        `{"class": "split", "grammar": "managed-region", "begin": ${JSON.stringify(B)}, ` +
        `"end": ${JSON.stringify(E)}, "hash": "${sha(region)}"}`,
    };
    const { exitCode, stderr } = runValidator({
      [MANIFEST]: manifestOf(entries),
      "SECURITY.md": `${region}repo tail\n`,
    });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });

  test("a .gitignore entry hand-flipped to starter fails the cross-check", () => {
    const entries = {
      ...stampedBaseline(),
      ".gitignore": '{"class": "starter"}',
    };
    const { exitCode, stderr } = runValidator({ [MANIFEST]: manifestOf(entries) });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(`entry '.gitignore' claims class "starter"`);
    expect(stderr).toContain("ownership tables declare it split");
  });

  // An uncovered path, so the structural loop's grammar check is probed
  // alone. A grammar this validator does not read - one that never existed
  // or a RETIRED one from an older-vintage manifest (a repo not yet synced
  // past the one-grammar change) - is refused loudly and never read by
  // guess, mirroring the sync's own vintage refusals.
  test.each([
    {
      reason: "a grammar that never existed (prefix)",
      grammar: "prefix",
      entryFields: `"begin": "# b", "end": "# e"`,
      body: "# b\n# e\n",
    },
    {
      reason: "the RETIRED tail-marker grammar with its own fields",
      grammar: "tail-marker",
      entryFields: `"marker": "# m", "managed": "above"`,
      body: "# m\n",
    },
  ])(
    "a split grammar this validator does not read is refused, naming the restamp: $reason",
    ({ grammar, entryFields, body }) => {
      const entries = {
        ...stampedBaseline(),
        "docs/notes.md":
          `{"class": "split", "grammar": ${JSON.stringify(grammar)}, ${entryFields}, ` +
          `"hash": "${"d".repeat(64)}"}`,
      };
      const { exitCode, stderr } = runValidator({
        [MANIFEST]: manifestOf(entries),
        "docs/notes.md": body,
      });
      expect(exitCode).toBe(1);
      expect(stderr).toContain(
        `declares split grammar ${JSON.stringify(grammar)}, which this validator does not read`,
      );
      expect(stderr).toContain("run a template sync to restamp it");
    },
  );

  test("a split entry without its begin/end strings is a structural error", () => {
    const entries = {
      ...stampedBaseline(),
      "docs/notes.md":
        `{"class": "split", "grammar": "managed-region", "begin": "# b", ` +
        `"hash": "${"d".repeat(64)}"}`,
    };
    const { exitCode, stderr } = runValidator({
      [MANIFEST]: manifestOf(entries),
      "docs/notes.md": "# b\n",
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("lacks its begin/end marker-line strings");
  });

  test("a split entry with no grammar field is an error", () => {
    // Every render stamps the grammar; a grammar-less split entry can only
    // be a hand edit, whatever path it sits on.
    const entries = {
      ...stampedBaseline(),
      "docs/notes.md": `{"class": "split", "begin": "# b", "end": "# e", "hash": "${"d".repeat(64)}"}`,
    };
    const { exitCode, stderr } = runValidator({
      [MANIFEST]: manifestOf(entries),
      "docs/notes.md": "# b\n# e\n",
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("lacks the split grammar field every render stamps");
  });

  test("a grammar-less split entry on a roster path draws ONE diagnostic", () => {
    // The missing field is the structural loop's report alone; the roster
    // cross-check judges only present-but-disagreeing metadata, so one
    // cause does not pile two conflicting recovery instructions.
    const region = `${B}\n# Security\n${E}\n`;
    const entries = {
      ...stampedBaseline(),
      "SECURITY.md":
        `{"class": "split", "begin": ${JSON.stringify(B)}, ` +
        `"end": ${JSON.stringify(E)}, "hash": "${sha(region)}"}`,
    };
    const { exitCode, stderr } = runValidator({
      [MANIFEST]: manifestOf(entries),
      "SECURITY.md": `${region}tail\n`,
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("lacks the split grammar field every render stamps");
    expect(stderr).not.toContain(
      "carries split metadata outside its declared managed-region grammar",
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

  test("a stale managed .repo-platform.yml entry is the known ownership flip: advisory, no parity", () => {
    // The file was managed (hash-pinned) before it became a repo-owned
    // starter; a not-yet-resynced repo's manifest still says managed while
    // the repo edits the file - which is now the file's PURPOSE (module
    // selection, the mirrors declaration), so the stale hash must not read
    // as drift. The next sync restamps the entry.
    const edited = `${BASELINE[".repo-platform.yml"]}mirrors:\n  - source: SECURITY.md\n    targets: [copies/SECURITY.md]\n`;
    const entries = {
      ...stampedBaseline(),
      // A hash stamped from a PREVIOUS state of the file, as a stale
      // manifest carries: the edited file can no longer match it.
      ".repo-platform.yml": `{"class": "managed", "hash": "${"d".repeat(64)}"}`,
    };
    const { exitCode, stdout, stderr } = runValidator({
      ".repo-platform.yml": edited,
      [MANIFEST]: manifestOf(entries),
    });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("predates its flip");
  });

  test("the flip exemption covers that one path only - other drifted managed entries still fail", () => {
    // Negative control for the test above: the same drifted-hash shape on
    // any OTHER unlisted path keeps full parity, so the exemption cannot
    // quietly widen into a class-level bypass.
    const entries = {
      ...stampedBaseline(),
      "docs/pinned.md": `{"class": "managed", "hash": "${"d".repeat(64)}"}`,
    };
    const { exitCode, stderr } = runValidator({
      "docs/pinned.md": "drifted\n",
      [MANIFEST]: manifestOf(entries),
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("docs/pinned.md: content does");
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
      ".repo-platform.yml": BASELINE[".repo-platform.yml"].replace(
        "modules: [uv]",
        "modules: [uv, settings-sync]",
      ),
      [MANIFEST]: manifestOf(entries),
      ".github/settings.yml": "repository:\n  has_issues: true\n",
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain('has class "mergeable", which is retired');
  });

  test("a settings.yml starter entry passes: the file is repo-owned", () => {
    const registration = BASELINE[".repo-platform.yml"].replace(
      "modules: [uv]",
      "modules: [uv, settings-sync]",
    );
    const entries = {
      ...stampedBaseline(),
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

  // The self entry's one invariant, judged before any class dispatch:
  // managed, hash null (its content includes every other hash), and a
  // null-or-string provenance commit.
  test.each([
    {
      reason: "a hash set (self-hash is circular)",
      selfEntry: `{"class": "managed", "hash": "${"b".repeat(64)}"}`,
    },
    { reason: "reclassified as starter", selfEntry: '{"class": "starter"}' },
    {
      reason: "a non-string provenance commit",
      selfEntry: '{"class": "managed", "hash": null, "commit": 42}',
    },
  ])("the manifest's own entry breaking its invariant is an error: $reason", ({ selfEntry }) => {
    const entries = { ...stampedBaseline(), [MANIFEST]: selfEntry };
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
        `{"class": "split", "grammar": "managed-region", "begin": "# no-such-begin", ` +
        `"end": "# no-such-end", "hash": "${"c".repeat(64)}"}`,
    };
    const { exitCode, stderr } = runValidator({ [MANIFEST]: manifestOf(entries) });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(
      ".github/workflows/ci.yml: the managed-region marker lines ('# no-such-begin'",
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
    expect(stderr).toContain(`${MANIFEST}: does not parse as a manifest`);
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

  test("validator and stamper slice a trailing-space marker line the same way", () => {
    // Marker LINES match by trimmed equality at every splitter (the
    // stamper, the sync rebuild, and this validator's parity slice must
    // agree, or sync would deliver trees whose stamped region differs from
    // the one parity verifies). A marker line with a stray trailing space
    // still anchors the slice - and stays ONE substring occurrence.
    const content = `above\n${HB} \nroot = true\n${HE}\nrepo tail\n`;
    const region = regionOf(content, HB, HE);
    if (region === null) throw new Error("fixture lost its marker lines");
    const entries = {
      ...stampedBaseline(),
      ".editorconfig":
        `{"class": "split", "grammar": "managed-region", "begin": ${JSON.stringify(HB)}, ` +
        `"end": ${JSON.stringify(HE)}, "hash": "${sha(region)}"}`,
    };
    const { exitCode, stderr } = runValidator({
      ".editorconfig": content,
      [MANIFEST]: manifestOf(entries),
    });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });

  // The agents module's CLAUDE.md is a symlink: a class-only roster path
  // with no comment channel. These fixtures select agents and land the
  // link so both the parity rule and the cross-check see a real symlink.
  const agentsLinkTree = (claudeEntry: string): string => {
    const root = mkdtempSync(join(tmpdir(), "validate-template-link-"));
    roots.push(root);
    const registration = BASELINE[".repo-platform.yml"].replace(
      "modules: [uv]",
      "modules: [uv, agents]",
    );
    const agentsMd = `${B}\n# AGENTS.md\n${E}\n`;
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
        "AGENTS.md":
          `{"class": "split", "grammar": "managed-region", "begin": ${JSON.stringify(B)}, ` +
          `"end": ${JSON.stringify(E)}, "hash": "${sha(agentsMd)}"}`,
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
    const registration = BASELINE[".repo-platform.yml"].replace("modules: [uv]", "modules: [bun]");
    const entries = {
      ...stampedBaseline(),
      ".bun-version": '{"class": "starter"}',
    };
    const { exitCode, stderr } = runValidator({
      ".repo-platform.yml": registration,
      ".bun-version": "1.4.0\n",
      [MANIFEST]: manifestOf(entries),
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(`entry '.bun-version' claims class "starter"`);
    expect(stderr).toContain("ownership tables declare it managed");
    // The fixture pin is a hand twin of the generated TOOLCHAIN_PINS
    // table; a stale one would add its own error here invisibly (the
    // test already expects failure), so pin its freshness explicitly.
    expect(stderr).not.toContain(".bun-version: content");
  });

  // JSON.parse keeps the LAST binding silently, so a conflicted resolution
  // keeping a second, starter-classed ci.yml line (or a second class field
  // inside the entry) would switch that file's parity off invisibly. The
  // duplicate is refused before any consumer reads the last-win view.
  test.each([
    {
      reason: "two entry lines for one path (the second starter-classed)",
      entryLines: [
        `    ".github/workflows/ci.yml": ${stampedBaseline()[".github/workflows/ci.yml"]}`,
        `    ".github/workflows/ci.yml": {"class": "starter"}`,
      ],
    },
    {
      reason: "a duplicated class field inside one entry object",
      entryLines: [
        `    ".github/workflows/ci.yml": {"class": "managed", "class": "starter", "hash": null}`,
      ],
    },
  ])(
    "a duplicated manifest key is a hard error, refused before any last-win read: $reason",
    ({ entryLines }) => {
      const text = `{\n  "files": {\n${[
        `    ${JSON.stringify(MANIFEST)}: ${SELF_ENTRY[MANIFEST]}`,
        ...entryLines,
      ].join(",\n")}\n  }\n}\n`;
      const { exitCode, stderr } = runValidator({ [MANIFEST]: text });
      expect(exitCode).toBe(1);
      expect(stderr).toContain("binds a key more than once");
      // The last-win view (ci.yml as a starter) must not have reached the
      // roster cross-check: that is the report it would draw there.
      expect(stderr).not.toContain('claims class "starter"');
    },
  );
});
