// Unit tests for build_gitignore's pure pieces: the source grammar (a
// files.yml name is a github/gitignore root stem, block files are named
// after it), the three outputs derived from one section map, and the
// offline topology check that every copy of a section agrees. The argv
// tests pin the two-mode shape: the script takes only --topology, and any
// other flag is rejected before any network call. The CI workspace tests
// prove the section's patterns against git itself.

import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { capture } from "../../../.github/scripts/shared/proc.ts";
import {
  ALWAYS,
  blockName,
  blockRel,
  buildBlock,
  buildFilesBase,
  buildSelf,
  CI_WORKSPACE_SECTION,
  existingLocalSides,
  gitignoreSources,
  main,
  missingBlockFiles,
  sectionsIn,
  selfSources,
  strayBlockFiles,
  topologyProblems,
  upstreamPath,
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
  "  pages:",
  "    description: pages",
  "files:",
  "  - {path: .gitignore, class: split, region: hash, blocks: gitignore_sources}",
  "",
].join("\n");

const ENTRIES: [string, string[]][] = [
  ["bun", ["Node.gitignore", "bun.gitignore"]],
  ["uv", ["Python.gitignore"]],
];

/** A files/ tree holding every output the generator writes for ENTRIES,
 *  plus this repository's .gitignore beside it. */
function generated(): { filesDir: string; selfPath: string } {
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
  const selfPath = join(root, ".gitignore");
  writeFileSync(
    selfPath,
    buildSelf(SECTIONS, selfSources(ENTRIES), { above: "# mine\n\n", below: "\n# after\n" }),
  );
  return { filesDir, selfPath };
}

const readSelf = (path: string) => capture(["cat", path], {}).stdout;

