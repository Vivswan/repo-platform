// The platform-authored gitignore sections, judged by git itself: only paths a fleet step creates inside every
// checked-out workspace are listed, root-anchored so a nested source folder of the same name is not swallowed, and the
// fuzz failure directory rides the fuzzer module alone because only its starter produces it.

import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import { capture } from "../../.github/scripts/shared/proc.ts";
import {
  type FileEntry,
  parseFilesConfig,
  type UpstreamRef,
} from "../../actions/plan/files_config.ts";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();
const REPO_ROOT = join(import.meta.dir, "../..");
const FILES = join(REPO_ROOT, "files");
const BASE = readFileSync(join(FILES, "base/.gitignore"), "utf-8");
const FUZZER = readFileSync(join(FILES, "fuzzer/fuzzer.gitignore"), "utf-8");
const ROOT_GITIGNORE = readFileSync(join(REPO_ROOT, ".gitignore"), "utf-8");
const CI_WORKSPACE_SECTION = "## CI workspace paths (repo-platform)";

test("every repository takes the three github/gitignore OS templates, in this order, before any module block", () => {
  const config = parseFilesConfig(readFileSync(join(REPO_ROOT, "files.yml"), "utf-8"));
  const gitignore = config.files.find((entry) => entry.path === ".gitignore") as Extract<
    FileEntry,
    { source: string | UpstreamRef }
  >;
  const ref = (path: string) => ({ repository: "github/gitignore", path });
  expect(gitignore).toMatchObject({
    always: ["Windows", "macOS", "Linux"],
    sources: {
      Windows: ref("Global/Windows.gitignore"),
      macOS: ref("Global/macOS.gitignore"),
      Linux: ref("Global/Linux.gitignore"),
    },
  });
});

function ignoredByGit(section: string, rel: string, kind: "dir" | "file"): boolean {
  const repo = temp.dir("gitignore-sections-");
  expect(capture(["git", "-C", repo, "init", "-q"], {}).exitCode).toBe(0);
  writeFileSync(join(repo, ".gitignore"), section);
  const abs = join(repo, rel);
  mkdirSync(dirname(abs), { recursive: true });
  if (kind === "dir") mkdirSync(abs);
  else writeFileSync(abs, "");
  const probe = capture(
    ["git", "-C", repo, "-c", "core.excludesFile=/dev/null", "check-ignore", "-q", rel],
    {},
  );
  // 0 ignored, 1 not ignored; anything else is a broken probe, never a verdict.
  expect([0, 1]).toContain(probe.exitCode);
  return probe.exitCode === 0;
}

test.each<[string, string, "dir" | "file", boolean]>([
  ["base", "results.sarif", "file", true],
  ["base", ".zizmor-fleet-policy.yml", "file", true],
  ["base", "trivy_envs.txt", "file", true],
  ["base", "typos-v1.50.1-x86_64-unknown-linux-musl.tar.gz", "file", true],
  ["base", "tools/typos-v1.50.1-x86_64-unknown-linux-musl.tar.gz", "file", false],
  ["base", "_typos.toml", "file", false],
  ["base", ".fuzz-failures", "dir", false],
  ["base", "assets/logo.png", "file", false],
  ["base", "scan/results.sarif", "file", false],
  ["base", ".claude/worktrees/x", "dir", true],
  ["fuzzer", ".fuzz-failures", "dir", true],
  ["fuzzer", ".fuzz-failures", "file", false],
  ["fuzzer", "crate/.fuzz-failures", "dir", false],
])("%s section: %s (%s) ignored: %p", (section, rel, kind, ignored) => {
  expect(ignoredByGit(section === "base" ? BASE : FUZZER, rel, kind)).toBe(ignored);
});

// A checkout `path:` is the one workspace write the yaml states outright, so the census below is derived, not
// scanned: a shell redirect or a tool's report file is judged by hand and lands in the section by the same rule.
// The section is judged alone, never the whole file, so a match elsewhere in the template cannot stand in for it.

type Step = { uses?: string; with?: Record<string, unknown> };
type Workflow = { jobs?: Record<string, { steps?: Step[] }> };

interface WorkspaceCheckout {
  source: string;
  path: string;
  judge: "base section" | "root .gitignore";
}

