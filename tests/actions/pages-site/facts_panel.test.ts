import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { ProjectFacts } from "../../../actions/pages-site/facts.ts";

const ACTION_DIR = resolve(import.meta.dir, "../../../actions/pages-site");

const FACTS: ProjectFacts = {
  repository: "fixture-owner/fixture-repo",
  repoUrl: "https://github.com/fixture-owner/fixture-repo",
  name: "Fixture",
  description: "A fixture repository",
  homepage: "https://example.test/docs/",
  topics: ["bun", "github-actions"],
  toolchains: [
    { name: "Bun", version: "1.4.0" },
    { name: "Python", version: "3.13" },
  ],
  license: { name: "MIT License", path: "LICENSE.md" },
  docsDir: "docs",
  provenance: { label: "v0.2.0", sha: "0123456789abcdef0123456789abcdef01234567", url: "" },
  hue: 3,
};

const VERSIONS = [
  { label: "latest", link: "/fixture-repo/latest/" },
  { label: "v0.2.0", link: "/fixture-repo/" },
  { label: "v0.1.0", link: "/fixture-repo/v0.1.0/" },
];

interface Scenario {
  theme: Record<string, unknown>;
  frontmatter: Record<string, unknown>;
  html: string;
}

/** The card, section by section: the repository and homepage split at
 *  their slashes, topics as chips, each counted group with its items
 *  nested in its value cell, the version being read marked by aria-current
 *  and the note, the license linked at the tier's own ref. */
const FULL_CARD =
  '<aside class="fleet-facts" aria-labelledby="fleet-facts-title">' +
  '<p class="fleet-facts-title" id="fleet-facts-title">Fixture</p>' +
  '<p class="fleet-facts-description">A fixture repository</p>' +
  '<hr class="fleet-facts-rule">' +
  '<div class="fleet-facts-body">' +
  '<dl class="fleet-facts-section">' +
  '<div class="fleet-facts-row"><dt>Repository</dt><dd>' +
  '<a class="fleet-facts-repository" href="https://github.com/fixture-owner/fixture-repo">' +
  '<span class="fleet-facts-segment">fixture-owner/</span><wbr>' +
  '<span class="fleet-facts-segment">fixture-repo</span></a></dd></div>' +
  '<div class="fleet-facts-row"><dt>Homepage</dt><dd><a href="https://example.test/docs/">' +
  '<span class="fleet-facts-segment">example.test/</span><wbr>' +
  '<span class="fleet-facts-segment">docs</span></a></dd></div>' +
  '<div class="fleet-facts-row"><dt>Topics</dt><dd><ul class="fleet-facts-topics" role="list">' +
  '<li class="fleet-facts-topic">bun</li><li class="fleet-facts-topic">github-actions</li>' +
  "</ul></dd></div>" +
  "</dl>" +
  '<dl class="fleet-facts-section">' +
  '<div class="fleet-facts-row fleet-facts-group"><dt>Toolchain</dt><dd>' +
  '<span class="fleet-facts-count">2</span><dl class="fleet-facts-items">' +
  '<div class="fleet-facts-item"><dt>Bun</dt><dd>1.4.0</dd></div>' +
  '<div class="fleet-facts-item"><dt>Python</dt><dd>3.13</dd></div>' +
  "</dl></dd></div>" +
  "</dl>" +
  '<dl class="fleet-facts-section">' +
  '<div class="fleet-facts-row fleet-facts-group"><dt>Versions</dt><dd>' +
  '<span class="fleet-facts-count">3</span><dl class="fleet-facts-items">' +
  '<div class="fleet-facts-item"><dt><a href="/fixture-repo/latest/">latest</a></dt><dd></dd></div>' +
  '<div class="fleet-facts-item"><dt><a href="/fixture-repo/" aria-current="true">v0.2.0</a></dt>' +
  '<dd><span class="fleet-facts-note">reading</span></dd></div>' +
  '<div class="fleet-facts-item"><dt><a href="/fixture-repo/v0.1.0/">v0.1.0</a></dt><dd></dd></div>' +
  "</dl></dd></div>" +
  "</dl>" +
  '<dl class="fleet-facts-section">' +
  '<div class="fleet-facts-row"><dt>License</dt><dd>' +
  '<a href="https://github.com/fixture-owner/fixture-repo/blob/v0.2.0/LICENSE.md">MIT License</a>' +
  "</dd></div>" +
  "</dl>" +
  "</div></aside>";

/** Only what the repository always has: no optional row renders empty. */
const BARE_CARD =
  '<aside class="fleet-facts" aria-labelledby="fleet-facts-title">' +
  '<p class="fleet-facts-title" id="fleet-facts-title">Fixture</p>' +
  "<!---->" +
  '<hr class="fleet-facts-rule">' +
  '<div class="fleet-facts-body">' +
  '<dl class="fleet-facts-section">' +
  '<div class="fleet-facts-row"><dt>Repository</dt><dd>' +
  '<a class="fleet-facts-repository" href="https://github.com/fixture-owner/fixture-repo">' +
  '<span class="fleet-facts-segment">fixture-owner/</span><wbr>' +
  '<span class="fleet-facts-segment">fixture-repo</span></a></dd></div>' +
  "</dl>" +
  "</div></aside>";

const SCENARIOS: Record<string, Scenario> = {
  "every fact, three served versions, the tier's own version being read": {
    theme: { docsSiteFacts: FACTS, docsSiteVersions: VERSIONS, docsSiteCurrent: "v0.2.0" },
    frontmatter: { fleetLanding: true },
    html: FULL_CARD,
  },
  "the bare facts of an unversioned site": {
    theme: {
      docsSiteFacts: {
        ...FACTS,
        description: null,
        homepage: null,
        topics: [],
        toolchains: [],
        license: null,
      },
    },
    frontmatter: { fleetLanding: true },
    html: BARE_CARD,
  },
  "a page that is not the landing renders nothing": {
    theme: { docsSiteFacts: FACTS, docsSiteVersions: VERSIONS, docsSiteCurrent: "latest" },
    frontmatter: {},
    html: "<!---->",
  },
  "a site without facts renders nothing": {
    theme: {},
    frontmatter: { fleetLanding: true },
    html: "<!---->",
  },
};

describe("FactsPanel", () => {
  // Under bun the bare `vitepress` specifier resolves to the node entry,
  // which has no useData (Vite aliases the client one); a virtual module
  // stands in, its refs set per render.
  let stage: Promise<(scenario: Scenario) => Promise<string>> | undefined;
  function render(scenario: Scenario): Promise<string> {
    stage ??= (async () => {
      const vue = await import(resolve(ACTION_DIR, "node_modules/vue/index.mjs"));
      const theme = vue.ref({});
      const frontmatter = vue.ref({});
      Bun.plugin({
        name: "facts-ssr-stubs",
        setup(build) {
          build.module("vitepress", () => ({
            exports: { useData: () => ({ theme, frontmatter }) },
            loader: "object",
          }));
        },
      });
      const { renderToString } = await import(
        resolve(ACTION_DIR, "node_modules/vue/server-renderer/index.mjs")
      );
      const { default: FactsPanel } = await import(
        resolve(ACTION_DIR, ".vitepress/theme/facts-panel.ts")
      );
      return (scenario: Scenario) => {
        theme.value = scenario.theme;
        frontmatter.value = scenario.frontmatter;
        return renderToString(vue.createSSRApp(FactsPanel));
      };
    })();
    return stage.then((run) => run(scenario));
  }

  test.each(Object.entries(SCENARIOS))("%s", async (_name, scenario) => {
    expect(await render(scenario)).toBe(scenario.html);
  });
});