describe("the source grammar", () => {
  test("a files.yml name is a github/gitignore root stem, and the block file carries it", () => {
    expect(upstreamPath("Node")).toBe("Node.gitignore");
    expect(blockName("Global/macOS.gitignore")).toBe("macOS");
    expect(blockRel("bun", "Node.gitignore")).toBe("bun/.block.Node.gitignore");
  });

  test("gitignoreSources reads the declaring modules in files.yml order", () => {
    expect(gitignoreSources(FILES_YML)).toEqual(ENTRIES);
  });

  test("a non-list declaration is refused by name", () => {
    expect(() => gitignoreSources(FILES_YML.replace("[Python]", "Python"))).toThrow(
      "modules.uv.gitignore_sources must be a list of names",
    );
  });

  test("selfSources lists every distinct source once, in first-declaration order", () => {
    expect(selfSources([...ENTRIES, ["node", ["Node.gitignore"]]])).toEqual([
      "Node.gitignore",
      "bun.gitignore",
      "Python.gitignore",
    ]);
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

  test("the self output keeps both sides and carries the base body plus every source once", () => {
    const self = buildSelf(SECTIONS, selfSources(ENTRIES), {
      above: "# mine\n",
      below: "# after\n",
    });
    expect(self.startsWith("# mine\n# BEGIN REPO-PLATFORM MANAGED\n")).toBe(true);
    expect(self.endsWith("# END REPO-PLATFORM MANAGED\n# after\n")).toBe(true);
    expect(Object.keys(sectionsIn(self))).toEqual([...ALWAYS, ...selfSources(ENTRIES)]);
  });

  test("sectionsIn reads each section back, blank lines inside a body kept", () => {
    const text = `${buildBlock(SECTIONS["Python.gitignore"])}${SECTIONS["Node.gitignore"]}`;
    expect(sectionsIn(text)).toEqual({
      "Python.gitignore": SECTIONS["Python.gitignore"],
      "Node.gitignore": SECTIONS["Node.gitignore"],
    });
  });

  test("existingLocalSides keeps the sides of a clean file and refuses a malformed region", () => {
    const { selfPath } = generated();
    expect(existingLocalSides(selfPath)).toEqual({ above: "# mine\n\n", below: "\n# after\n" });
    expect(existingLocalSides(join(temp.dir("no-self-"), ".gitignore")).below).toBe("");
    writeFileSync(selfPath, `${readSelf(selfPath)}# BEGIN REPO-PLATFORM MANAGED\n`);
    expect(() => existingLocalSides(selfPath)).toThrow(
      "no single clean REPO-PLATFORM MANAGED region",
    );
  });
});

describe("the offline topology check", () => {
  test("the generator's own outputs pass", () => {
    const { filesDir, selfPath } = generated();
    expect(strayBlockFiles(ENTRIES, filesDir)).toEqual([]);
    expect(missingBlockFiles(ENTRIES, filesDir)).toEqual([]);
    expect(topologyProblems({ entries: ENTRIES, filesDir, selfText: readSelf(selfPath) })).toEqual(
      [],
    );
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
    const { filesDir, selfPath } = generated();
    const selfText = readSelf(selfPath);
    writeFileSync(
      join(filesDir, "bun/.block.bun.gitignore"),
      buildBlock(SECTIONS["Node.gitignore"]),
    );
    writeFileSync(join(filesDir, "uv/.block.Python.gitignore"), SECTIONS["Python.gitignore"]);
    const problems = topologyProblems({ entries: ENTRIES, filesDir, selfText });
    expect(problems.map((p) => p.split(";")[0])).toEqual([
      "files/bun/.block.bun.gitignore encodes [Node.gitignore] but its name stands for bun.gitignore",
      "files/uv/.block.Python.gitignore is not exactly its section plus one blank line",
      "no block file carries [bun.gitignore], so .gitignore cannot be checked against them",
    ]);
    const shared: [string, string[]][] = [...ENTRIES, ["node", ["Node.gitignore"]]];
    writeFileSync(
      join(filesDir, "bun/.block.bun.gitignore"),
      buildBlock(SECTIONS["bun.gitignore"]),
    );
    writeFileSync(
      join(filesDir, "uv/.block.Python.gitignore"),
      buildBlock(SECTIONS["Python.gitignore"]),
    );
    mkdirSync(join(filesDir, "node"));
    writeFileSync(
      join(filesDir, "node/.block.Node.gitignore"),
      buildBlock("## Node (github/gitignore Node.gitignore)\nnode_modules/\ndist/\n"),
    );
    expect(
      topologyProblems({ entries: shared, filesDir, selfText }).map((p) => p.split(";")[0]),
    ).toEqual([
      "files/node/.block.Node.gitignore differs from another module's copy of Node.gitignore",
      ".gitignore's managed region differs from files/base/.gitignore plus the block files",
    ]);
  });

  test("a base and a self region that both dropped an OS section are named, not rebuilt to themselves", () => {
    const { filesDir, selfPath } = generated();
    const without = Object.fromEntries(
      Object.entries(SECTIONS).filter(([path]) => path !== "Global/Windows.gitignore"),
    );
    writeFileSync(join(filesDir, "base/.gitignore"), buildFilesBase(without));
    const selfText = buildSelf(without, selfSources(ENTRIES), { above: "", below: "" });
    expect(
      topologyProblems({ entries: ENTRIES, filesDir, selfText }).map((p) => p.split(";")[0]),
    ).toEqual(["files/base/.gitignore lacks the section(s) [Global/Windows.gitignore]"]);
    // The self copy alone dropping it is named too.
    writeFileSync(join(filesDir, "base/.gitignore"), buildFilesBase(SECTIONS));
    expect(
      topologyProblems({ entries: ENTRIES, filesDir, selfText }).map((p) => p.split(";")[0]),
    ).toEqual([".gitignore's managed region lacks the section(s) [Global/Windows.gitignore]"]);
    // A block file gone: the self comparison cannot run and says so.
    rmSync(join(filesDir, "bun/.block.bun.gitignore"));
    expect(
      topologyProblems({ entries: ENTRIES, filesDir, selfText: readSelf(selfPath) }).map(
        (p) => p.split(";")[0],
      ),
    ).toEqual([
      "no block file carries [bun.gitignore], so .gitignore cannot be checked against them",
    ]);
  });

  test("a stale base, a self region missing a section, and a missing base are named", () => {
    const { filesDir, selfPath } = generated();
    const selfText = readSelf(selfPath);
    writeFileSync(join(filesDir, "base/.gitignore"), `${buildFilesBase(SECTIONS)}extra\n`);
    expect(
      topologyProblems({ entries: ENTRIES, filesDir, selfText }).map((p) => p.split(";")[0]),
    ).toEqual([
      "files/base/.gitignore is not the header, the agent and CI workspace sections, and exactly the OS sections [Global/Windows.gitignore, Global/macOS.gitignore, Global/Linux.gitignore]",
      ".gitignore's managed region differs from files/base/.gitignore plus the block files",
    ]);
    writeFileSync(join(filesDir, "base/.gitignore"), buildFilesBase(SECTIONS));
    const lacking = buildSelf(SECTIONS, ["Node.gitignore"], { above: "", below: "" });
    expect(
      topologyProblems({ entries: ENTRIES, filesDir, selfText: lacking }).map(
        (p) => p.split(";")[0],
      ),
    ).toEqual([
      ".gitignore's managed region lacks the section(s) [bun.gitignore, Python.gitignore]",
    ]);
    expect(
      topologyProblems({ entries: ENTRIES, filesDir: temp.dir("empty-files-"), selfText }),
    ).toEqual([
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
  /** main() with unknown arguments never reaches the fetch, so this stays
   *  offline; the returned message is captured rather than printed. */
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

describe("CI workspace section", () => {
  /** A fresh repository whose .gitignore is exactly the section, holding
   *  one path of the given kind; returns git's ignore verdict for it. */
  function ignoredByGit(rel: string, kind: "dir" | "file"): boolean {
    const repo = temp.dir("gitignore-ci-workspace-");
    expect(capture(["git", "-C", repo, "init", "-q"], {}).exitCode).toBe(0);
    writeFileSync(join(repo, ".gitignore"), CI_WORKSPACE_SECTION);
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

  const cases: [string, "dir" | "file", boolean][] = [
    ["results.sarif", "file", true],
    [".fuzz-failures", "dir", true],
    [".fuzz-failures", "file", false],
    ["assets/logo.png", "file", false],
    ["scan/results.sarif", "file", false],
    ["crate/.fuzz-failures", "dir", false],
  ];

  test.each(cases)("%s (%s) ignored: %p", (rel, kind, ignored) => {
    expect(ignoredByGit(rel, kind)).toBe(ignored);
  });
});
