import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import {
  alertTitlesRule,
  CUSTOM_BLOCK_LABELS,
} from "../../../actions/pages-site/.vitepress/custom-blocks.ts";
import { inlineTextRule } from "../../../actions/pages-site/.vitepress/inline-text.ts";
import {
  isLandingPath,
  landingTableRule,
  launcherTag,
} from "../../../actions/pages-site/.vitepress/landing-table.ts";
import type { CuratedRow } from "../../../actions/pages-site/.vitepress/theme/launcher-model.ts";
import {
  type HeadersEnv,
  headersRule,
  renderedHeaders,
} from "../../../actions/pages-site/.vitepress/theme/page-index.ts";

type Md = Parameters<typeof landingTableRule>[0];

// markdown-it is the action's dependency, hoisted under its node_modules;
// tests/ resolves from the repo root, which has no copy.
const ACTION_DIR = resolve(import.meta.dir, "../../../actions/pages-site");
const MarkdownIt = createRequire(join(ACTION_DIR, "package.json"))("markdown-it") as new (options: {
  html: boolean;
}) => Md;

/** A docs tree indexed by READMEs at the root and in ja/, with a guide/
 *  directory that carries both spellings (its README keeps its own route). */
const REWRITES = { "README.md": "index.md", "ja/README.md": "ja/index.md" };

function renderers(): { plain: Md; withRule: Md } {
  const plain = new MarkdownIt({ html: true });
  const withRule = new MarkdownIt({ html: true });
  inlineTextRule(withRule);
  landingTableRule(withRule, REWRITES);
  return { plain, withRule };
}

const LANDING = { relativePath: "index.md" };

const GOAL_READ = [
  "## I want to...",
  "",
  "| Goal | Read |",
  "|---|---|",
  "| Create a new managed repository | [New repo](new-repo.md) |",
  "| Understand the `pr-title` required check | [Settings: the pr-title ruleset](settings.md#the-pr-title-ruleset) |",
  "",
  "after",
  "",
].join("\n");

const GOAL_READ_ROWS: CuratedRow[] = [
  { label: "Create a new managed repository", href: "new-repo.md", note: null },
  {
    label: "Understand the pr-title required check",
    href: "settings.md#the-pr-title-ruleset",
    note: null,
  },
];

describe("isLandingPath", () => {
  const cases: [string, boolean][] = [
    ["index.md", true],
    ["README.md", true],
    ["ja/index.md", true],
    ["ja/README.md", true],
    ["guide.md", false],
    ["guide/index.md", false],
    ["guide/README.md", false],
    ["api/index.md", false],
    ["ja/guide.md", false],
  ];
  test.each(cases)("%s under the fixture rewrites is landing: %p", (path, landing) => {
    expect(isLandingPath(path, REWRITES)).toBe(landing);
  });

  test("a README beside a real index.md serves its own route and is no landing", () => {
    expect(isLandingPath("README.md", {})).toBe(false);
    expect(isLandingPath("index.md", {})).toBe(true);
  });
});

