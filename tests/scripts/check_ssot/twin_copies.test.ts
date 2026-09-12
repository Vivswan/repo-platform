import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PLATFORM_NAME, PLATFORM_OWNER } from "../../../actions/shared/platform.ts";
import type { Mismatch } from "../../../scripts/check/ssot/comparison.ts";
import { REPO_ROOT } from "../../../scripts/check/ssot/inputs.ts";
import {
  OWN_COPIES,
  type TwinFacts,
  twinCopyMismatches,
} from "../../../scripts/check/ssot/twin_copies.ts";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();

const FILES_YML = [
  "placeholders: [project_name, description, github_username]",
  "modules:",
  "  bun: { gitignore_sources: [Node] }",
  "  deno: {}",
  "settings:",
  "  baseline: files/settings/baseline.yml",
  "  layers:",
  "    - { source: files/settings/public.yml, when: { private: false } }",
  "    - { source: files/settings/private.yml, when: { private: true } }",
  "    - { source: files/bun/settings.yml, when: { modules: [bun] } }",
  "  override: files/settings/override.yml",
  "files:",
  "  - { path: .github/settings.local.yml, class: starter }",
  "  - { path: .github/settings.yml, class: managed, render: settings, overlay: .github/settings.local.yml }",
  "  - { path: .github/workflows/ci.yml, class: managed }",
  "  - { path: .gitignore, class: split, region: hash, blocks: gitignore_sources }",
  "  - { path: AGENTS.md, class: split, region: html }",
  "  - { path: .github/actionlint.yaml, class: starter }",
  "  - { path: CLAUDE.md, class: link, target: AGENTS.md }",
  "  - { path: .github/workflows/private.yml, class: managed, when: { private: true } }",
  "  - { path: .dvmrc, class: managed, when: { modules: [deno] } }",
  "  - { path: constructor, class: link, target: AGENTS.md }",
  "  - { path: twins/CLAUDE.md, class: link, target: ../AGENTS.md }",
  "",
].join("\n");

const TREE: Record<string, string> = {
  "base/.github/settings.local.yml": "repository: {}\n",
  "settings/baseline.yml": "labels: []\n",
  "settings/public.yml": "repository: {}\n",
  "settings/private.yml": "repository: {}\n",
  "settings/override.yml": "rulesets: []\n",
  "bun/settings.yml": "labels: []\n",
  "base/.github/workflows/ci.yml":
    "# managed by {{github_username}}/repo-platform\nname: {{project_name}}\n",
  "base/.gitignore": "## base\n*.log\n",
  "bun/.block.Node.gitignore": "node_modules/\n",
  "base/AGENTS.md": "# Agents\n\n{{project_name}}: {{description}}\n",
  "base/.github/actionlint.yaml": "self-hosted-runner: {}\n",
  "base/.github/workflows/private.yml": "name: private\n",
  "deno/.dvmrc": "2.0.0\n",
};

const REGISTRATION = [
  "modules: [bun]",
  "project:",
  "  name: Demo",
  "  slug: demo",
  "  description: a fixture",
  "",
].join("\n");

const GITIGNORE_REGION =
  "# BEGIN REPO-PLATFORM MANAGED\n## base\n*.log\nnode_modules/\n# END REPO-PLATFORM MANAGED\n";
const AGENTS_REGION =
  "<!-- BEGIN REPO-PLATFORM MANAGED -->\n# Agents\n\nDemo: a fixture\n<!-- END REPO-PLATFORM MANAGED -->\n";

/** The operator's checkout as the rule judges it: every twin already exactly its render. */
const ROOT: Record<string, string> = {
  "files.yml": FILES_YML,
  ".repo-platform.yml": REGISTRATION,
  ".github/settings.local.yml": "repository: { private: false }\n",
  ".github/workflows/ci.yml": "# managed by Octo/repo-platform\nname: Demo\n",
  ".gitignore": `/local\n${GITIGNORE_REGION}\n/below\n`,
  "AGENTS.md": `${AGENTS_REGION}\n## Own guidance\n`,
  ".github/actionlint.yaml": "# edited since it was seeded\n",
};

