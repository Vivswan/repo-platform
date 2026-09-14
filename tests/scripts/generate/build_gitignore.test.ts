import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { capture } from "../../../.github/scripts/shared/proc.ts";
import { parseFilesConfig } from "../../../actions/plan/files_config.ts";
import {
  ALWAYS,
  blockName,
  buildBlock,
  buildFilesBase,
  CI_WORKSPACE_SECTION,
  type GitignoreBlocks,
  gitignoreBlocks,
  main,
  missingBlockFiles,
  PLATFORM_SECTIONS,
  sectionsIn,
  sourceId,
  strayBlockFiles,
  topologyProblems,
} from "../../../scripts/generate/build_gitignore";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();

const SECTIONS: Record<string, string> = {
  "Global/Windows.gitignore": "## Windows (github/gitignore Global/Windows.gitignore)\nThumbs.db\n",
  "Global/macOS.gitignore": "## macOS (github/gitignore Global/macOS.gitignore)\n.DS_Store\n",
  "Global/Linux.gitignore": "## Linux (github/gitignore Global/Linux.gitignore)\n*~\n",
  "Node.gitignore": "## Node (github/gitignore Node.gitignore)\nnode_modules/\n",
  "bun.gitignore": "## bun (github/gitignore bun.gitignore)\nbun.lockb\n",
  "Python.gitignore": "## Python (github/gitignore Python.gitignore)\n__pycache__/\n\n*.py[cod]\n",
  "Deno.gitignore": "## Deno (github/gitignore Deno.gitignore)\n.deno/\n",
  ...PLATFORM_SECTIONS,
};

const FILES_YML = [
  "placeholders: [project_name]",
  "modules:",
  "  bun:",
  "    description: bun",
  "    gitignore_sources: [Node, bun]",
  "  uv:",
  "    description: uv",
  "    gitignore_sources: [Python]",
  "  fuzzer:",
  "    description: fuzzer",
  "    gitignore_sources: [fuzzer]",
  "  deno:",
  "    description: deno",
  "    gitignore_sources: [Deno, Node]",
  "  pages:",
  "    description: pages",
  "files:",
  "  - {path: .gitignore, class: split, region: hash, blocks: gitignore_sources, blocks_dir: files/gitignore}",
  "",
].join("\n");

/** One file per source in first-declared order; Node, named by bun and deno, maps once. */
const BLOCKS: GitignoreBlocks = {
  dir: "gitignore",
  files: new Map([
    ["Node.gitignore", "gitignore/Node.gitignore"],
    ["bun.gitignore", "gitignore/bun.gitignore"],
    ["Python.gitignore", "gitignore/Python.gitignore"],
    ["fuzzer", "gitignore/fuzzer.gitignore"],
    ["Deno.gitignore", "gitignore/Deno.gitignore"],
  ]),
};