describe("landingTableRule", () => {
  test("replaces the landing page's link-column table with the launcher tag", () => {
    const { withRule } = renderers();
    expect(withRule.render(GOAL_READ, { ...LANDING })).toBe(
      `<h2>I want to...</h2>\n${launcherTag(GOAL_READ_ROWS)}<p>after</p>\n`,
    );
  });

  test("the source README.md spelling renders the same launcher as the rewritten index.md", () => {
    const { withRule } = renderers();
    expect(withRule.render(GOAL_READ, { relativePath: "README.md" })).toBe(
      withRule.render(GOAL_READ, { ...LANDING }),
    );
  });

  test("refuses a renderer without the inline-text stamp", () => {
    const md = new MarkdownIt({ html: true });
    landingTableRule(md, REWRITES);
    expect(() => md.render(GOAL_READ, { ...LANDING })).toThrow("inlineTextRule is not installed");
  });

  test("escapes the rows JSON as an HTML attribute", () => {
    const { withRule } = renderers();
    const src = '| Goal | Read |\n|---|---|\n| Say "hi" & <b>bye</b> | [Page](p.md) |\n';
    expect(withRule.render(src, { ...LANDING })).toBe(
      '<FleetLauncher rows="[{&quot;label&quot;:&quot;Say \\&quot;hi\\&quot; &amp; bye&quot;,' +
        '&quot;href&quot;:&quot;p.md&quot;,&quot;note&quot;:null}]"></FleetLauncher>\n',
    );
  });

  const untouched: [string, string, Record<string, string>][] = [
    [
      "a table without a link column",
      "| Flag | Meaning |\n|---|---|\n| `-v` | verbose |\n| `-q` | quiet, see [docs](d.md) now |\n",
      LANDING,
    ],
    [
      "a column where one cell carries text beside its link",
      "| Goal | Read |\n|---|---|\n| A | [x](x.md) |\n| B | [y](y.md) and more |\n",
      LANDING,
    ],
    ["a landing table on a non-landing page", GOAL_READ, { relativePath: "guide.md" }],
    ["a landing table on a subdirectory index", GOAL_READ, { relativePath: "guide/index.md" }],
    [
      "a landing table on a README that keeps its own route beside an index.md",
      GOAL_READ,
      { relativePath: "guide/README.md" },
    ],
    [
      "a landing table on a non-locale top-level index",
      GOAL_READ,
      { relativePath: "api/index.md" },
    ],
    ["a landing table rendered without a relativePath", GOAL_READ, {}],
    ["a table with only a header row", "| Goal | Read |\n|---|---|\n", LANDING],
    ["a link table quoted", "> | Read |\n> |---|\n> | [x](x.md) |\n", LANDING],
    [
      "a link table inside a list item",
      "- item\n\n  | Read |\n  |---|\n  | [x](x.md) |\n",
      LANDING,
    ],
  ];
  test.each(untouched)("leaves %s as markdown-it renders it", (_name, src, env) => {
    const { plain, withRule } = renderers();
    expect(withRule.render(src, { ...env })).toBe(plain.render(src));
  });

  test("fires on a locale landing page and only on the first qualifying table", () => {
    const { plain, withRule } = renderers();
    const flags = "| Flag | Meaning |\n|---|---|\n| `-v` | verbose |\n";
    const second = "| Goal | Read |\n|---|---|\n| B | [y](y.md) |\n";
    const src = `${flags}\n${GOAL_READ}\n${second}`;
    expect(withRule.render(src, { relativePath: "ja/index.md" })).toBe(
      `${plain.render(flags)}<h2>I want to...</h2>\n${launcherTag(GOAL_READ_ROWS)}<p>after</p>\n${plain.render(second)}`,
    );
  });

  test("a nested link table above the goal table is skipped, and the goal table fires", () => {
    const { plain, withRule } = renderers();
    const nested = "- See also\n\n  | Read |\n  |---|\n  | [Aside](aside.md) |\n";
    expect(withRule.render(`${nested}\n${GOAL_READ}`, { ...LANDING })).toBe(
      `${plain.render(nested)}<h2>I want to...</h2>\n${launcherTag(GOAL_READ_ROWS)}<p>after</p>\n`,
    );
  });

  const shapes: [string, string, CuratedRow[]][] = [
    [
      "a three-column table yields notes from the cell after the label",
      "| Goal | Read | Note |\n|---|---|---|\n| Publish | [Pages](pages.md) | Modules |\n| Eject | [Eject](eject.md) | |\n",
      [
        { label: "Publish", href: "pages.md", note: "Modules" },
        { label: "Eject", href: "eject.md", note: null },
      ],
    ],
    [
      "a link-first table (doc map: link, contents, audience) labels by contents",
      "| Document | Contents | Audience |\n|---|---|---|\n| [ARCHITECTURE.md](ARCHITECTURE.md) | How the bridge is put together | Contributors |\n| [PROTOCOL.md](PROTOCOL.md) | The wire format, `frame` by frame | Integrators |\n",
      [
        {
          label: "How the bridge is put together",
          href: "ARCHITECTURE.md",
          note: "Contributors",
        },
        { label: "The wire format, frame by frame", href: "PROTOCOL.md", note: "Integrators" },
      ],
    ],
    [
      "a single-column table labels rows by their link text",
      "| Read |\n|---|\n| [New repo](new-repo.md) |\n| [`config.mts`](config.md) |\n",
      [
        { label: "New repo", href: "new-repo.md", note: null },
        { label: "config.mts", href: "config.md", note: null },
      ],
    ],
    [
      "an image inside a link labels by its alt text",
      "| Read |\n|---|\n| [![Guide](guide.svg)](guide.md) |\n",
      [{ label: "Guide", href: "guide.md", note: null }],
    ],
    [
      "emphasis is dropped from labels and runs of spaces collapse",
      "| Goal | Read |\n|---|---|\n| **Ship** a *release*   now | [Release](new-repo.md#release) |\n",
      [{ label: "Ship a release now", href: "new-repo.md#release", note: null }],
    ],
  ];
  test.each(shapes)("%s", (_name, src, rows) => {
    const { withRule } = renderers();
    expect(withRule.render(src, { ...LANDING })).toBe(launcherTag(rows));
  });
});