function write(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

function fixture(mutate: (root: string) => void = () => {}): TwinFacts {
  const root = temp.dir("ssot-twin-copies-");
  for (const [rel, content] of Object.entries(TREE)) write(root, `files/${rel}`, content);
  for (const [rel, content] of Object.entries(ROOT)) write(root, rel, content);
  symlinkSync("AGENTS.md", join(root, "CLAUDE.md"));
  symlinkSync("AGENTS.md", join(root, "constructor"));
  mkdirSync(join(root, "twins"));
  symlinkSync("../AGENTS.md", join(root, "twins/CLAUDE.md"));
  mutate(root);
  return { root, slug: { owner: "Octo", name: "demo" }, own: {} };
}

const CI = ".github/workflows/ci.yml";
const CI_SOURCE = "files/base/.github/workflows/ci.yml";

describe("twinCopyMismatches", () => {
  test("a checkout whose twins all match is clean, edited starters and repo-owned halves included", () => {
    expect(twinCopyMismatches(fixture())).toEqual([]);
  });

  const cases: { reason: string; mutate: (root: string) => void; expected: Mismatch[] }[] = [
    {
      reason: "a managed copy differing from its render names the first differing line",
      mutate: (root) => write(root, CI, "# managed by Octo/repo-platform\nname: Other\n"),
      expected: [
        {
          file: CI,
          expected: `${CI_SOURCE} as the writer renders it for this repository (line 2: "name: Demo")`,
          got: 'line 2: "name: Other"',
        },
      ],
    },
    {
      reason: "a managed copy that is longer than its render is judged past the render's end",
      mutate: (root) => write(root, CI, "# managed by Octo/repo-platform\nname: Demo\nextra: 1\n"),
      expected: [
        {
          file: CI,
          expected: `${CI_SOURCE} as the writer renders it for this repository (line 3: "")`,
          got: 'line 3: "extra: 1"',
        },
      ],
    },
    {
      reason: "a selected managed copy that is missing",
      mutate: (root) => rmSync(join(root, CI)),
      expected: [
        {
          file: CI,
          expected: `a regular file holding ${CI_SOURCE} as rendered`,
          got: "nothing there",
        },
      ],
    },
    {
      reason: "a split copy whose region drifted (the halves outside stay the repository's)",
      mutate: (root) =>
        write(root, ".gitignore", `/anything\n${GITIGNORE_REGION.replace("*.log", "*.tmp")}`),
      expected: [
        {
          file: ".gitignore",
          expected: `files/base/.gitignore as the writer renders it for this repository (line 3: "*.log")`,
          got: 'line 3: "*.tmp"',
        },
      ],
    },
    {
      reason: "a split copy without one clean region",
      mutate: (root) => write(root, "AGENTS.md", "# Agents\n\nDemo: a fixture\n"),
      expected: [
        {
          file: "AGENTS.md",
          expected:
            "one clean managed region between <!-- BEGIN REPO-PLATFORM MANAGED --> and <!-- END REPO-PLATFORM MANAGED -->",
          got: "markers missing, duplicated, out of order, or buried mid-line",
        },
      ],
    },
    {
      reason: "a link aimed elsewhere",
      mutate: (root) => {
        rmSync(join(root, "CLAUDE.md"));
        symlinkSync("README.md", join(root, "CLAUDE.md"));
      },
      expected: [
        { file: "CLAUDE.md", expected: "a symbolic link to AGENTS.md", got: "a link to README.md" },
      ],
    },
    {
      reason: "a regular file where a link is declared",
      mutate: (root) => {
        rmSync(join(root, "CLAUDE.md"));
        write(root, "CLAUDE.md", "copied\n");
      },
      expected: [
        {
          file: "CLAUDE.md",
          expected: "a symbolic link to AGENTS.md",
          got: "a regular file, not a link",
        },
      ],
    },
    {
      reason: "a copy whose path is named like an inherited property is judged like any other",
      mutate: (root) => rmSync(join(root, "constructor")),
      expected: [
        { file: "constructor", expected: "a symbolic link to AGENTS.md", got: "nothing there" },
      ],
    },
    {
      reason: "a managed copy whose bytes differ only where a decode would fold them",
      mutate: (root) => {
        write(root, "files/base/.github/workflows/ci.yml", "name: {{project_name}} \ufffd\n");
        writeFileSync(join(root, CI), Buffer.from("name: Demo \xff\n", "latin1"));
      },
      expected: [
        {
          file: CI,
          expected: `${CI_SOURCE} as the writer renders it for this repository, byte for byte`,
          got: "the same text in different bytes (an invalid UTF-8 sequence where the render has U+FFFD)",
        },
      ],
    },
    {
      reason: "a placeholder the registration leaves empty",
      mutate: (root) => write(root, ".repo-platform.yml", REGISTRATION.replace("a fixture", '""')),
      expected: [
        {
          file: "AGENTS.md",
          expected:
            "a value for {{description}} in .repo-platform.yml (files/base/AGENTS.md uses it)",
          got: "none",
        },
      ],
    },
    {
      reason:
        "the overlay flipping to private selects the private-only entry, whose copy is absent",
      mutate: (root) =>
        write(root, ".github/settings.local.yml", "repository: { private: true }\n"),
      expected: [
        {
          file: ".github/workflows/private.yml",
          expected: "a regular file holding files/base/.github/workflows/private.yml as rendered",
          got: "nothing there",
        },
      ],
    },
    {
      reason: "a module joining the registration selects its entry, whose copy is absent",
      mutate: (root) =>
        write(root, ".repo-platform.yml", REGISTRATION.replace("[bun]", "[bun, deno]")),
      expected: [
        {
          file: ".dvmrc",
          expected: "a regular file holding files/deno/.dvmrc as rendered",
          got: "nothing there",
        },
      ],
    },
  ];

  test.each(cases)("$reason", ({ mutate, expected }) => {
    expect(twinCopyMismatches(fixture(mutate))).toEqual(expected);
  });

  test("an own path is exempt while selected, and stale once nothing writes it", () => {
    const drifted = fixture((root) => write(root, CI, "name: mine\n"));
    expect(twinCopyMismatches({ ...drifted, own: { [CI]: "the fixture's own CI" } })).toEqual([]);
    expect(twinCopyMismatches({ ...fixture(), own: { ".dvmrc": "not selected here" } })).toEqual([
      {
        file: "scripts/check/ssot/twin_copies.ts OWN_COPIES",
        expected: "'.dvmrc' written for this repository by a managed, split, or link entry",
        got: "no such entry - the line here is stale; remove it in the same change",
      },
    ]);
  });

  test("a link under a linked ancestor is refused like the writer would, never read through", () => {
    const facts = fixture((root) => {
      rmSync(join(root, "twins"), { recursive: true });
      mkdirSync(join(root, "elsewhere"));
      symlinkSync("../AGENTS.md", join(root, "elsewhere/CLAUDE.md"));
      symlinkSync("elsewhere", join(root, "twins"));
    });
    expect(() => twinCopyMismatches(facts)).toThrow("ancestor 'twins' is a symbolic link");
  });

  test("an overlay that declares no visibility is anchor-lost, never a pass", () => {
    const facts = fixture((root) => write(root, ".github/settings.local.yml", "repository: {}\n"));
    expect(() => twinCopyMismatches(facts)).toThrow("repository.private is not declared");
  });
});

describe("the live repository", () => {
  const live = { root: REPO_ROOT, slug: { owner: PLATFORM_OWNER, name: PLATFORM_NAME } };

  test("every twin matches its render - the control for the fixture cases", () => {
    expect(twinCopyMismatches({ ...live, own: OWN_COPIES })).toEqual([]);
  });

  test("every OWN_COPIES line names a root file that diverges from its render today, so none is idle", () => {
    const diverging = twinCopyMismatches({ ...live, own: {} }).map((m) => m.file);
    expect([...diverging].sort()).toEqual(Object.keys(OWN_COPIES).sort());
  });
});