function generated(): { root: string; filesDir: string } {
  const root = temp.dir("build-gitignore-");
  const filesDir = join(root, "files");
  const write = (rel: string, content: string) => {
    const abs = join(filesDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };
  write("base/.gitignore", buildFilesBase(SECTIONS));
  for (const [path, rel] of BLOCKS.files) write(rel, buildBlock(SECTIONS[path]));
  return { root, filesDir };
}

describe("the source grammar", () => {
  test("a files.yml name is a github/gitignore root stem or a platform section", () => {
    expect(sourceId("Node")).toBe("Node.gitignore");
    expect(sourceId("fuzzer")).toBe("fuzzer");
    expect(blockName("Global/macOS.gitignore")).toBe("macOS");
    expect(blockName("fuzzer")).toBe("fuzzer");
  });

  test("gitignoreBlocks maps each source once to its shared block file, in files.yml order", () => {
    const { dir, files } = gitignoreBlocks(parseFilesConfig(FILES_YML));
    expect(dir).toBe(BLOCKS.dir);
    expect([...files]).toEqual([...BLOCKS.files]);
  });

  test.each([
    [
      "a non-list declaration",
      "[Python]",
      "Python",
      "modules.uv.gitignore_sources must be a list of names",
    ],
    [
      "an entry without blocks_dir",
      ", blocks_dir: files/gitignore",
      "",
      "the .gitignore entry needs blocks_dir",
    ],
    [
      "no .gitignore entry",
      "path: .gitignore",
      "path: .dockerignore",
      "no .gitignore entry declares blocks",
    ],
  ])("%s is refused by name", (_reason, from, to, message) => {
    expect(() => gitignoreBlocks(parseFilesConfig(FILES_YML.replace(from, to)))).toThrow(message);
  });
});

describe("the outputs", () => {
  test("files/base/.gitignore is the header, the two local sections, and the OS sections", () => {
    const base = buildFilesBase(SECTIONS);
    expect(base.startsWith("# Generated from github/gitignore")).toBe(true);
    expect(base).toContain(CI_WORKSPACE_SECTION);
    expect(Object.keys(sectionsIn(base))).toEqual(ALWAYS);
  });

  test("a block file is its section plus one blank line", () => {
    expect(buildBlock(SECTIONS["Node.gitignore"])).toBe(
      "## Node (github/gitignore Node.gitignore)\nnode_modules/\n\n",
    );
  });

  test("sectionsIn reads each section back, upstream or platform, blank lines inside a body kept", () => {
    const text = `${buildBlock(SECTIONS["Python.gitignore"])}${buildBlock(SECTIONS.fuzzer)}${SECTIONS["Node.gitignore"]}`;
    expect(sectionsIn(text)).toEqual({
      "Python.gitignore": SECTIONS["Python.gitignore"],
      fuzzer: SECTIONS.fuzzer,
      "Node.gitignore": SECTIONS["Node.gitignore"],
    });
  });
});

describe("the offline topology check", () => {
  test("the generator's own outputs pass", () => {
    const { filesDir } = generated();
    expect(strayBlockFiles(BLOCKS, filesDir)).toEqual([]);
    expect(missingBlockFiles(BLOCKS, filesDir)).toEqual([]);
    expect(topologyProblems({ blocks: BLOCKS, filesDir })).toEqual([]);
  });

  test("a block no source names is a stray; a declared source without its block is missing", () => {
    const { filesDir } = generated();
    writeFileSync(join(filesDir, "gitignore/Old.gitignore"), "x\n");
    expect(strayBlockFiles(BLOCKS, filesDir)).toEqual(["files/gitignore/Old.gitignore"]);
    const withRust: GitignoreBlocks = {
      dir: BLOCKS.dir,
      files: new Map([...BLOCKS.files, ["Rust.gitignore", "gitignore/Rust.gitignore"]]),
    };
    expect(missingBlockFiles(withRust, filesDir)).toEqual(["files/gitignore/Rust.gitignore"]);
  });

  test("a block whose heading names another source and a hand-edited block are named", () => {
    const { filesDir } = generated();
    writeFileSync(
      join(filesDir, "gitignore/bun.gitignore"),
      buildBlock(SECTIONS["Node.gitignore"]),
    );
    writeFileSync(join(filesDir, "gitignore/Python.gitignore"), SECTIONS["Python.gitignore"]);
    expect(topologyProblems({ blocks: BLOCKS, filesDir }).map((p) => p.split(";")[0])).toEqual([
      "files/gitignore/bun.gitignore encodes [Node.gitignore] but its name stands for bun.gitignore",
      "files/gitignore/Python.gitignore is not exactly its section plus one blank line",
    ]);
  });

  test("a base that dropped an OS section is named, not rebuilt to itself", () => {
    const { filesDir } = generated();
    const without = Object.fromEntries(
      Object.entries(SECTIONS).filter(([path]) => path !== "Global/Windows.gitignore"),
    );
    writeFileSync(join(filesDir, "base/.gitignore"), buildFilesBase(without));
    expect(topologyProblems({ blocks: BLOCKS, filesDir }).map((p) => p.split(";")[0])).toEqual([
      "files/base/.gitignore lacks the section(s) [Global/Windows.gitignore]",
    ]);
  });

  test("a platform-authored block whose body drifted from the generator is named", () => {
    const { filesDir } = generated();
    const drifted = "## Fuzzer workspace paths (repo-platform fuzzer)\n";
    writeFileSync(join(filesDir, "gitignore/fuzzer.gitignore"), buildBlock(drifted));
    expect(topologyProblems({ blocks: BLOCKS, filesDir }).map((p) => p.split(";")[0])).toEqual([
      "files/gitignore/fuzzer.gitignore is not the platform-authored section fuzzer",
    ]);
  });

  test("a stale base and a missing base are named", () => {
    const { filesDir } = generated();
    writeFileSync(join(filesDir, "base/.gitignore"), `${buildFilesBase(SECTIONS)}extra\n`);
    expect(topologyProblems({ blocks: BLOCKS, filesDir }).map((p) => p.split(";")[0])).toEqual([
      "files/base/.gitignore is not the header, the agent and CI workspace sections, and exactly the OS sections [Global/Windows.gitignore, Global/macOS.gitignore, Global/Linux.gitignore]",
    ]);
    expect(topologyProblems({ blocks: BLOCKS, filesDir: temp.dir("empty-files-") })).toEqual([
      "files/base/.gitignore is missing; run 'bun scripts/generate/build_gitignore.ts' to regenerate",
    ]);
  });

  test("the committed outputs pass (the live topology gate)", async () => {
    const original = console.log;
    console.log = () => {};
    try {
      expect(await main(["--topology"])).toBe(0);
    } finally {
      console.log = original;
    }
  });
});

describe("argument parsing", () => {
  /** Unknown arguments are rejected before the fetch, so this stays offline. */
  async function reject(argv: string[]): Promise<{ code: number; message: string }> {
    const original = console.error;
    let message = "";
    console.error = (value: unknown) => {
      message = String(value);
    };
    try {
      return { code: await main(argv), message };
    } finally {
      console.error = original;
    }
  }

  test.each<{ argv: string[]; reason: string }>([
    { argv: ["--locked"], reason: "a retired pin mode" },
    { argv: ["--check"], reason: "the other generators' check flag" },
    { argv: ["--dry-run", "x"], reason: "any other argument, several at once" },
  ])("$reason is rejected naming the argument(s), not silently ignored", async ({ argv }) => {
    const { code, message } = await reject(argv);
    expect(code).toBe(2);
    expect(message).toContain(argv.join(" "));
  });
});

describe("the platform-authored sections", () => {
  function ignoredByGit(section: string, rel: string, kind: "dir" | "file"): boolean {
    const repo = temp.dir("gitignore-ci-workspace-");
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

  // Only fuzzer repositories produce .fuzz-failures/, so the base section must leave the name alone.
  const cases: [string, string, "dir" | "file", boolean][] = [
    ["base", "results.sarif", "file", true],
    ["base", ".fuzz-failures", "dir", false],
    ["base", "assets/logo.png", "file", false],
    ["base", "scan/results.sarif", "file", false],
    ["fuzzer", ".fuzz-failures", "dir", true],
    ["fuzzer", ".fuzz-failures", "file", false],
    ["fuzzer", "crate/.fuzz-failures", "dir", false],
  ];

  test.each(cases)("%s section: %s (%s) ignored: %p", (section, rel, kind, ignored) => {
    const text = section === "base" ? CI_WORKSPACE_SECTION : PLATFORM_SECTIONS[section];
    expect(ignoredByGit(text, rel, kind)).toBe(ignored);
  });
});