/** VitePress's shared renderer with the fleet's rules, as config.mts
 *  installs them; createMarkdownRenderer returns one process-wide instance,
 *  so every caller passes the same options. */
async function vitepressRenderer(): Promise<Md> {
  const vitepress = (await import(
    join(ACTION_DIR, "node_modules", "vitepress", "dist", "node", "index.js")
  )) as {
    createMarkdownRenderer(srcDir: string, options: object, base: string): Promise<Md>;
  };
  return vitepress.createMarkdownRenderer(
    ACTION_DIR,
    {
      highlight: () => "",
      headers: { level: [2, 3] },
      container: CUSTOM_BLOCK_LABELS,
      config(md: Md) {
        inlineTextRule(md);
        landingTableRule(md, REWRITES);
        headersRule(md);
        alertTitlesRule(md);
      },
    },
    "/repo/",
  );
}

describe("landingTableRule under VitePress's renderer", () => {
  test("hrefs come out normalized, links are recorded for the dead-link check, entities decode", async () => {
    const md = await vitepressRenderer();
    const src = [
      "| Goal | [Read](read-all.md) | Note |",
      "|---|---|---|",
      "| A &amp; B &#65; | [New](new-repo.md#x) | ![*Guide*](guide.svg) |",
      "| Gone, `a &amp; b`, `\\*`, \\\\[x] | [Gone](missing.md) | |",
      "| :warning: Absolute | [Abs](/abs.md) | [Header link](header.md) |",
      "",
      "| Read |",
      "|---|",
      "| [![Guide](guide.svg)](guide.md) |",
      "",
    ].join("\n");
    const env: { relativePath: string; path: string; cleanUrls: boolean; links?: string[] } = {
      relativePath: "index.md",
      path: "/site/index.md",
      cleanUrls: false,
    };
    const html = md.render(src, env);
    const rows = [
      { label: "A & B A", href: "./new-repo.html#x", note: "Guide" },
      { label: "Gone, a &amp; b, \\*, \\[x]", href: "./missing.html", note: null },
      { label: "\u26a0\ufe0f Absolute", href: "/repo/abs.html", note: "Header link" },
    ];
    const secondTable =
      '<table tabindex="0">\n<thead>\n<tr>\n<th>Read</th>\n</tr>\n</thead>\n<tbody>\n<tr>\n' +
      '<td><a href="./guide.html"><img src="./guide.svg" alt="Guide"></a></td>\n</tr>\n</tbody>\n</table>\n';
    expect(html).toBe(`${launcherTag(rows)}${secondTable}`);
    expect(env.links).toEqual([
      "./read-all",
      "./new-repo.html#x",
      "./missing",
      "/abs",
      "./header",
      "./guide",
    ]);
  });

  test("a link table inside a tip container stays a table and the goal table below it fires", async () => {
    const md = await vitepressRenderer();
    const src = [
      "::: tip",
      "| Read |",
      "|---|",
      "| [Aside](aside.md) |",
      ":::",
      "",
      "| Goal | Read |",
      "|---|---|",
      "| Publish | [Pages](pages.md) |",
      "",
    ].join("\n");
    const env = { relativePath: "README.md", path: "/site/README.md", cleanUrls: false };
    expect(md.render(src, env)).toBe(
      '<div class="tip custom-block"><p class="custom-block-title">Tip</p>\n' +
        '<table tabindex="0">\n<thead>\n<tr>\n<th>Read</th>\n</tr>\n</thead>\n<tbody>\n<tr>\n' +
        '<td><a href="./aside.html">Aside</a></td>\n</tr>\n</tbody>\n</table>\n</div>\n' +
        launcherTag([{ label: "Publish", href: "./pages.html", note: null }]),
    );
  });

  test("a render stamps the launcher's headings with the page's real anchors", async () => {
    const md = await vitepressRenderer();
    const src = [
      "---",
      "title: Guide",
      "---",
      "",
      "# Title",
      "",
      "## title: Guide",
      "",
      "## Caf&eacute; `a &amp; b` :warning:",
      "",
      "### Sub *em* \\[x]",
      "",
      "#### Deep",
      "",
      "> ## Quoted",
      "",
    ].join("\n");
    const env: HeadersEnv & Record<string, unknown> = {
      relativePath: "page.md",
      path: "/site/page.md",
      cleanUrls: false,
    };
    const html = md.render(src, env);
    const headers = renderedHeaders(env);
    expect(headers).toEqual([
      { title: "title: Guide", anchor: "title-guide", level: 2 },
      { title: "Caf\u00e9 a &amp; b \u26a0\ufe0f", anchor: "caf-eacute-a-amp-b", level: 2 },
      { title: "Sub em [x]", anchor: "sub-em-x", level: 3 },
    ]);
    for (const header of headers) expect(html).toContain(`<h${header.level} id="${header.anchor}"`);
  });

  test("renderedHeaders refuses an env no render stamped", () => {
    expect(() => renderedHeaders({})).toThrow("headersRule is not installed");
  });
});

