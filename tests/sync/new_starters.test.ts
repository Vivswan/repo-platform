// The new-starter hold (new_starters.ts via retired_cleanup.ts): held with the file, its callers,
// and the rendered starter; the same starter in a target without the file is no hold. The
// end-to-end rows run the real retired_cleanup.ts with copier stubbed to serve fixture renders.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  newStarterPaths,
  newStartersReport,
  renderReferences,
  starterExcerpt,
} from "../../.github/scripts/sync/new_starters.ts";
import { NEW_STARTERS_REVIEW_NAME } from "../../.github/scripts/sync/section_files.ts";
import { MANIFEST_NAME } from "../../actions/shared/manifest.ts";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();
const REPO_ROOT = join(import.meta.dir, "../..");
const STARTER = ".github/workflows/post-green.yml";
const CALLER = ".github/workflows/ci.yml";
const STARTER_TEXT =
  "name: Post Green\non:\n  workflow_call:\n    inputs:\n      sha:\n        type: string\n";

function writeTree(root: string, files: Record<string, string>): string {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

const manifestOf = (entries: Record<string, string>) =>
  `{\n  "files": {\n${Object.entries(entries)
    .map(([rel, entry]) => `    ${JSON.stringify(rel)}: ${entry}`)
    .join(",\n")}\n  }\n}\n`;

const OLD_MANIFEST = { [CALLER]: '{"class": "managed", "hash": null}' };
const NEW_MANIFEST = { ...OLD_MANIFEST, [STARTER]: '{"class": "starter"}' };

/** The hold's exact PR-body text for the one fixture starter, called by ci.yml. */
const EXPECTED_REPORT = `> [!WARNING]
> NEW STARTER at a path this repository already owns. The template now
> generates these files once (\`_skip_if_exists\`), and copier kept the
> repository's copy without a conflict - so the template's callers may
> expect an interface the kept file lacks. Check each file against the
> template's starter (inputs, triggers, keys), then merge.

- \`${STARTER}\`: kept as this repository's own file (named by \`${CALLER}\`). The template's starter at this path, for comparison:

  \`\`\`\`text
  name: Post Green
  on:
    workflow_call:
      inputs:
        sha:
          type: string
  \`\`\`\`
`;

describe("newStarterPaths", () => {
  test("only a starter with no old entry of any class counts, sorted", () => {
    const managed = { class: "managed" };
    const starter = { class: "starter" };
    const old = { "b.yml": starter, "flip.yml": managed, "gone.yml": starter };
    const fresh = {
      "z.yml": starter,
      "a.yml": starter,
      "b.yml": starter,
      "flip.yml": starter,
      "new-managed.yml": managed,
    };
    expect(newStarterPaths(old, fresh)).toEqual(["a.yml", "z.yml"]);
  });
});

describe("renderReferences and the report", () => {
  test("the callers are the render files naming the path, the starter and manifest excluded", () => {
    const render = writeTree(temp.dir("render-"), {
      [STARTER]: STARTER_TEXT,
      [CALLER]: `jobs:\n  post-green:\n    uses: ./${STARTER}\n`,
      "README.md": "unrelated\n",
      [MANIFEST_NAME]: manifestOf(NEW_MANIFEST),
      "docs/b.md": `see ${STARTER}\n`,
    });
    expect(renderReferences(render, STARTER)).toEqual([CALLER, "docs/b.md"]);
  });

  test("the excerpt keeps whole leading lines within the budget and marks a cut", () => {
    expect(starterExcerpt("one\ntwo\nthree\n", 8)).toBe(
      "one\ntwo\n(truncated; the clean render at the new ref has the rest)",
    );
    expect(starterExcerpt("one\ntwo\n", 8)).toBe("one\ntwo");
  });

  test("the report names the file, its callers, and the template's starter; none is empty", () => {
    expect(newStartersReport([])).toBe("");
    expect(
      newStartersReport([{ path: STARTER, referencedBy: [CALLER], template: STARTER_TEXT }]),
    ).toBe(EXPECTED_REPORT);
    expect(newStartersReport([{ path: STARTER, referencedBy: [], template: "x\n" }])).toContain(
      `- \`${STARTER}\`: kept as this repository's own file (no template file names it by path).`,
    );
  });
});

/** Run retired_cleanup.ts against a real git target with copier stubbed to serve the fixture
 * renders (keyed on --vcs-ref) and render_data.ts stubbed out; everything else is real. */
function runCleanup(opts: {
  /** The target's HEAD (the repository before this update). */
  targetFiles: Record<string, string>;
  /** What copier's update left in the working tree, uncommitted. */
  updated?: Record<string, string>;
  oldRender: Record<string, string>;
  newRender: Record<string, string>;
}) {
  const root = temp.dir("new-starters-");
  const bin = join(root, "bin");
  mkdirSync(bin);
  const fixtureOld = writeTree(join(root, "fixture-old"), opts.oldRender);
  const fixtureNew = writeTree(join(root, "fixture-new"), opts.newRender);
  writeFileSync(
    join(bin, "bun"),
    [
      "#!/usr/bin/env bash",
      'case "$*" in',
      "  *render_data.ts*) exit 0 ;;",
      '  *) exec "$REAL_BUN" "$@" ;;',
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, "copier"),
    [
      "#!/usr/bin/env bash",
      'dest="${@: -1}"',
      'mkdir -p "$dest"',
      'case "$*" in',
      `  *"--vcs-ref old"*) cp -R "${fixtureOld}/." "$dest/" ;;`,
      `  *"--vcs-ref new"*) cp -R "${fixtureNew}/." "$dest/" ;;`,
      "  *) exit 1 ;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const target = writeTree(join(root, "target"), {
    ".github/.copier-answers.yml": "modules: [uv]\n",
    ...opts.targetFiles,
  });
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (pair): pair is [string, string] => !pair[0].startsWith("GIT_") && pair[1] !== undefined,
    ),
  );
  const git = (...args: string[]) => {
    const proc = boundedSpawnSync(["git", "-C", target, ...args], { env });
    if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${proc.stderr}`);
  };
  git("init", "-q", "-b", "main");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "pre-update");
  writeTree(target, opts.updated ?? {});
  const runnerTemp = join(root, "temp");
  mkdirSync(runnerTemp);
  for (const name of ["copier-old.yml", "copier-new.yml"]) {
    writeFileSync(join(runnerTemp, name), `_skip_if_exists:\n  - ${STARTER}\n`);
  }
  const proc = boundedSpawnSync(
    ["bun", join(REPO_ROOT, ".github/scripts/sync/retired_cleanup.ts")],
    {
      cwd: REPO_ROOT,
      env: {
        ...env,
        PATH: `${bin}:${process.env.PATH}`,
        REAL_BUN: process.execPath,
        RUNNER_TEMP: runnerTemp,
        TARGET_DIR: target,
        MODULES: '["uv"]',
        PRIVATE: "false",
        DESCRIPTION: "d",
        SRC_PATH: root,
        OLD_SHA: "old",
        TARGET_REF: "new",
      },
      timeoutMs: 60_000,
    },
  );
  const read = (name: string) =>
    existsSync(join(runnerTemp, name)) ? readFileSync(join(runnerTemp, name), "utf-8") : null;
  return {
    exitCode: proc.exitCode,
    warnings: proc.stdout.split("\n").filter((line) => line.startsWith("::")),
    retired: read("retired-paths.json"),
    removed: read("removed-paths.txt"),
    report: read(NEW_STARTERS_REVIEW_NAME),
    starter: existsSync(join(target, STARTER))
      ? readFileSync(join(target, STARTER), "utf-8")
      : null,
  };
}

const OWN_STARTER = "name: My Hook\non: push\n";
const OLD_RENDER = {
  [CALLER]: "jobs: {}\n",
  [MANIFEST_NAME]: manifestOf(OLD_MANIFEST),
};
const NEW_RENDER = {
  [CALLER]: `jobs:\n  post-green:\n    uses: ./${STARTER}\n`,
  [STARTER]: STARTER_TEXT,
  [MANIFEST_NAME]: manifestOf(NEW_MANIFEST),
};

describe("retired_cleanup raises the new-starter hold", () => {
  test("a new starter at a path the target already owns is held, the target's file untouched", () => {
    // The target after copier update: its own post-green.yml kept (skip_if_exists), nothing else
    // touched. Pre-fix the report did not exist and the PR auto-merged around the kept file.
    expect(
      runCleanup({
        targetFiles: { [STARTER]: OWN_STARTER },
        oldRender: OLD_RENDER,
        newRender: NEW_RENDER,
      }),
    ).toEqual({
      exitCode: 0,
      warnings: [
        `::warning::new starter ${STARTER} already exists in the repository; held for review`,
      ],
      retired: "[]\n",
      removed: "",
      report: EXPECTED_REPORT,
      starter: OWN_STARTER,
    });
  });

  test("control: the same new starter in a target without the file is no hold", () => {
    // copier's update renders the starter here (modelled by the render's copy); the cleanup step
    // sees a starter new to the template that HEAD never carried.
    expect(
      runCleanup({
        targetFiles: {},
        updated: { [STARTER]: STARTER_TEXT },
        oldRender: OLD_RENDER,
        newRender: NEW_RENDER,
      }),
    ).toEqual({
      exitCode: 0,
      warnings: [],
      retired: "[]\n",
      removed: "",
      report: "",
      starter: STARTER_TEXT,
    });
  });

  test("an old render without a manifest fails the step: new starters cannot be told apart", () => {
    const result = runCleanup({
      targetFiles: {},
      oldRender: { [CALLER]: "jobs: {}\n" },
      newRender: NEW_RENDER,
    });
    expect(result.exitCode).toBe(1);
    expect(result.warnings.join("\n")).toContain(
      `renders no ${MANIFEST_NAME}; new starters cannot be told from existing ones`,
    );
  });
});