function checkoutPath(step: Step): string | null {
  if (!step.uses?.startsWith("actions/checkout@")) return null;
  const path = step.with?.path;
  if (typeof path !== "string" || path === "." || path.startsWith("${{ runner.temp }}"))
    return null;
  return path.replace(/\/+$/, "");
}

/** Step lists whose working directory is a repository checkout: every step of a composite action (it runs inside the
 *  caller's checkout), a workflow job that checks out at the root, and a spliced block (its anchor follows the
 *  starter's checkout step). A job checking out into subdirectories alone has no tree a sibling could land in. */
function checkedOutStepLists(rel: string, text: string, fragment: boolean): Step[][] {
  const stubbed = text.replaceAll(/^\{\{blocks\}\}$/gm, "").replaceAll(/\{\{[\w-]+\}\}/g, "x");
  if (fragment) return [parseYaml(`steps:\n${stubbed}`).steps ?? []];
  if (rel.endsWith("action.yml"))
    return [(parseYaml(stubbed) as { runs: { steps: Step[] } }).runs.steps];
  return Object.values((parseYaml(stubbed) as Workflow).jobs ?? {})
    .map((job) => job.steps ?? [])
    .filter((steps) =>
      steps.some(
        (step) => step.uses?.startsWith("actions/checkout@") && checkoutPath(step) === null,
      ),
    );
}

function workspaceCheckouts(): WorkspaceCheckout[] {
  const yamlUnder = (dir: string): string[] =>
    existsSync(dir)
      ? readdirSync(dir)
          .filter((name) => /\.ya?ml$/.test(name))
          .map((name) => join(dir, name))
      : [];
  const modules = readdirSync(FILES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(FILES, entry.name));
  const fragments = new Set(
    parseFilesConfig(readFileSync(join(REPO_ROOT, "files.yml"), "utf-8")).files.flatMap((entry) =>
      "sources" in entry && entry.path.startsWith(".github/workflows/")
        ? Object.values(entry.sources)
            .filter((source): source is string => typeof source === "string")
            .map((source) => join(FILES, source))
        : [],
    ),
  );
  const actions = [
    ...readdirSync(join(REPO_ROOT, "actions"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(REPO_ROOT, "actions", entry.name, "action.yml"))
      .filter(existsSync),
    ...modules.flatMap((dir) =>
      existsSync(join(dir, ".github/actions"))
        ? readdirSync(join(dir, ".github/actions")).map((name) =>
            join(dir, ".github/actions", name, "action.yml"),
          )
        : [],
    ),
  ];
  const workflows = [
    ...yamlUnder(join(REPO_ROOT, ".github/workflows")),
    ...modules.flatMap((dir) => yamlUnder(join(dir, ".github/workflows"))),
  ];
  return [...actions, ...workflows].flatMap((abs) => {
    const rel = relative(REPO_ROOT, abs);
    const shipped =
      rel.startsWith("actions/") ||
      rel.startsWith("files/") ||
      /^\.github\/workflows\/(fleet|reusable)-/.test(rel);
    return checkedOutStepLists(rel, readFileSync(abs, "utf8"), fragments.has(abs)).flatMap(
      (steps) =>
        steps.flatMap((step) => {
          const path = checkoutPath(step);
          return path === null
            ? []
            : [{ source: rel, path, judge: shipped ? "base section" : "root .gitignore" } as const];
        }),
    );
  });
}

test("every checkout path a fleet action or workflow creates inside the workspace is ignored, root-anchored", () => {
  const census = workspaceCheckouts();
  // Armed: the validator's platform checkout is the first member of the class, so an empty census is a broken scan.
  expect(census.filter((entry) => entry.judge === "base section").length).toBeGreaterThan(0);
  const start = BASE.indexOf(CI_WORKSPACE_SECTION);
  expect(start).toBeGreaterThanOrEqual(0);
  const section = BASE.slice(start).split(/\n(?=## )/)[0];
  const judged = census.map((entry) => {
    const gitignore = entry.judge === "base section" ? section : ROOT_GITIGNORE;
    return {
      ...entry,
      ignored: ignoredByGit(gitignore, entry.path, "dir"),
      nestedIgnored: ignoredByGit(gitignore, join("nested", entry.path), "dir"),
    };
  });
  expect(judged).toEqual(
    census.map((entry) => ({ ...entry, ignored: true, nestedIgnored: false })),
  );
});
