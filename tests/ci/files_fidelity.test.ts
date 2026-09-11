// The writer against the copier renders it replaces: for each kept golden
// selection, sync.ts runs as a subprocess over an empty checkout whose
// registration is derived from the golden's answers, and the result is
// compared byte for byte with the frozen render under files_fidelity/renders.
// The frozen renders are tests/golden-renders/<selection> as of
// redesign/p1b-skeleton commit 469a9b00 (its tip when they were frozen).
// Every difference is pinned: a path the writer never writes is listed with
// its reason, and a file whose content differs is listed with the exact
// transform of the golden that yields the writer's output, so an entry that
// stops differing fails as stale. Content the templates side keeps moving
// (the toolchain pin dotfiles, the gitignore skeleton's region body, the
// github/gitignore sections) is compared with the templates side as it is
// now, not with the frozen bytes: the renders cannot be re-frozen after a
// refresh, and the templates side is what they rendered from.

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { blockSourcePath } from "../../actions/plan/files_config";
import { sectionsIn, templateRegionBody } from "../../scripts/generate/build_gitignore";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();
const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const SYNC = join(REPO_ROOT, ".github/scripts/sync/writer/sync.ts");
const FILES_TREE = join(REPO_ROOT, "files");
const RENDERS = join(import.meta.dir, "files_fidelity/renders");
const SELECTIONS = ["minimal", "uv-no-release-please", "all-modules"] as const;
type Selection = (typeof SELECTIONS)[number];
const BUILD = "x".repeat(40);

const HASH_BEGIN = "# BEGIN REPO-PLATFORM MANAGED";
const HASH_END = "# END REPO-PLATFORM MANAGED";
const TEMPLATES = join(REPO_ROOT, "templates");

/** Refresh-owned paths: the module whose generated template dotfile is the
 *  expected content (templates/<module>/<path>, kept current by
 *  generate:check), instead of the frozen golden's copy. */
const PIN_FILES: Record<string, string> = {
  ".bun-version": "bun",
  ".node-version": "node",
  ".dvmrc": "deno",
};

const TEMPLATE_GITIGNORE = join(TEMPLATES, "base", ".gitignore.jinja");

/** The skeleton's region body as the templates side carries it now: the
 *  header comment, repo-platform's own sections, and the OS sections. */
function currentRegionBody(): string {
  return templateRegionBody(readFileSync(TEMPLATE_GITIGNORE, "utf-8"));
}

/** Every github/gitignore section the templates side carries now, by
 *  source path: the base template's OS sections plus every module
 *  fragment's. */
function currentSections(): Record<string, string> {
  const texts = [currentRegionBody()];
  for (const module of readdirSync(TEMPLATES)) {
    const fragment = join(TEMPLATES, module, "fragments", "gitignore.jinja");
    if (existsSync(fragment)) texts.push(readFileSync(fragment, "utf-8"));
  }
  return Object.assign({}, ...texts.map(sectionsIn));
}

/** `region` with every github/gitignore section's text replaced by the
 *  current one for its source path (a section runs from its heading to the
 *  next heading or the END marker line, and keeps its trailing blank line). */
