// The writer against the copier renders it replaces: for each kept golden
// selection, sync.ts runs as a subprocess over an empty checkout whose
// registration is derived from the golden's answers, and the result is
// compared byte for byte with the frozen render under files_fidelity/renders.
// The frozen renders are tests/golden-renders/<selection> as of
// redesign/p1b-skeleton commit 7b776485 (its tip when they were frozen).
// Every difference is pinned: a path the writer never writes is listed with
// its reason, and a file whose content differs is listed with the exact
// transform of the golden that yields the writer's output, so an entry that
// stops differing fails as stale.

import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();
const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const SYNC = join(REPO_ROOT, ".github/scripts/sync/writer/sync.ts");
const RENDERS = join(import.meta.dir, "files_fidelity/renders");
const SELECTIONS = ["minimal", "uv-no-release-please", "all-modules"] as const;
type Selection = (typeof SELECTIONS)[number];
const BUILD = "x".repeat(40);

const HASH_BEGIN = "# BEGIN REPO-PLATFORM MANAGED";
const HASH_END = "# END REPO-PLATFORM MANAGED";

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
  "CLAUDE.md": "writer gap: files.yml has no symlink entry class",
  ".github/agents.md": "writer gap: files.yml has no symlink entry class",
  ".github/copilot-instructions.md": "writer gap: files.yml has no symlink entry class",
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

/** The golden's `## <name>` gitignore section (through its trailing blank
 *  line), re-inserted before each of `before`: the writer reads a block
 *  file per declaring module, so a source several modules declare lands
 *  once per module. */
function repeatSharedSection(text: string, name: string, before: string[]): string {
  const start = text.indexOf(`## ${name} (`);
  const end = text.indexOf("\n## ", start + 1) + 1;
  const section = text.slice(start, end);
  let out = text;
  for (const marker of before) out = out.replace(marker, `${section}${marker}`);
  return out;
}

const skeleton = (path: string) => readFileSync(join(RENDERS, "minimal", path), "utf-8");

const KNOWN: Record<string, Known> = {
  ".gitignore": {
    selections: SELECTIONS,
    reason:
      "region only (the comment above BEGIN is repository-owned); one blank line before the first toolchain section instead of the composer's two; a source several selected modules declare lands once per module (writer gap: no cross-module block dedupe)",
    expected: (golden, selection) => {
      let out = region(golden, HASH_BEGIN, HASH_END).replace(
        "nohup.out\n\n\n## ",
        "nohup.out\n\n## ",
      );
      if (selection === "all-modules") {
        out = repeatSharedSection(out, "Node", ["## Deno (", "## Python ("]);
      }
      return out;
    },
  },
  ".github/dependabot.yml": {
    selections: SELECTIONS,
    reason:
      "split instead of managed: blocks exist for split entries only, so the ecosystems ride in a marked region",
    expected: (golden) => `${HASH_BEGIN}\n${golden}${HASH_END}\n`,
  },
  ".gitleaks.toml": {
    selections: ["minimal", "uv-no-release-please"],
    reason:
      "the starter allowlists every toolchain's lockfile unconditionally (a starter carries no module blocks; an allowlist for an absent file is inert)",
    expected: () => readFileSync(join(RENDERS, "all-modules", ".gitleaks.toml"), "utf-8"),
  },
  ".github/workflows/checks.yml": {
    selections: ["uv-no-release-please", "all-modules"],
    reason:
      "the starter carries no per-toolchain example comments (writer gap: blocks on starter entries)",
    expected: () => skeleton(".github/workflows/checks.yml"),
  },
  ".github/workflows/copilot-setup-steps.yml": {
    selections: ["uv-no-release-please", "all-modules"],
    reason:
      "the starter carries no toolchain setup or install steps (writer gap: blocks on starter entries)",
    expected: () => skeleton(".github/workflows/copilot-setup-steps.yml"),
  },
  ".github/workflows/auto-format.yml": {
    selections: ["uv-no-release-please", "all-modules"],
    reason:
      "the starter carries no toolchain setup or format steps (writer gap: blocks on starter entries)",
    expected: (golden) =>
      golden.replace(
        /(persist-credentials: false\n)[\s\S]*?( {6}- name: Commit and push changes)/,
        "$1$2",
      ),
  },
  "AGENTS.md": {
    selections: SELECTIONS,
    reason:
      "the module-conditional phrases are worded as 'with the <module> module' or unconditionally; the Toolchain section moves to the end of the region (blocks append);" +
      " the Repository-specific guidance heading and its comment go (the opening paragraph already says where guidance goes)",
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
      out = out.replace(
        "\n## Repository-specific guidance\n\n<!-- Add project-specific instructions below the END marker; they are this repository's own and survive template updates. -->\n",
        toolchain === null ? "" : toolchain[0],
      );
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

function runWriter(selection: Selection): Run {
  const answers = answersOf(selection);
  const target = temp.dir(`files-fidelity-${selection}-`);
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
  const summaryPath = join(temp.dir(`files-fidelity-summary-${selection}-`), "summary.json");
  const result = boundedSpawnSync(
    [
      "bun",
      SYNC,
      "--files",
      join(REPO_ROOT, "files.yml"),
      "--tree",
      join(REPO_ROOT, "files"),
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
  const run = runWriter(selection);
  const knownHere = Object.keys(KNOWN).filter((path) => KNOWN[path].selections.includes(selection));

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
        !knownHere.includes(path) &&
        !lstatSync(join(golden, path)).isSymbolicLink(),
    );
    expect(compared.length).toBeGreaterThan(10);
    const differing = compared.filter(
      (path) => !readFileSync(join(golden, path)).equals(readFileSync(join(run.target, path))),
    );
    expect(differing).toEqual([]);
  });

  test("each known difference is exactly its pinned transform of the golden", () => {
    for (const path of knownHere) {
      const before = readFileSync(join(golden, path), "utf-8");
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

test("the fixture renders are the three kept golden selections", () => {
  expect(readdirSync(RENDERS).sort()).toEqual([...SELECTIONS].sort());
});

test("every listed absence and known difference names a path some golden renders", () => {
  const rendered = new Set(SELECTIONS.flatMap((selection) => walk(join(RENDERS, selection))));
  for (const path of [
    ...Object.keys(ABSENT),
    ...Object.keys(NOT_COMPARED),
    ...Object.keys(KNOWN),
  ]) {
    expect({ path, rendered: rendered.has(path) }).toEqual({ path, rendered: true });
  }
});
