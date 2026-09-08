import { describe, expect, test } from "bun:test";
import type { PageHeader } from "../../../actions/pages-site/.vitepress/theme/launcher-model.ts";
import {
  type HeadersEnv,
  sourceHeaders,
} from "../../../actions/pages-site/.vitepress/theme/page-index.ts";

const OWN_HEADING: PageHeader = { title: "Install!", anchor: "install", level: 2 };

/** A renderer that stamps the same headers on every render, so what the
 *  rule lets through is the only variable. */
const stampingRenderer = {
  render(_source: string, env: HeadersEnv): string {
    env.launcherHeaders = [OWN_HEADING];
    return "";
  },
};

describe("sourceHeaders", () => {
  const cases: [string, string, PageHeader[]][] = [
    ["a page without a directive keeps its headings", "# Page\n\n## Install!\n", [OWN_HEADING]],
    [
      "a tight include directive drops every heading row",
      "# Page\n\n<!--@include: ./part.md-->\n\n## Install!\n",
      [],
    ],
    [
      "a spaced include directive drops every heading row",
      "# Page\n\n<!-- @include: ./part.md -->\n\n## Install!\n",
      [],
    ],
    [
      "an ordinary HTML comment is not a directive",
      "# Page\n\n<!-- include: ./part.md -->\n\n## Install!\n",
      [OWN_HEADING],
    ],
  ];
  test.each(cases)("%s", (_name, source, expected) => {
    expect(sourceHeaders(stampingRenderer, source, {})).toEqual(expected);
  });

  test("refuses a renderer without headersRule", () => {
    const bare = { render: () => "" };
    expect(() => sourceHeaders(bare, "## Install!\n", {})).toThrow("headersRule is not installed");
  });
});
