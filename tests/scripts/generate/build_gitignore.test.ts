import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { capture } from "../../../.github/scripts/shared/proc.ts";
import { parseFilesConfig } from "../../../actions/plan/files_config.ts";
import {
  ALWAYS,
  blockName,
  blockRel,
  buildBlock,
  buildFilesBase,
  CI_WORKSPACE_SECTION,
  gitignoreSources,
  main,
  missingBlockFiles,
  PLATFORM_SECTIONS,
  sectionsIn,
  sourceId,
  strayBlockFiles,
  topologyProblems,
  writeOwnGitignore,
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
  "  pages:",
  "    description: pages",
  "files:",
  "  - {path: .gitignore, class: split, region: hash, blocks: gitignore_sources}",
  "",
].join("\n");

const ENTRIES: [string, string[]][] = [
  ["bun", ["Node.gitignore", "bun.gitignore"]],
  ["uv", ["Python.gitignore"]],
  ["fuzzer", ["fuzzer"]],
];

function generated(): { root: string; filesDir: string } {
  const root = temp.dir("build-gitignore-");
  const filesDir = join(root, "files");
  const write = (rel: string, content: string) => {
    const abs = join(filesDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };
  write("base/.gitignore", buildFilesBase(SECTIONS));
  for (const [module, sources] of ENTRIES) {
    for (const path of sources) write(blockRel(module, path), buildBlock(SECTIONS[path]));
  }
  return { root, filesDir };
}

describe("the source grammar", () => {
  test("a files.yml name is a github/gitignore root stem or a platform section, and the block file carries it", () => {
    expect(sourceId("Node")).toBe("Node.gitignore");
    expect(sourceId("fuzzer")).toBe("fuzzer");
    expect(blockName("Global/macOS.gitignore")).toBe("macOS");
    expect(blockName("fuzzer")).toBe("fuzzer");
    expect(blockRel("bun", "Node.gitignore")).toBe("bun/.block.Node.gitignore");
    expect(blockRel("fuzzer", "fuzzer")).toBe("fuzzer/.block.fuzzer.gitignore");
  });

  test("gitignoreSources reads the declaring modules in files.yml order", () => {
    expect(gitignoreSources(parseFilesConfig(FILES_YML))).toEqual(ENTRIES);
  });

  test("a non-list declaration is refused by name", () => {
    expect(() =>
      gitignoreSources(parseFilesConfig(FILES_YML.replace("[Python]", "Python"))),
    ).toThrow("modules.uv.gitignore_sources must be a list of names");
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

describe("the operator's own .gitignore", () => {
  /** The registration selects bun and fuzzer, not uv: the region carries their sources in files.yml order and no Python. */
  const REGISTRATION =
    "modules: [pages, fuzzer, bun]\nproject: {name: Demo, slug: demo, description: d}\n";
  const REGION =
    `# BEGIN REPO-PLATFORM MANAGED\n${buildFilesBase(SECTIONS)}` +
    `${buildBlock(SECTIONS["Node.gitignore"])}${buildBlock(SECTIONS["bun.gitignore"])}${buildBlock(SECTIONS.fuzzer)}` +
    "# END REPO-PLATFORM MANAGED\n";
  const STALE = "# BEGIN REPO-PLATFORM MANAGED\nstale\n# END REPO-PLATFORM MANAGED\n";

  function own(existing: string | null): { change: string; file: string } {
    const { root, filesDir } = generated();
    writeFileSync(join(root, "files.yml"), FILES_YML);
    writeFileSync(join(root, ".repo-platform.yml"), REGISTRATION);
    if (existing !== null) writeFileSync(join(root, ".gitignore"), existing);
    const outcome = writeOwnGitignore(root, join(root, "files.yml"), filesDir);
    return { change: outcome.change, file: readFileSync(join(root, ".gitignore"), "utf-8") };
  }

  test.each<{ reason: string; existing: string | null; change: string; file: string }>([
    {
      reason: "a stale region is replaced between the repository's own sides",
      existing: `# mine\n\n${STALE}\n# after\n`,
      change: "replaced local edits",
      file: `# mine\n\n${REGION}\n# after\n`,
    },
    { reason: "no file becomes the region alone", existing: null, change: "created", file: REGION },
    {
      reason: "a marker-free file gets the region above its content",
      existing: "# own\n",
      change: "region added",
      file: `${REGION}# own\n`,
    },
    {
      reason: "the exact render is left alone",
      existing: REGION,
      change: "unchanged",
      file: REGION,
    },
  ])("$reason", ({ existing, change, file }) => {
    expect(own(existing)).toEqual({ change, file });
  });

  test("a malformed region is refused the way the writer refuses it", () => {
    expect(() => own(`${STALE}${STALE}`)).toThrow(
      ".gitignore: the managed-region marker text is duplicated, out of order, or buried mid-line",
    );
  });
});

describe("the offline topology check", () => {
  test("the generator's own outputs pass", () => {
    const { filesDir } = generated();
    expect(strayBlockFiles(ENTRIES, filesDir)).toEqual([]);
    expect(missingBlockFiles(ENTRIES, filesDir)).toEqual([]);
    expect(topologyProblems({ entries: ENTRIES, filesDir })).toEqual([]);
  });

  test("a block no source names is a stray; a declared source without its block is missing", () => {
    const { filesDir } = generated();
    writeFileSync(join(filesDir, "uv/.block.Old.gitignore"), "x\n");
    expect(strayBlockFiles(ENTRIES, filesDir)).toEqual(["files/uv/.block.Old.gitignore"]);
    expect(missingBlockFiles([...ENTRIES, ["rust", ["Rust.gitignore"]]], filesDir)).toEqual([
      "files/rust/.block.Rust.gitignore",
    ]);
  });

  test("a block whose heading names another source, a hand-edited block, and two modules' copies that differ are named", () => {
    const { filesDir } = generated();
    writeFileSync(
      join(filesDir, "bun/.block.bun.gitignore"),
      buildBlock(SECTIONS["Node.gitignore"]),
    );
    writeFileSync(join(filesDir, "uv/.block.Python.gitignore"), SECTIONS["Python.gitignore"]);
    expect(topologyProblems({ entries: ENTRIES, filesDir }).map((p) => p.split(";")[0])).toEqual([
      "files/bun/.block.bun.gitignore encodes [Node.gitignore] but its name stands for bun.gitignore",
      "files/uv/.block.Python.gitignore is not exactly its section plus one blank line",
    ]);
    const shared: [string, string[]][] = [...ENTRIES, ["deno", ["Node.gitignore"]]];
    writeFileSync(
      join(filesDir, "bun/.block.bun.gitignore"),
      buildBlock(SECTIONS["bun.gitignore"]),
    );
    writeFileSync(
      join(filesDir, "uv/.block.Python.gitignore"),
      buildBlock(SECTIONS["Python.gitignore"]),
    );
    mkdirSync(join(filesDir, "deno"));
    writeFileSync(
      join(filesDir, "deno/.block.Node.gitignore"),
      buildBlock("## Node (github/gitignore Node.gitignore)\nnode_modules/\ndist/\n"),
    );
    expect(topologyProblems({ entries: shared, filesDir }).map((p) => p.split(";")[0])).toEqual([
      "files/deno/.block.Node.gitignore differs from another module's copy of Node.gitignore",
    ]);
  });

  test("a base that dropped an OS section is named, not rebuilt to itself", () => {
    const { filesDir } = generated();
    const without = Object.fromEntries(
      Object.entries(SECTIONS).filter(([path]) => path !== "Global/Windows.gitignore"),
    );
    writeFileSync(join(filesDir, "base/.gitignore"), buildFilesBase(without));
    expect(topologyProblems({ entries: ENTRIES, filesDir }).map((p) => p.split(";")[0])).toEqual([
      "files/base/.gitignore lacks the section(s) [Global/Windows.gitignore]",
    ]);
  });

  test("a platform-authored block whose body drifted from the generator is named", () => {
    const { filesDir } = generated();
    const drifted = "## Fuzzer workspace paths (repo-platform fuzzer)\n";
    writeFileSync(join(filesDir, "fuzzer/.block.fuzzer.gitignore"), buildBlock(drifted));
    expect(topologyProblems({ entries: ENTRIES, filesDir }).map((p) => p.split(";")[0])).toEqual([
      "files/fuzzer/.block.fuzzer.gitignore is not the platform-authored section fuzzer",
    ]);
  });

  test("a stale base and a missing base are named", () => {
    const { filesDir } = generated();
    writeFileSync(join(filesDir, "base/.gitignore"), `${buildFilesBase(SECTIONS)}extra\n`);
    expect(topologyProblems({ entries: ENTRIES, filesDir }).map((p) => p.split(";")[0])).toEqual([
      "files/base/.gitignore is not the header, the agent and CI workspace sections, and exactly the OS sections [Global/Windows.gitignore, Global/macOS.gitignore, Global/Linux.gitignore]",
    ]);
    expect(topologyProblems({ entries: ENTRIES, filesDir: temp.dir("empty-files-") })).toEqual([
      "files/base/.gitignore is missing; run 'bun scripts/generate/build_gitignore.ts' to regenerate every copy",
    ]);
  });

  test("the committed copies agree (the live topology gate)", async () => {
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
