import { describe, expect, test } from "bun:test";
import {
  isLandingPath,
  LAUNCHER_TAG,
} from "../../../actions/pages-site/.vitepress/landing-launcher.ts";
import { REWRITES, vitepressRenderer } from "./vitepress_renderer.ts";

describe("isLandingPath", () => {
  // The page build sees index.md and the search indexer sees README.md; both must agree on the landing, or the two
  // renders of one page differ. A top-level index outside a locale is no landing.
  const cases: [string, Record<string, string>, boolean][] = [
    ["index.md", REWRITES, true],
    ["README.md", REWRITES, true],
    ["ja/index.md", REWRITES, true],
    ["ja/README.md", REWRITES, true],
    ["guide.md", REWRITES, false],
    ["guide/index.md", REWRITES, false],
    ["guide/README.md", REWRITES, false],
    ["api/index.md", REWRITES, false],
    ["ja/guide.md", REWRITES, false],
    // A README beside a real index.md serves its own route.
    ["README.md", {}, false],
    ["index.md", {}, true],
  ];
  test.each(cases)("%s under rewrites %j is landing: %p", (path, rewrites, landing) => {
    expect(isLandingPath(path, rewrites)).toBe(landing);
  });
});

describe("landingLauncherRule under VitePress's renderer", () => {
  const INTRO = "# Home\n\nWelcome.\n\n";
  const SECTION = "## The pages\n\n- [Guide](other.md)\n";
  // A container's heading is a nested token: the panel never lands inside an aside.
  const ASIDE = "::: tip\n## Not a section\n:::\n\n";

  // VitePress's token stream is the external fact: the h2 the rule seats the panel before is a level-0 heading_open,
  // and a container's heading is not. Each case splits the source where the tag belongs; an article gets none.
  test.each<[string, string, string, string]>([
    ["between the intro and the first section", "index.md", `${INTRO}${ASIDE}`, SECTION],
    ["at the end of a page without a section", "index.md", INTRO, ""],
    ["on the indexer's spelling of the landing", "README.md", INTRO, ""],
    ["on a locale's landing", "ja/index.md", INTRO, ""],
    ["nowhere on an article", "other.md", `${INTRO}${SECTION}`, ""],
  ])("the panel sits %s", async (_, relativePath, before, after) => {
    const md = await vitepressRenderer();
    const render = (text: string, path: string) =>
      text === "" ? "" : md.render(text, { path: `/docs/${path}`, relativePath: path });
    const tag = relativePath === "other.md" ? "" : LAUNCHER_TAG;
    expect(render(`${before}${after}`, relativePath)).toBe(
      `${render(before, "other.md")}${tag}${render(after, "other.md")}`,
    );
  });
});
