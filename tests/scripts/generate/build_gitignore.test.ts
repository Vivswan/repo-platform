// Unit tests for build_gitignore's fragment planning: unshared sources are
// emitted plain (today's whole fleet), and a source declared by two modules
// (the future bun+node Node.gitignore share) stays plain in the first
// module's fragment, gets guard-wrapped in the later one, and appears once
// in the self output. The guard tests pin the RENDER contract: a true guard
// yields exactly the unguarded bytes, a false guard yields nothing at all.
// The stray-fragment tests pin the orphan guard: a generated fragment must
// not outlive its module's gitignore_sources declaration.
// The argv tests pin the two-mode shape: the script takes only --topology,
// and the retired pin flags are rejected before any network call - the one
// part of main() that can run offline. The files/ tests pin the writer's
// side: the block files and files/base/.gitignore are derived from the
// same sections as the fragments and the template, and the offline check
// reads them back from those outputs.

import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { capture } from "../../../.github/scripts/shared/proc.ts";
import {
  blockName,
  blockRel,
  buildBlock,
  buildFilesBase,
  buildFragment,
  buildTemplate,
  CI_WORKSPACE_SECTION,
  filesSideProblems,
  fragmentGuardExpressions,
  fragmentPlans,
  fragmentSourcePaths,
  guardExpressionFor,
  main,
  missingFragmentFiles,
  sectionsIn,
  selfSources,
  strayBlockFiles,
  strayFragmentFiles,
  templateRegionBody,
} from "../../../scripts/generate/build_gitignore";
import type { ModuleManifest } from "../../../scripts/lib/module_manifests";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();

const SECTIONS: Record<string, string> = {
  "Node.gitignore": "## Node (github/gitignore Node.gitignore)\nnode_modules/\n",
  "bun.gitignore": "## bun (github/gitignore bun.gitignore)\nbun.lockb.orig\n",
};

const GATES = new Map([
  ["bun", "'bun' in modules"],
  ["node", "'node' in modules"],
]);

const SHARED: [string, string[]][] = [
  ["bun", ["Node.gitignore", "bun.gitignore"]],
  ["node", ["Node.gitignore"]],
];

/** Renders the exact chunk shape buildFragment emits - inline
 *  `{% if G %}<inner>{% endif %}` blocks owning no whitespace of their own -
 *  the way jinja does: a true guard keeps the inner bytes verbatim, a false
 *  guard drops the whole block. */
function render(fragment: string, guardTrue: boolean): string {
  return fragment.replace(/\{% if .+? %\}([\s\S]*?)\{% endif %\}/g, (_, inner: string) =>
    guardTrue ? inner : "",
  );
}

describe("fragmentPlans", () => {
  test("unshared sources carry no guards", () => {
    expect(fragmentPlans([["bun", ["Node.gitignore", "bun.gitignore"]]])).toEqual([
      {
        module: "bun",
        parts: [
          { path: "Node.gitignore", earlier: [] },
          { path: "bun.gitignore", earlier: [] },
        ],
      },
    ]);
  });

  test("a shared source lists its earlier owners only in later modules", () => {
    expect(fragmentPlans(SHARED)).toEqual([
      {
        module: "bun",
        parts: [
          { path: "Node.gitignore", earlier: [] },
          { path: "bun.gitignore", earlier: [] },
        ],
      },
      { module: "node", parts: [{ path: "Node.gitignore", earlier: ["bun"] }] },
    ]);
  });
});

describe("buildFragment", () => {
  const [bunPlan, nodePlan] = fragmentPlans(SHARED);

  test("the first sharing module's fragment is unchanged by the share", () => {
    expect(buildFragment(SECTIONS, bunPlan.parts, GATES)).toBe(
      `\n${SECTIONS["Node.gitignore"]}\n${SECTIONS["bun.gitignore"]}`,
    );
  });

  test("a shared chunk is one exact inline guard block: true renders the unguarded bytes, false nothing", () => {
    // The whole chunk is pinned, not just its opening tag: a stray
    // newline or a lost endif inside the block would survive a prefix check.
    // The guard negates the earlier owner's gate.
    const guarded = buildFragment(SECTIONS, nodePlan.parts, GATES);
    expect(guarded).toBe(
      `{% if not ('bun' in modules) %}\n${SECTIONS["Node.gitignore"]}{% endif %}`,
    );
    const unguarded = buildFragment(SECTIONS, [{ path: "Node.gitignore", earlier: [] }], GATES);
    expect(render(guarded, true)).toBe(unguarded);
    expect(render(guarded, false)).toBe("");
    // The guard reads the owner's gate expression from the map, not a
    // spelling of its own.
    const custom = new Map([...GATES, ["bun", "'bun' in modules or legacy"]]);
    expect(buildFragment(SECTIONS, nodePlan.parts, custom)).toBe(
      `{% if not ('bun' in modules or legacy) %}\n${SECTIONS["Node.gitignore"]}{% endif %}`,
    );
  });

  test("a missing gate expression fails loudly", () => {
    expect(() => buildFragment(SECTIONS, nodePlan.parts, new Map())).toThrow("bun");
  });
});