describe("alertTitlesRule under VitePress's renderer", () => {
  test("GitHub-style alerts take the container labels; an author's own title stays unless it spells the default", async () => {
    const md = await vitepressRenderer();
    const src = [
      "> [!NOTE]",
      "> a",
      "",
      "> [!TIP]",
      "> b",
      "",
      "> [!IMPORTANT]",
      "> c",
      "",
      "> [!WARNING]",
      "> d",
      "",
      "> [!CAUTION]",
      "> e",
      "",
      "> [!WARNING] Mind the gap",
      "> f",
      "",
      "> [!WARNING] WARNING",
      "> g",
      "",
      "::: warning",
      "h",
      ":::",
      "",
    ].join("\n");
    const alert = (type: string, title: string, body: string) =>
      `<div class="${type} custom-block github-alert"><p class="custom-block-title">${title}</p>\n<p>${body}</p>\n</div>\n`;
    expect(md.render(src, { relativePath: "page.md", path: "/site/page.md" })).toBe(
      alert("note", "Note", "a") +
        alert("tip", "Tip", "b") +
        alert("important", "Important", "c") +
        alert("warning", "Warning", "d") +
        alert("caution", "Caution", "e") +
        alert("warning", "Mind the gap", "f") +
        alert("warning", "Warning", "g") +
        '<div class="warning custom-block"><p class="custom-block-title">Warning</p>\n<p>h</p>\n</div>\n',
    );
  });
});
