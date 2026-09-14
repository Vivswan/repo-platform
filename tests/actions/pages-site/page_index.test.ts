import { describe, expect, test } from "bun:test";
import type { PageHeader } from "../../../actions/pages-site/.vitepress/theme/launcher-model.ts";
import {
  type HeadersEnv,
  sourceHeaders,
} from "../../../actions/pages-site/.vitepress/theme/page-index.ts";

const OWN_HEADING: PageHeader = { title: "Install!", anchor: "install", level: 2 };

// VitePress expands `<!-- @include -->` before any rule sees the page, so a heading in the included file is a real anchor
// and one behind a missing target is not; processIncludes' resolution is undocumented, and a wrong guess shifts every
// launcher anchor with nothing red. The renderer stamps the same headers on every render, so the rule is the only variable.
const stampingRenderer = {
  render(_source: string, env: HeadersEnv): string {
    env.launcherHeaders = [OWN_HEADING];
    return "";
  },
};

const SRC_DIR = "/site/docs";
const PAGE = "/site/docs/guide/page.md";

describe("sourceHeaders", () => {
  // The last column is every path the rule probes, in VitePress's resolution order, until one resolves to a readable file.
  const cases: [string, string, string[], PageHeader[], string[]][] = [
    [
      "a page without a directive keeps its headings",
      "# Page\n\n## Install!\n",
      [],
      [OWN_HEADING],
      [],
    ],
    [
      "a tight include directive to an existing file drops every heading row",
      "# Page\n\n<!--@include: ./part.md-->\n\n## Install!\n",
      ["/site/docs/guide/part.md"],
      [],
      ["/site/docs/guide/part.md"],
    ],
    [
      "a directive naming a missing file stays literal in VitePress, so the headings stay",
      "# Page\n\n<!-- @include: ./gone.md -->\n\n## Install!\n",
      [],
      [OWN_HEADING],
      ["/site/docs/guide/gone.md"],
    ],
    [
      "a directive quoted in a code span names no real file, so the headings stay",
      "# Page\n\nVitePress `<!-- @include: file.md -->` directives work.\n\n## Install!\n",
      [],
      [OWN_HEADING],
      ["/site/docs/guide/file.md"],
    ],
    [
      "an @/ include resolves against srcDir",
      "# Page\n\n<!-- @include: @/snippets/part.md -->\n\n## Install!\n",
      ["/site/docs/snippets/part.md"],
      [],
      ["/site/docs/snippets/part.md"],
    ],
    [
      "an @ include without a slash resolves against srcDir too",
      "# Page\n\n<!-- @include: @snippets/part.md -->\n\n## Install!\n",
      ["/site/docs/snippets/part.md"],
      [],
      ["/site/docs/snippets/part.md"],
    ],
    [
      "a region suffix is stripped before resolving",
      "# Page\n\n<!-- @include: ./part.md#setup -->\n\n## Install!\n",
      ["/site/docs/guide/part.md"],
      [],
      ["/site/docs/guide/part.md"],
    ],
    [
      "a line range suffix is stripped before resolving",
      "# Page\n\n<!-- @include: ./part.md{3,} -->\n\n## Install!\n",
      ["/site/docs/guide/part.md"],
      [],
      ["/site/docs/guide/part.md"],
    ],
    [
      "a region and a range together are both stripped",
      "# Page\n\n<!-- @include: ./part.md#setup{1,5} -->\n\n## Install!\n",
      ["/site/docs/guide/part.md"],
      [],
      ["/site/docs/guide/part.md"],
    ],
    [
      "an empty capture is left alone with no lookup",
      "# Page\n\n<!-- @include: -->\n\n## Install!\n",
      [],
      [OWN_HEADING],
      [],
    ],
    [
      "a directive naming a directory is unreadable for VitePress, so the headings stay",
      "# Page\n\n<!-- @include: ./ -->\n\n## Install!\n",
      [],
      [OWN_HEADING],
      ["/site/docs/guide/"],
    ],
    [
      "one expandable directive among missing ones drops the rows",
      "# Page\n\n<!-- @include: ./gone.md -->\n\n<!-- @include: ./part.md -->\n\n## Install!\n",
      ["/site/docs/guide/part.md"],
      [],
      ["/site/docs/guide/gone.md", "/site/docs/guide/part.md"],
    ],
    [
      "an ordinary HTML comment is not a directive",
      "# Page\n\n<!-- include: ./part.md -->\n\n## Install!\n",
      ["/site/docs/guide/part.md"],
      [OWN_HEADING],
      [],
    ],
  ];
  test.each(cases)("%s", (_name, source, existing, expectedHeaders, expectedLookups) => {
    const lookups: string[] = [];
    const scope = {
      file: PAGE,
      srcDir: SRC_DIR,
      isFile(path: string): boolean {
        lookups.push(path);
        return existing.includes(path);
      },
    };
    expect(sourceHeaders(stampingRenderer, source, {}, scope)).toEqual(expectedHeaders);
    expect(lookups).toEqual(expectedLookups);
  });
});