export function refreshSections(region: string, current: Record<string, string>): string {
  const headings = [...region.matchAll(/^## .+ \(github\/gitignore (.+)\)$/gm)];
  let out = "";
  let cursor = 0;
  headings.forEach((match, index) => {
    const end =
      index + 1 < headings.length ? headings[index + 1].index : region.indexOf(`${HASH_END}\n`);
    const refreshed = current[match[1]];
    if (refreshed === undefined) throw new Error(`no current section for ${match[1]}`);
    out += `${region.slice(cursor, match.index)}${refreshed}\n`;
    cursor = end;
  });
  return out + region.slice(cursor);
}

/** A starter the platform stopped writing is neither written nor retired
 *  (a retirement would only report it kept); the account's .github
 *  repository serves the forms. */
const STARTER_LEFT_ALONE =
  "no longer written and not retired: a starter is repo-owned; served by the account's .github repository";

/** Paths the golden carries that the writer never writes, with why. */
const ABSENT: Record<string, string> = {
  ".github/.copier-answers.yml": "retired: copier's answers file has no successor",
  "CONTRIBUTING.md": "retired: served by the account's .github repository",
  ".github/CODE_OF_CONDUCT.md": "retired: served by the account's .github repository",
  ".github/SECURITY.md": "retired: served by the account's .github repository",
  ".github/ISSUE_TEMPLATE/bug_report.yml": STARTER_LEFT_ALONE,
  ".github/ISSUE_TEMPLATE/config.yml": STARTER_LEFT_ALONE,
  ".github/ISSUE_TEMPLATE/feature_request.yml": STARTER_LEFT_ALONE,
};

/** Paths present on both sides that are not compared, with why. */
const NOT_COMPARED: Record<string, string> = {
  ".repo-platform.yml": "the writer's input, seeded by this test from the golden's answers",
  ".github/repo-platform-manifest.json": "the writer's own record, in its own layout",
};

interface Known {
  selections: readonly Selection[];
  reason: string;
  /** The golden's content rewritten into what the writer produces. */
  expected: (golden: string, selection: Selection) => string;
}

const region = (text: string, begin: string, end: string) =>
  text.slice(text.indexOf(`${begin}\n`), text.indexOf(`${end}\n`) + end.length + 1);

/** The renders' template-era phrases and what the files/ tree says
 *  instead: a managed file's local edits are replaced on the next sync, a
 *  starter is written once, a region is replaced on every sync. Applied to
 *  every golden before it is compared; a phrase no golden carries is a
 *  stale row. */
const REWORDED: readonly [string, string][] = [
  [
    "Local edits may be replaced during template updates.",
    "Local edits are replaced on the next sync.",
  ],
  ["generated once by", "written once by"],
  ["Generated once by", "Written once by"],
  [
    " and never overwritten by template\n# sync, so add",
    ", never overwritten by a later sync,\n# so add",
  ],
  ["never overwritten by template sync", "never overwritten by a later sync"],
  ["# overwritten by template sync", "# overwritten by a later sync"],
  [
    "seeded once by repo-platform's template, never overwritten",
    "written once by repo-platform's sync, never overwritten",
  ],
  [
    "Rendered once, repo-owned: template sync never rewrites it.",
    "Written once, repo-owned: the sync never rewrites it.",
  ],
  ["this section is replaced on\n# template sync.", "this section is replaced on every sync."],
  ["across template updates", "across every sync"],
  ["replaced on template sync;", "replaced on every sync;"],
  ["section is replaced on template sync.", "section is replaced on every sync."],
  ["and replaced on template sync.", "and replaced on every sync."],
  ["survive template updates", "survive every sync"],
  ["and overwritten by template sync.", "and replaced on every sync."],
  ['"$comment": "Seeded by ', '"$comment": "Written once by '],
  [
    "; repo-owned after first render - edit freely",
    ", never overwritten by a later sync - edit freely",
  ],
  // The sync retires copier's answers file, so nothing is left to ignore.
  [
    "  # Machine-generated by copier (pyyaml emits unindented sequences, which the\n" +
      "  # default indentation rule rejects); the validator still YAML-parses it.\n" +
      "  - .copier-answers.yml\n",
    "",
  ],
];

/** The template-era phrases no file under files/ may carry, read across
 *  comment-wrapped lines (`template\n# sync` is the same phrase), and the
 *  hits in `text` as they appear there. */
const RETIRED_WORDING =
  /\btemplate (sync|updates)|during template|repo-platform's template|copier/gi;

function retiredWording(text: string): string[] {
  const unwrapped = text.replace(/\n[ \t]*(?:#|\/\/|<!--)?[ \t]*/g, " ");
  return unwrapped.match(RETIRED_WORDING) ?? [];
}

function reworded(golden: string): string {
  return REWORDED.reduce((text, [from, to]) => text.split(from).join(to), golden);
}

/** A golden file's text with the template-era phrases reworded. */
function goldenText(selection: Selection, path: string): string {
  return reworded(readFileSync(join(RENDERS, selection, path), "utf-8"));
}

const NO_DISPATCH =
  "the filed issue is no longer handed to auto-assign by a token dispatch (the fuzz-issue action assigns the owner at creation);" +
  " actions: write goes, issues: write moves to the filing job";

const ISSUES_WRITE =
  "    # issues: write lets the fuzz-issue action file and close the tracking\n" +
  "    # issue. The action assigns the owner at creation, so nothing else runs.\n";

/** `golden` without the dispatch step (whose `if:` starts with `guard`)
 *  and without the step id only that step read. */
function withoutDispatch(golden: string, guard: string): string {
  const step =
    /\n {6}# A GITHUB_TOKEN-created issue fires no triggers, so dispatch auto-assign\.\n(?: {6}.*\n)+/.exec(
      golden,
    );
  if (step === null || !step[0].includes(`if: ${guard}steps.file-issue.outputs.issue-number`)) {
    throw new Error("the golden carries no auto-assign dispatch step");
  }
  return golden.replace(step[0], "").replace("        id: file-issue\n", "");
}

const KNOWN: Record<string, Known> = {
  ".gitignore": {
    selections: SELECTIONS,
    reason:
      "region only (the comment above BEGIN is repository-owned); the skeleton through the OS sections is the templates side's current region body" +
      " (one blank line before the first toolchain section instead of the composer's two); the toolchain sections are the templates side's current ones (a refresh rewrites them)",
    expected: (golden) => {
      const frozen = region(golden, HASH_BEGIN, HASH_END);
      const headings = [...frozen.matchAll(/^## .+ \(github\/gitignore (.+)\)$/gm)];
      const linux = headings.findIndex((match) => match[1] === "Global/Linux.gitignore");
      const toolchains =
        linux + 1 < headings.length ? frozen.slice(headings[linux + 1].index) : `${HASH_END}\n`;
      return refreshSections(
        `${HASH_BEGIN}\n${currentRegionBody()}${toolchains}`,
        currentSections(),
      );
    },
  },
  ".gitleaks.toml": {
    selections: ["minimal", "uv-no-release-please"],
    reason:
      "the starter allowlists every toolchain's lockfile unconditionally (a starter carries no module blocks; an allowlist for an absent file is inert)",
    expected: () => goldenText("all-modules", ".gitleaks.toml"),
  },
  ".github/workflows/checks.yml": {
    selections: ["minimal"],
    reason:
      "one blank line between the checkout step and the placeholder step: the seam the toolchain example blocks land in stays when no toolchain is selected",
    expected: (golden) =>
      golden.replace(
        "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n      - name: No repository checks yet",
        "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n\n      - name: No repository checks yet",
      ),
  },
  ".github/workflows/nightly-fuzz.yml": {
    selections: ["all-modules"],
    reason: NO_DISPATCH,
    expected: (golden) =>
      withoutDispatch(golden, "failure() && ").replace(
        "# issues: write lets the fuzz-issue action file/close the tracking issue;\n" +
          "# actions: write lets the failure path dispatch auto-assign at it.\n" +
          "permissions:\n  contents: read\n  issues: write\n  actions: write\n\njobs:\n  fuzz:\n    runs-on: ubuntu-latest\n",
        "permissions:\n  contents: read\n\njobs:\n  fuzz:\n    runs-on: ubuntu-latest\n" +
          `${ISSUES_WRITE}    permissions:\n      contents: read\n      issues: write\n`,
      ),
  },
  ".github/workflows/nightly.yml": {
    selections: ["all-modules"],
    reason: NO_DISPATCH,
    expected: (golden) =>
      withoutDispatch(golden, "").replace(
        "    # issues: write lets the fuzz-issue action file/close the tracking issue;\n" +
          "    # actions: write lets the red path dispatch auto-assign at it.\n" +
          "    permissions:\n      issues: write\n      actions: write\n",
        `${ISSUES_WRITE}    permissions:\n      issues: write\n`,
      ),
  },
  "AGENTS.md": {
    selections: SELECTIONS,
    reason:
      "the module-conditional phrases are worded as 'with the <module> module' or unconditionally; the Toolchain section moves to the end of the region," +
      " right before the Repository-specific guidance heading (the blocks splice in there)",
    expected: (golden) => {
      const toolchain = /\n## Toolchain\n\n(?:- .*\n)+/.exec(golden);
      let out = toolchain === null ? golden : golden.replace(toolchain[0], "");
      out = out.replace(
        /^- PR titles and commit subjects are Conventional Commits.*$/m,
        "- PR titles and commit subjects are Conventional Commits; with the release-please module they drive its versioning. PRs are squash-merged, so the PR title becomes the commit subject; with the pr-title module, its check validates the title.",
      );
      out = out.replace(/^- A green push to main releases.*\n/m, "");
      out = out.replace(
        /^(- CI gates on the `all-green` check.*\n)/m,
        "$1- With the release-please module, a green push to main releases through the fleet's release pipeline; this repository's release steps go in the repo-owned `update-release.yml` and `update-release-pr.yml` hooks.\n",
      );
      out = out.replace(
        /^- Repo-owned, never overwritten by sync:.*$/m,
        "- Repo-owned, never overwritten by sync: `checks.yml`, `post-green.yml`, `.gitleaks.toml`, `.gitignore` outside its managed region," +
          " `.typography-allow.local`, the release hooks, and the module starters (the release-please JSON files, the `.claude-plugin/` manifests, the nightly workflows).",
      );
      if (toolchain !== null) {
        out = out.replace(
          "\n## Repository-specific guidance\n",
          `${toolchain[0]}\n## Repository-specific guidance\n`,
        );
      }
      return out;
    },
  },
};

interface Answers {
  modules: string[];
  project_name: string;
  project_slug: string;
  description: string;
  copyright_holder: string;
  github_username: string;
  private: boolean;
}

function answersOf(selection: Selection): Answers {
  return parseYaml(
    readFileSync(join(RENDERS, selection, ".github/.copier-answers.yml"), "utf-8"),
  ) as Answers;
}

/** Every path under `root` (symlinks included, directories descended). */
function walk(root: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory() && !entry.isSymbolicLink()) out.push(...walk(root, rel));
    else out.push(rel);
  }
  return out.sort();
}

interface Run {
  target: string;
  paths: string[];
  summary: { hold: boolean; modules: string[]; written: { path: string }[]; notes: string[] };
}

/** sync.ts over an empty checkout registered with `answers`. */
function runWriter(label: string, answers: Answers): Run {
  const target = temp.dir(`files-fidelity-${label}-`);
  const registration = [
    `modules: ${JSON.stringify(answers.modules)}`,
    "project:",
    `  name: ${JSON.stringify(answers.project_name)}`,
    `  slug: ${JSON.stringify(answers.project_slug)}`,
    `  description: ${JSON.stringify(answers.description)}`,
    `  copyright_holder: ${JSON.stringify(answers.copyright_holder)}`,
    "",
  ].join("\n");
  writeFileSync(join(target, ".repo-platform.yml"), registration);
  const summaryPath = join(temp.dir(`files-fidelity-summary-${label}-`), "summary.json");
  const result = boundedSpawnSync(
    [
      "bun",
      SYNC,
      "--files",
      join(REPO_ROOT, "files.yml"),
      "--tree",
      FILES_TREE,
      "--target",
      target,
      "--build",
      BUILD,
      "--repository",
      `${answers.github_username}/${answers.project_slug}`,
      "--private",
      String(answers.private),
      "--summary",
      summaryPath,
    ],
    { cwd: REPO_ROOT, timeoutMs: 60_000 },
  );
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  return { target, paths: walk(target), summary: JSON.parse(readFileSync(summaryPath, "utf-8")) };
}

describe.each([...SELECTIONS])("files.yml reproduces the %s render", (selection) => {
  const golden = join(RENDERS, selection);
  const goldenPaths = walk(golden);
  const run = runWriter(selection, answersOf(selection));
  const knownHere = Object.keys(KNOWN).filter((path) => KNOWN[path].selections.includes(selection));
  const isLink = (root: string, path: string) => lstatSync(join(root, path)).isSymbolicLink();

  test("the writer knows every module the golden selected and holds nothing", () => {
    expect(run.summary.modules).toEqual(answersOf(selection).modules);
    expect(run.summary.notes).toEqual([]);
    expect(run.summary.hold).toBe(false);
    expect(run.summary.written.length).toBeGreaterThan(15);
  });

  test("the absent paths are exactly the listed ones, and the writer adds none", () => {
    const absent = goldenPaths.filter((path) => !existsSync(join(run.target, path)));
    expect(absent).toEqual(
      Object.keys(ABSENT)
        .filter((path) => goldenPaths.includes(path))
        .sort(),
    );
    const extra = run.paths.filter((path) => !goldenPaths.includes(path));
    expect(extra).toEqual([]);
  });

  test("every other file is byte-identical", () => {
    const compared = goldenPaths.filter(
      (path) =>
        !(path in ABSENT) &&
        !(path in NOT_COMPARED) &&
        !(path in PIN_FILES) &&
        !knownHere.includes(path) &&
        !isLink(golden, path),
    );
    expect(compared.length).toBeGreaterThan(10);
    const differing = compared.filter(
      (path) => goldenText(selection, path) !== readFileSync(join(run.target, path), "utf-8"),
    );
    expect(differing).toEqual([]);
  });

  test("every symlink is a symlink with the same target", () => {
    const links = goldenPaths.filter((path) => isLink(golden, path));
    expect(links).toEqual([".github/agents.md", ".github/copilot-instructions.md", "CLAUDE.md"]);
    const targets = (root: string) =>
      links.map((path) => ({
        path,
        link: isLink(root, path),
        target: isLink(root, path) ? readlinkSync(join(root, path)) : null,
      }));
    expect(targets(run.target)).toEqual(targets(golden));
  });

  test("each pin dotfile is the templates side's generated dotfile, not the frozen copy", () => {
    for (const path of goldenPaths.filter((path) => path in PIN_FILES)) {
      const expected = readFileSync(join(TEMPLATES, PIN_FILES[path], path), "utf-8");
      expect({ path, content: readFileSync(join(run.target, path), "utf-8") }).toEqual({
        path,
        content: expected,
      });
    }
  });

  test("each known difference is exactly its pinned transform of the golden", () => {
    for (const path of knownHere) {
      const before = goldenText(selection, path);
      const after = readFileSync(join(run.target, path), "utf-8");
      // A transform that changes nothing is a stale entry.
      expect({ path, differs: before !== after }).toEqual({ path, differs: true });
      expect({ path, content: after }).toEqual({
        path,
        content: KNOWN[path].expected(before, selection),
      });
    }
  });
});

describe("the files/ tree speaks the writer's vocabulary", () => {
  test("every reworded phrase is one some golden carries", () => {
    const goldens = SELECTIONS.flatMap((selection) =>
      walk(join(RENDERS, selection))
        .filter((path) => !lstatSync(join(RENDERS, selection, path)).isSymbolicLink())
        .map((path) => readFileSync(join(RENDERS, selection, path), "utf-8")),
    );
    const stale = REWORDED.filter(([from]) => !goldens.some((text) => text.includes(from)));
    expect(stale).toEqual([]);
  });

  // The spellings the cutover retired, wrapped ones included, against the
  // uses that stay legitimate: the tripwire below is only as good as this.
  test.each([
    ["# Local edits may be replaced during template updates.", ["during template"]],
    ["never overwritten by template\n# sync, so add", ["template sync"]],
    ["seeded once by repo-platform's template, never", ["repo-platform's template"]],
    ["<!-- ... and survive template updates. -->", ["template updates"]],
    ["  # Machine-generated by copier (pyyaml", ["copier"]],
    ["# validate-template posts its sticky findings comment.", []],
    ["#  JetBrains specific template is maintained in a separate", []],
    ["written by a python script from a template\n#   before PyInstaller", []],
  ])("retiredWording(%j) -> %j", (text, hits) => {
    expect(retiredWording(text)).toEqual(hits);
  });

  test("no source file says template sync, template updates, or copier", () => {
    const hits = walk(FILES_TREE)
      .filter((path) => !lstatSync(join(FILES_TREE, path)).isSymbolicLink())
      .flatMap((path) =>
        retiredWording(readFileSync(join(FILES_TREE, path), "utf-8")).map(
          (hit) => `${path}: ${hit}`,
        ),
      );
    expect(hits).toEqual([]);
  });
});

/** How often `needle` occurs in the written file at `path`. */
function occurrences(run: Run, path: string, needle: string): number {
  return readFileSync(join(run.target, path), "utf-8").split(needle).length - 1;
}

const block = (module: string, entryPath: string, value: string) =>
  readFileSync(join(FILES_TREE, module, blockSourcePath(entryPath, value)), "utf-8");

describe("blocks land once per distinct content, in module order", () => {
  const TOOLCHAINS = ["bun", "node", "deno", "uv", "rust"];
  const STEPS = ["bun", "node", "deno", "uv"];

  test("the three toolchains sharing the Node gitignore source ship one byte-identical block", () => {
    const node = block("bun", ".gitignore", "Node");
    expect(block("node", ".gitignore", "Node")).toBe(node);
    expect(block("deno", ".gitignore", "Node")).toBe(node);
  });

  test("every module selected: Node lands once, each toolchain's own blocks land", () => {
    const run = runWriter("every-module", answersOf("all-modules"));
    expect(occurrences(run, ".gitignore", "\n## Node (")).toBe(1);
    expect(occurrences(run, ".gitignore", "\n## bun (")).toBe(1);
    expect(occurrences(run, ".gitignore", "\n## Deno (")).toBe(1);
    for (const module of TOOLCHAINS) {
      expect({
        module,
        bullets: occurrences(run, "AGENTS.md", block(module, "AGENTS.md", "toolchain")),
      }).toEqual({ module, bullets: 1 });
    }
    for (const ecosystem of ["github-actions", "bun", "npm", "deno", "uv", "cargo"]) {
      expect({
        ecosystem,
        entries: occurrences(run, ".github/dependabot.yml", `package-ecosystem: "${ecosystem}"`),
      }).toEqual({ ecosystem, entries: 1 });
    }
    for (const path of ["checks.yml", "copilot-setup-steps.yml", "auto-format.yml"]) {
      const text = readFileSync(join(run.target, ".github/workflows", path), "utf-8");
      const at = STEPS.map((module) =>
        text.indexOf(block(module, `.github/workflows/${path}`, "toolchain")),
      );
      expect({ path, at }).toEqual({ path, at: [...at].sort((a, b) => a - b) });
      expect({ path, found: at.every((index) => index > 0) }).toEqual({ path, found: true });
    }
  });

  // The owned tail below END nests under the last heading of the region, so
  // that heading is the repository-specific one whether or not blocks land.
  test.each([
    [
      "minimal",
      answersOf("minimal"),
      ["- Fleet-wide conventions: repo-platform's docs/fleet-guidelines.md."],
    ],
    [
      "bun",
      { ...answersOf("minimal"), modules: ["bun"] },
      ["## Toolchain", "", ...block("bun", "AGENTS.md", "toolchain").trimEnd().split("\n")],
    ],
  ])(
    "the AGENTS.md region ends with the repository-specific heading (%s)",
    (label, answers, above) => {
      const run = runWriter(`agents-tail-${label}`, answers);
      const lines = readFileSync(join(run.target, "AGENTS.md"), "utf-8").split("\n");
      const end = lines.indexOf("<!-- END REPO-PLATFORM MANAGED -->");
      expect(lines.slice(end - above.length - 4, end + 2)).toEqual([
        ...above,
        "",
        "## Repository-specific guidance",
        "",
        "<!-- Add project-specific instructions below the END marker; they are this repository's own and survive every sync. -->",
        "<!-- END REPO-PLATFORM MANAGED -->",
        "",
      ]);
    },
  );

  test("bun alone: its two gitignore sources, its ecosystem, and its steps, nothing of the others", () => {
    const run = runWriter("bun-only", { ...answersOf("minimal"), modules: ["bun"] });
    expect(run.summary.modules).toEqual(["bun"]);
    expect(run.summary.hold).toBe(false);
    expect(occurrences(run, ".gitignore", "\n## Node (")).toBe(1);
    expect(occurrences(run, ".gitignore", "\n## bun (")).toBe(1);
    expect(occurrences(run, ".gitignore", "\n## Deno (")).toBe(0);
    expect(occurrences(run, ".gitignore", "\n## Python (")).toBe(0);
    expect(occurrences(run, ".github/dependabot.yml", "package-ecosystem: ")).toBe(2);
    expect(occurrences(run, ".github/dependabot.yml", 'package-ecosystem: "bun"')).toBe(1);
    expect(occurrences(run, "AGENTS.md", block("bun", "AGENTS.md", "toolchain"))).toBe(1);
    expect(occurrences(run, "AGENTS.md", block("uv", "AGENTS.md", "toolchain"))).toBe(0);
    for (const path of ["checks.yml", "copilot-setup-steps.yml", "auto-format.yml"]) {
      const counts = Object.fromEntries(
        STEPS.map((module) => [
          module,
          occurrences(
            run,
            `.github/workflows/${path}`,
            block(module, `.github/workflows/${path}`, "toolchain"),
          ),
        ]),
      );
      expect({ path, counts }).toEqual({ path, counts: { bun: 1, node: 0, deno: 0, uv: 0 } });
    }
  });
});

test("the fixture renders are the three kept golden selections", () => {
  expect(readdirSync(RENDERS).sort()).toEqual([...SELECTIONS].sort());
});

test("every listed absence, known difference, and pin file names a path some golden renders", () => {
  const rendered = new Set(SELECTIONS.flatMap((selection) => walk(join(RENDERS, selection))));
  for (const path of [
    ...Object.keys(ABSENT),
    ...Object.keys(NOT_COMPARED),
    ...Object.keys(KNOWN),
    ...Object.keys(PIN_FILES),
  ]) {
    expect({ path, rendered: rendered.has(path) }).toEqual({ path, rendered: true });
  }
});

describe("refreshSections", () => {
  const region = [
    HASH_BEGIN,
    "# header",
    "",
    "## Windows (github/gitignore Global/Windows.gitignore)",
    "Thumbs.db",
    "",
    "## Node (github/gitignore Node.gitignore)",
    "node_modules/",
    "",
    "*.log",
    "",
    HASH_END,
    "",
  ].join("\n");
  const current = {
    "Global/Windows.gitignore":
      "## Windows (github/gitignore Global/Windows.gitignore)\nThumbs.db\n",
    "Node.gitignore": "## Node (github/gitignore Node.gitignore)\nnode_modules/\n\n*.log\n",
  };

  test("sections already current leave the region unchanged", () => {
    expect(refreshSections(region, current)).toBe(region);
  });

  test("a refreshed upstream body replaces the frozen one, blank lines and markers kept", () => {
    const refreshed = {
      ...current,
      "Node.gitignore": "## Node (github/gitignore Node.gitignore)\nnode_modules/\n.next/\n",
    };
    expect(refreshSections(region, refreshed)).toBe(
      region.replace("node_modules/\n\n*.log\n", "node_modules/\n.next/\n"),
    );
    expect(() => refreshSections(region, {})).toThrow("no current section for Global/Windows");
  });
});
