import { describe, expect, test } from "bun:test";
import {
  deriveRewrites,
  includeIndexPages,
  pageMeta,
  routeOf,
  untitledPageTitle,
} from "../../../actions/pages-site/.vitepress/derive.ts";
import { isLandingFile, sourcePathOf } from "../../../actions/pages-site/.vitepress/source-path.ts";
import { parseSiteConfig } from "../../../actions/pages-site/lib.ts";

const SKILLS = { path: "skills", mount: "skills", page: "SKILL.md" };

/** A config whose include list is `include`, the other keys neutral. */
const config = (include: unknown) =>
  JSON.stringify({ site_title: "", docs_path: "docs", include, link_rot_label: "" });

describe("parseSiteConfig include roots", () => {
  test("the include list is carried as written", () => {
    expect(parseSiteConfig(config([SKILLS])).include).toEqual([SKILLS]);
    expect(parseSiteConfig(config([])).include).toEqual([]);
  });

  test.each([
    ["not a list", { path: "skills" }, "must be a list of {path, mount, page}"],
    ["an unknown key", [{ ...SKILLS, title: "x" }], "unknown keys: title"],
    ["a traversing path", [{ ...SKILLS, path: "../skills" }], "plain relative path"],
    ["a locale-shaped mount", [{ ...SKILLS, mount: "de" }], "reads as a locale directory"],
    ["a dot-prefixed mount", [{ ...SKILLS, mount: ".skills" }], "never walks"],
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

  test("includeIndexPages lists exactly the child directories' page files", () => {
    expect(includeIndexPages(files, [SKILLS])).toEqual([
      "skills/alpha/SKILL.md",
      "skills/beta/SKILL.md",
      "skills/gamma/SKILL.md",
    ]);
    expect(includeIndexPages(files, [])).toEqual([]);
  });

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
    // Without the include the same tree rewrites READMEs alone.
    expect(deriveRewrites(files)).toEqual({
      "README.md": "index.md",
      "skills/README.md": "skills/index.md",
      "skills/beta/README.md": "skills/beta/index.md",
    });
  });

  test("a page with neither a title key nor an h1 is titled by its name key", () => {
    expect(
      pageMeta("skills/beta/SKILL.md", "---\nname: beta\ndescription: Beta.\n---\n\nBody.\n"),
    ).toEqual({
      title: "beta",
      order: null,
      group: null,
    });
    expect(
      pageMeta("skills/alpha/SKILL.md", "---\nname: alpha\n---\n\n# Alpha skill\n\nBody.\n"),
    ).toEqual({ title: "Alpha skill", order: null, group: null });
    expect(pageMeta("skills/x/SKILL.md", "---\nname: ''\n---\n\nBody.\n")).toEqual({
      title: "SKILL",
      order: null,
      group: null,
    });
  });

  test("untitledPageTitle, which the document title shares with the sidebar row: a non-blank name trimmed, else the file name humanized", () => {
    expect(untitledPageTitle("skills/beta/SKILL.md", "beta")).toBe("beta");
    expect(untitledPageTitle("skills/beta/SKILL.md", "  beta  ")).toBe("beta");
    expect(untitledPageTitle("skills/beta/SKILL.md", "")).toBe("SKILL");
    expect(untitledPageTitle("skills/beta/SKILL.md", "   ")).toBe("SKILL");
    expect(untitledPageTitle("skills/beta/SKILL.md", undefined)).toBe("SKILL");
    expect(untitledPageTitle("skills/beta/SKILL.md", 3)).toBe("SKILL");
    expect(untitledPageTitle("guide/getting_started-now.md", undefined)).toBe(
      "getting started now",
    );
  });
});

describe("source paths", () => {
  test("a staged path resolves to its root's repository path, the longest mount winning", () => {
    const includes = [SKILLS, { path: "tools/agents", mount: "skills/agents", page: "AGENT.md" }];
    expect(sourcePathOf("docs", includes, "guide/README.md")).toBe("docs/guide/README.md");
    expect(sourcePathOf("docs", includes, "skills/alpha/SKILL.md")).toBe("skills/alpha/SKILL.md");
    expect(sourcePathOf("docs", includes, "skills/agents/x/AGENT.md")).toBe(
      "tools/agents/x/AGENT.md",
    );
    expect(sourcePathOf("site/manual", [], "skillset.md")).toBe("site/manual/skillset.md");
  });

  test("landing files are README.md and index.md sources alone", () => {
    expect(isLandingFile("README.md")).toBe(true);
    expect(isLandingFile("guide/index.md")).toBe(true);
    expect(isLandingFile("skills/alpha/SKILL.md")).toBe(false);
    expect(isLandingFile("search-index.md")).toBe(false);
  });
});