describe("selfSources", () => {
  test("a shared source appears once in the self output's section list", () => {
    expect(selfSources(SHARED)).toEqual(["Node.gitignore", "bun.gitignore"]);
  });
});

describe("strayFragmentFiles", () => {
  const templates = temp.dir("gitignore-strays-");
  beforeAll(() => {
    for (const module of ["bun", "uv"]) {
      mkdirSync(join(templates, module, "fragments"), { recursive: true });
      writeFileSync(join(templates, module, "fragments", "gitignore.jinja"), "\n## stale\n");
    }
    mkdirSync(join(templates, "agents"), { recursive: true });
  });

  const manifest = (module: string, gitignore_sources?: string[]): ModuleManifest => ({
    module,
    description: `the ${module} module`,
    ...(gitignore_sources ? { gitignore_sources } : {}),
  });

  test("declaring modules and fragment-less modules pass", () => {
    expect(
      strayFragmentFiles(
        [
          manifest("bun", ["Node.gitignore"]),
          manifest("uv", ["Python.gitignore"]),
          manifest("agents"),
        ],
        templates,
      ),
    ).toEqual([]);
  });

  test("a fragment outliving its module's gitignore_sources key is flagged", () => {
    expect(
      strayFragmentFiles([manifest("bun", ["Node.gitignore"]), manifest("uv")], templates),
    ).toEqual(["templates/uv/fragments/gitignore.jinja"]);
  });
});

describe("argument parsing", () => {
  /** main() with arguments never reaches the fetch, so this stays offline;
   *  the returned message is captured rather than printed. */
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
    { argv: ["--locked"], reason: "the retired --locked pin mode" },
    { argv: ["--check"], reason: "the retired --check pin mode" },
    { argv: ["--dry-run", "x"], reason: "any other argument, several at once" },
  ])("$reason is rejected naming the argument(s), not silently ignored", async ({ argv }) => {
    const { code, message } = await reject(argv);
    expect(code).toBe(2);
    expect(message).toContain(argv.join(" "));
  });
});

describe("missingFragmentFiles", () => {
  // The topology check's second direction: a module NEWLY declaring
  // gitignore_sources has no fragment until the generator runs, and
  // composition would render nothing for it. Historically the refresh
  // workflow's `git diff --quiet` could not see this either, because the new
  // fragment was untracked; the topology check is what closed that.
  const templates = temp.dir("gitignore-missing-");
  beforeAll(() => {
    mkdirSync(join(templates, "bun", "fragments"), { recursive: true });
    writeFileSync(join(templates, "bun", "fragments", "gitignore.jinja"), "\n## bun\n");
    mkdirSync(join(templates, "deno"), { recursive: true });
  });

  const manifest = (module: string, gitignore_sources?: string[]): ModuleManifest => ({
    module,
    description: `the ${module} module`,
    ...(gitignore_sources ? { gitignore_sources } : {}),
  });

  test("present fragments and undeclaring modules pass", () => {
    expect(
      missingFragmentFiles([manifest("bun", ["Node.gitignore"]), manifest("deno")], templates),
    ).toEqual([]);
  });

  test("a declared gitignore_sources without its fragment is flagged", () => {
    expect(
      missingFragmentFiles(
        [manifest("bun", ["Node.gitignore"]), manifest("deno", ["Deno.gitignore"])],
        templates,
      ),
    ).toEqual(["templates/deno/fragments/gitignore.jinja"]);
  });
});

