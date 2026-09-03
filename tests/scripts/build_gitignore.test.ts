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
// part of main() that can run offline.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildFragment,
  fragmentGuardExpressions,
  fragmentPlans,
  fragmentSourcePaths,
  guardExpressionFor,
  main,
  missingFragmentFiles,
  selfSources,
  strayFragmentFiles,
} from "../../scripts/build_gitignore";
import type { ModuleManifest } from "../../scripts/module_manifests";

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

  test("a shared chunk is one inline guard block negating the earlier owner's actual gate: exact bytes, a true guard renders the unguarded bytes, a false guard renders nothing", () => {
    // The whole chunk is pinned, not just its opening tag: a stray
    // newline or a lost endif inside the block would survive a prefix check.
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
  const templates = mkdtempSync(join(tmpdir(), "gitignore-strays-"));
  beforeAll(() => {
    for (const module of ["bun", "uv"]) {
      mkdirSync(join(templates, module, "fragments"), { recursive: true });
      writeFileSync(join(templates, module, "fragments", "gitignore.jinja"), "\n## stale\n");
    }
    mkdirSync(join(templates, "agents"), { recursive: true });
  });
  afterAll(() => rmSync(templates, { recursive: true, force: true }));

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

  test.each([
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
  const templates = mkdtempSync(join(tmpdir(), "gitignore-missing-"));
  beforeAll(() => {
    mkdirSync(join(templates, "bun", "fragments"), { recursive: true });
    writeFileSync(join(templates, "bun", "fragments", "gitignore.jinja"), "\n## bun\n");
    mkdirSync(join(templates, "deno"), { recursive: true });
  });
  afterAll(() => rmSync(templates, { recursive: true, force: true }));

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
