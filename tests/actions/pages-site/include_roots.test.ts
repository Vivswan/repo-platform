import { describe, expect, test } from "bun:test";
import {
  deriveRewrites,
  includeIndexPages,
  pageMeta,
  routeOf,
} from "../../../actions/pages-site/.vitepress/derive.ts";
import { isLandingFile, sourcePathOf } from "../../../actions/pages-site/.vitepress/source-path.ts";
import { parseSiteConfig } from "../../../actions/pages-site/lib.ts";

const SKILLS = { path: "skills", mount: "skills", page: "SKILL.md" };

const config = (include: unknown) =>
  JSON.stringify({
    site_title: "Site",
    docs_path: "docs",
    include,
    link_rot_label: "",
    link_rot_color: "",
    link_rot_description: "",
  });

describe("parseSiteConfig include roots", () => {
  // VitePress refuses none of these and builds the wrong site without a word, so the plan-time refusal is the only
  // signal: public/ is copied as static files, a locale-shaped mount is read as a translation tree, a dot-prefixed
  // segment is never walked, and index.md is already the directory's page.
  test.each([
    ["not a list", { path: "skills" }, "must be a list of {path, mount, page}"],
    ["an unknown key", [{ ...SKILLS, title: "x" }], "unknown keys: title"],
    ["a traversing path", [{ ...SKILLS, path: "../skills" }], "plain relative path"],
    ["a locale-shaped mount", [{ ...SKILLS, mount: "de" }], "reads as a locale directory"],
    ["a dot-prefixed mount", [{ ...SKILLS, mount: ".skills" }], "lowercase URL segments"],
    ["a public mount", [{ ...SKILLS, mount: "public/skills" }], "starts with public/"],
    [
      "a node_modules segment in the mount",
      [{ ...SKILLS, mount: "content/node_modules" }],
      "never walks",
    ],
    [
      "a page with a directory in it",
      [{ ...SKILLS, page: "x/SKILL.md" }],
      "plain markdown file name",
    ],
    ["index.md as the page", [{ ...SKILLS, page: "index.md" }], "is index.md"],
    ["a dot-prefixed page", [{ ...SKILLS, page: ".page.md" }], "never walks"],
    [
      "two roots on one mount",
      [SKILLS, { path: "agents", mount: "skills", page: "AGENT.md" }],
      "lists one mount twice",
    ],
  ])("refuses an include list %s", (_, include, message) => {
    expect(() => parseSiteConfig(config(include))).toThrow(message);
  });
});