describe("fragment guard expressions match the manifests", () => {
  // The topology check's fourth direction: shared-source chunks embed the
  // EARLIER owners' gate expressions as jinja guards, so a changed module
  // gate leaves a stale fragment whose next build emits duplicate shared
  // sections. Expected and actual guards come from ONE constructor
  // (guardExpressionFor), so a generated fragment always matches.
  const sections = {
    "Node.gitignore": "## Node (github/gitignore Node.gitignore)\nnode_modules/\n",
  };
  const parts = [{ path: "Node.gitignore", earlier: ["bun"] }];

  test("a regenerated fragment's guards match the manifests' expectation", () => {
    const gates = new Map([["bun", '"bun" in modules']]);
    const fragment = buildFragment(sections, parts, gates);
    expect(fragmentGuardExpressions(fragment)).toEqual([guardExpressionFor(["bun"], gates)]);
  });

  test("a changed module gate makes the stale fragment's guards mismatch", () => {
    // Both sides pinned positively: the mismatch is a consequence of two
    // exact values, so a broken extractor (returning [] or garbage) cannot
    // pass as "the gate changed".
    const oldGates = new Map([["bun", '"bun" in modules']]);
    const staleFragment = buildFragment(sections, parts, oldGates);
    const newGates = new Map([["bun", '"bun" in modules or "node" in modules']]);
    expect(fragmentGuardExpressions(staleFragment)).toEqual(['not ("bun" in modules)']);
    expect(guardExpressionFor(["bun"], newGates)).toBe(
      'not ("bun" in modules or "node" in modules)',
    );
  });

  test("an unguarded fragment expects no guards", () => {
    const gates = new Map([["bun", '"bun" in modules']]);
    const fragment = buildFragment(sections, [{ path: "Node.gitignore", earlier: [] }], gates);
    expect(fragmentGuardExpressions(fragment)).toEqual([]);
  });
});

describe("fragmentSourcePaths", () => {
  // The topology check's third direction: an EDITED gitignore_sources
  // list (source added, removed, replaced, or reordered) must not pass on
  // fragment presence alone - the fragment's own section headings encode
  // its sources, offline.
  test("reads the encoded sources in order, guarded chunks included", () => {
    const fragment =
      "\n## Node (github/gitignore Node.gitignore)\nnode_modules/\n" +
      '{% if not ("bun" in modules) %}\n## Python (github/gitignore Python.gitignore)\n__pycache__/\n{% endif %}';
    expect(fragmentSourcePaths(fragment)).toEqual(["Node.gitignore", "Python.gitignore"]);
  });

  test("community subdirectory paths round-trip whole", () => {
    const fragment = "\n## Nix (github/gitignore community/Nix.gitignore)\nresult\n";
    expect(fragmentSourcePaths(fragment)).toEqual(["community/Nix.gitignore"]);
  });

  test("a heading-free fragment reads as no sources (mismatch, not a crash)", () => {
    expect(fragmentSourcePaths("# not a generated fragment\n")).toEqual([]);
  });
});

