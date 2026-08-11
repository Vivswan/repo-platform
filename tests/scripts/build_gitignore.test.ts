// Unit tests for build_gitignore's fragment planning: unshared sources are
// emitted plain (today's whole fleet), and a source declared by two modules
// (the future bun+node Node.gitignore share) stays plain in the first
// module's fragment, gets guard-wrapped in the later one, and appears once
// in the self output. The guard tests pin the RENDER contract: a true guard
// yields exactly the unguarded bytes, a false guard yields nothing at all.

import { describe, expect, test } from "bun:test";
import { buildFragment, fragmentPlans, selfSources } from "../../scripts/build_gitignore";

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

  test("the guard negates the earlier owner's actual gate expression", () => {
    expect(buildFragment(SECTIONS, nodePlan.parts, GATES)).toStartWith(
      "{% if not ('bun' in modules) %}",
    );
    const custom = new Map([...GATES, ["bun", "'bun' in modules or legacy"]]);
    expect(buildFragment(SECTIONS, nodePlan.parts, custom)).toStartWith(
      "{% if not ('bun' in modules or legacy) %}",
    );
  });

  test("a true guard renders byte-identically to the unguarded fragment", () => {
    const guarded = buildFragment(SECTIONS, nodePlan.parts, GATES);
    const unguarded = buildFragment(SECTIONS, [{ path: "Node.gitignore", earlier: [] }], GATES);
    expect(render(guarded, true)).toBe(unguarded);
  });

  test("a false guard renders to nothing - zero bytes, not blank lines", () => {
    const guarded = buildFragment(SECTIONS, nodePlan.parts, GATES);
    expect(render(guarded, false)).toBe("");
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