describe("include root routes", () => {
  const files = [
    "README.md",
    "skills/README.md",
    "skills/alpha/SKILL.md",
    "skills/alpha/reference.md",
    "skills/beta/README.md",
    "skills/beta/SKILL.md",
    "skills/gamma/SKILL.md",
    "skills/gamma/index.md",
    "skills/deep/nested/SKILL.md",
    "other/SKILL.md",
  ];
  const NESTED = [
    { path: "manuals", mount: "manuals", page: "README.md" },
    { path: "tools/agents", mount: "manuals/agents", page: "AGENT.md" },
  ];
  const NESTED_TREE = [
    "manuals/README.md",
    "manuals/topic/README.md",
    "manuals/topic/detail.md",
    "manuals/agents/README.md",
    "manuals/agents/AGENT.md",
    "manuals/agents/x/AGENT.md",
    "manuals/agents/x/README.md",
  ];

  // The longest mount owns a file (owningRoot, shared with the plan): a nested root's own files are never
  // the parent's child pages, and a page file is never a landing whatever it is named.
  test("includeIndexPages lists exactly the child directories' page files under the owning root; landings stay README.md and index.md", () => {
    expect(includeIndexPages(files, [SKILLS])).toEqual([
      "skills/alpha/SKILL.md",
      "skills/beta/SKILL.md",
      "skills/gamma/SKILL.md",
    ]);
    expect(includeIndexPages(files, [])).toEqual([]);
    const nestedPages = includeIndexPages(NESTED_TREE, NESTED);
    expect(nestedPages).toEqual(["manuals/topic/README.md", "manuals/agents/x/AGENT.md"]);
    const tree = ["README.md", "guide/index.md", "search-index.md", ...NESTED_TREE];
    expect(tree.filter((file) => isLandingFile(file, new Set(nestedPages)))).toEqual([
      "README.md",
      "guide/index.md",
      "manuals/README.md",
      "manuals/agents/README.md",
      "manuals/agents/x/README.md",
    ]);
  });

  // VitePress's rewrites map accepts two files on one route and overwrites one page silently; the
  // precedence (index.md over the page file, the page file over a README) keeps them apart.
  test("the page serves at the directory URL; a README beside it keeps its own route; an index.md beside it wins", () => {
    const rewrites = deriveRewrites(files, includeIndexPages(files, [SKILLS]));
    expect(rewrites).toEqual({
      "README.md": "index.md",
      "skills/README.md": "skills/index.md",
      "skills/alpha/SKILL.md": "skills/alpha/index.md",
      "skills/beta/SKILL.md": "skills/beta/index.md",
    });
    expect(routeOf("skills/alpha/SKILL.md", rewrites)).toBe("/skills/alpha/");
    expect(routeOf("skills/alpha/reference.md", rewrites)).toBe("/skills/alpha/reference");
    expect(routeOf("skills/beta/README.md", rewrites)).toBe("/skills/beta/README");
    expect(routeOf("skills/gamma/SKILL.md", rewrites)).toBe("/skills/gamma/SKILL");
    expect(routeOf("skills/gamma/index.md", rewrites)).toBe("/skills/gamma/");
    expect(deriveRewrites(files)).toEqual({
      "README.md": "index.md",
      "skills/README.md": "skills/index.md",
      "skills/beta/README.md": "skills/beta/index.md",
    });
  });

  // The sidebar row (pageMeta) and the document title (config.mts transformPageData) share the
  // fallback; a page file with a `name` key and no heading is titled by the name, blank falling to the file.
  test.each<[string, string, string, string]>([
    [
      "a name key and no heading",
      "skills/beta/SKILL.md",
      "---\nname: beta\ndescription: Beta.\n---\n\nBody.\n",
      "beta",
    ],
    [
      "an h1 over a name key",
      "skills/alpha/SKILL.md",
      "---\nname: alpha\n---\n\n# Alpha skill\n\nBody.\n",
      "Alpha skill",
    ],
    ["an empty name", "skills/x/SKILL.md", "---\nname: ''\n---\n\nBody.\n", "SKILL"],
    ["a blank name", "skills/x/SKILL.md", "---\nname: '   '\n---\n\nBody.\n", "SKILL"],
    ["a padded name", "skills/x/SKILL.md", "---\nname: '  beta  '\n---\n\nBody.\n", "beta"],
    ["a non-string name", "skills/x/SKILL.md", "---\nname: 3\n---\n\nBody.\n", "SKILL"],
    [
      "no frontmatter and a delimited file name",
      "guide/getting_started-now.md",
      "Body.\n",
      "getting started now",
    ],
  ])("titles a page with %s", (_, file, source, title) => {
    expect(pageMeta(file, source)).toEqual({ title, order: null, group: null });
  });
});

describe("source paths", () => {
  // config.mts routes the edit link and the provenance line through it; a shorter mount winning sends both to the wrong file.
  test("a staged path resolves to its root's repository path, the longest mount winning", () => {
    const includes = [SKILLS, { path: "tools/agents", mount: "skills/agents", page: "AGENT.md" }];
    expect(sourcePathOf("docs", includes, "guide/README.md")).toBe("docs/guide/README.md");
    expect(sourcePathOf("docs", includes, "skills/alpha/SKILL.md")).toBe("skills/alpha/SKILL.md");
    expect(sourcePathOf("docs", includes, "skills/agents/x/AGENT.md")).toBe(
      "tools/agents/x/AGENT.md",
    );
    expect(sourcePathOf("site/manual", [], "skillset.md")).toBe("site/manual/skillset.md");
  });
});