describe("the files/ side", () => {
  const sections: Record<string, string> = {
    ...SECTIONS,
    "Global/macOS.gitignore": "## macOS (github/gitignore Global/macOS.gitignore)\n.DS_Store\n",
    "Global/Windows.gitignore":
      "## Windows (github/gitignore Global/Windows.gitignore)\nThumbs.db\n",
    "Global/Linux.gitignore": "## Linux (github/gitignore Global/Linux.gitignore)\n*~\n",
    "Python.gitignore":
      "## Python (github/gitignore Python.gitignore)\n__pycache__/\n\n*.py[cod]\n",
  };
  const entries: [string, string[]][] = [
    ["bun", ["Node.gitignore", "bun.gitignore"]],
    ["uv", ["Python.gitignore"]],
  ];
  const filesModules = {
    bun: { gitignore_sources: ["Node", "bun"] },
    uv: { gitignore_sources: ["Python"] },
    pages: {},
  };
  const [bunPlan, uvPlan] = fragmentPlans(entries);
  const fragments = new Map([
    ["bun", buildFragment(sections, bunPlan.parts, GATES)],
    ["uv", buildFragment(sections, uvPlan.parts, GATES)],
  ]);
  const templateText = buildTemplate(sections);

  test("blockName is the source file's stem, subdirectory dropped", () => {
    expect(blockName("Node.gitignore")).toBe("Node");
    expect(blockName("Global/macOS.gitignore")).toBe("macOS");
    expect(blockRel("bun", "Node.gitignore")).toBe("bun/.gitignore.block.Node");
  });

  test("files/base/.gitignore is exactly the template's region body", () => {
    expect(templateRegionBody(templateText)).toBe(buildFilesBase(sections));
    expect(buildFilesBase(sections).startsWith("# Generated from github/gitignore")).toBe(true);
    expect(buildFilesBase(sections).endsWith(`${sections["Global/Linux.gitignore"]}\n`)).toBe(true);
    expect(() => templateRegionBody("# no markers\n")).toThrow("compose anchor");
  });

  test("sectionsIn reads each section back from a fragment, guards removed and blank lines inside a body kept", () => {
    const shared = buildFragment(
      sections,
      [
        { path: "Node.gitignore", earlier: ["bun"] },
        { path: "Python.gitignore", earlier: [] },
      ],
      GATES,
    );
    expect(sectionsIn(shared)).toEqual({
      "Node.gitignore": sections["Node.gitignore"],
      "Python.gitignore": sections["Python.gitignore"],
    });
    expect(sectionsIn("# not a fragment\n")).toEqual({});
  });

  test("a block file is the section plus the blank line the composed fragment carried", () => {
    expect(buildBlock(sections["bun.gitignore"])).toBe(`${sections["bun.gitignore"]}\n`);
  });

  /** A files/ tree holding exactly the outputs the generator would write. */
  function generatedTree(): string {
    const dir = temp.dir("gitignore-files-");
    mkdirSync(join(dir, "base"), { recursive: true });
    writeFileSync(join(dir, "base", ".gitignore"), buildFilesBase(sections));
    for (const [module, paths] of entries) {
      mkdirSync(join(dir, module), { recursive: true });
      for (const path of paths) {
        writeFileSync(join(dir, blockRel(module, path)), buildBlock(sections[path]));
      }
    }
    mkdirSync(join(dir, "pages"));
    return dir;
  }

  const problems = (
    filesDir: string,
    overrides: Partial<Parameters<typeof filesSideProblems>[0]> = {},
  ) =>
    filesSideProblems({
      entries,
      filesModules,
      templateText,
      fragmentText: (module) => fragments.get(module) ?? "",
      filesDir,
      ...overrides,
    });

  test("the generator's own outputs pass, shared sources landing once per module", () => {
    expect(problems(generatedTree())).toEqual([]);
    expect(strayBlockFiles(entries, generatedTree())).toEqual([]);
  });

  test("a block file that differs from its fragment's section is stale", () => {
    const dir = generatedTree();
    writeFileSync(
      join(dir, "uv", ".gitignore.block.Python"),
      "## Python (github/gitignore Python.gitignore)\nold\n\n",
    );
    const found = problems(dir);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain(
      "files/uv/.gitignore.block.Python differs from its section in templates/uv/fragments/gitignore.jinja",
    );
  });

  test("a missing block file and a stale base are named", () => {
    const dir = generatedTree();
    rmSync(join(dir, "bun", ".gitignore.block.bun"));
    writeFileSync(join(dir, "base", ".gitignore"), "# old\n");
    expect(problems(dir).map((problem) => problem.split(";")[0])).toEqual([
      "files/base/.gitignore differs from templates/base/.gitignore.jinja's region body",
      "files/bun/.gitignore.block.bun is missing (its section in templates/bun/fragments/gitignore.jinja)",
    ]);
  });

  test("files.yml must name the manifests' sources as block names, module for module", () => {
    const dir = generatedTree();
    expect(
      problems(dir, {
        filesModules: { ...filesModules, uv: { gitignore_sources: ["Python", "uv"] } },
      })[0],
    ).toContain(
      'files.yml modules.uv.gitignore_sources is ["Python","uv"] but templates/uv/module.yml declares ["Python"]',
    );
    expect(
      problems(dir, {
        filesModules: { ...filesModules, pages: { gitignore_sources: ["Node"] } },
      })[0],
    ).toContain(
      'files.yml modules.pages.gitignore_sources is ["Node"] but templates/pages/module.yml declares undefined',
    );
    const { uv: _, ...withoutUv } = filesModules;
    expect(problems(dir, { filesModules: withoutUv })).toEqual([
      "files.yml has no modules.uv entry for a module declaring gitignore_sources",
    ]);
  });

  test("a block file no manifest source names is a stray; base is never scanned", () => {
    const dir = generatedTree();
    writeFileSync(join(dir, "uv", ".gitignore.block.Node"), "## Node\n");
    writeFileSync(join(dir, "base", ".gitignore.block.Node"), "## Node\n");
    expect(strayBlockFiles(entries, dir)).toEqual(["files/uv/.gitignore.block.Node"]);
  });
});

// The CI workspace section judged by git itself: every path a fleet
// workflow step creates inside the checked-out workspace is ignored at the
// root, a plain file of a directory pattern's name is not, a nested source
// folder of the same name is never swallowed, and a legitimate root folder
// no checked-out step creates (assets/) stays visible.
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
