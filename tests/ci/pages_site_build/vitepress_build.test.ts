import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tierRouteGuard } from "../../../actions/pages-site/.vitepress/theme/tier-routes.ts";
import { fixtureGit } from "../../shared/fixture_git.ts";
import { tempDirs } from "../../shared/temp_dir.ts";
import {
  appendDeadLink,
  assetFiles,
  buildSite,
  commitAll,
  describeRun,
  docsFixture,
  initRepo,
  isFile,
  MERMAID_MOUNT_HTML,
  type RunnerTemp,
  readAssets,
  readSite,
  revertHead,
  runnerTemp,
  TEST_TIMEOUT_MS,
  VITEPRESS_MOUNT,
  versionLabels,
} from "./fixtures.ts";
import { select, texts } from "./html.ts";

const temp = tempDirs();

const DOCS_REPO = "fixture-owner/fixture-repo";
const DEPLOY_ENV = { SITE_TITLE: "Fixture Docs", MOUNTS: VITEPRESS_MOUNT };

describe("the versioned vitepress deploy", () => {
  let site = "";
  let latestIndex = "";
  let latestAssets = "";

  beforeAll(() => {
    const workspace = temp.dir("pages-site-fixture-");
    docsFixture(workspace);
    const runner = runnerTemp(temp);
    const result = buildSite(workspace, DOCS_REPO, runner, DEPLOY_ENV);
    if (result.exitCode !== 0)
      throw new Error(`the versioned build failed: ${describeRun(result)}`);
    site = runner.site;
    latestIndex = readSite(site, "latest/index.html");
    latestAssets = readAssets(site, "latest/assets");
  }, TEST_TIMEOUT_MS);

  test("lays out root = newest tag, latest = HEAD, one dir per tag, and the indexes", () => {
    const expected = [
      "index.html",
      "latest/index.html",
      "v0.1.0/index.html",
      "v0.2.0/index.html",
      "versions.json",
      "llms.txt",
      "latest/llms.txt",
    ];
    expect(expected.filter((rel) => !isFile(site, rel))).toEqual([]);
    expect(versionLabels(site)).toEqual(["latest", "v0.2.0", "v0.1.0"]);
  });

  test("isolates each tier's content: the HEAD edit in latest alone, the v0.2.0 line at the root", () => {
    expect(readSite(site, "latest/setup.html")).toContain("HEAD-only line");
    expect(readSite(site, "setup.html")).not.toContain("HEAD-only line");
    expect(readSite(site, "v0.2.0/setup.html")).not.toContain("HEAD-only line");
    expect(readSite(site, "guide/index.html")).toContain("Second version line");
    expect(readSite(site, "v0.1.0/guide/index.html")).not.toContain("Second version line");
  });

  test("renders the zh-cn locale only in the tiers whose tree carries it, with the translations menu", () => {
    expect(readSite(site, "latest/zh-cn/index.html")).toContain("locale landing page");
    expect(isFile(site, "v0.2.0/zh-cn/index.html")).toBe(true);
    expect(existsSync(join(site, "v0.1.0/zh-cn"))).toBe(false);
    expect(latestIndex).toContain("VPNavBarTranslations");
  });

  test("carries the version switcher, the fleet hue, and a head without an invented favicon", () => {
    expect(latestIndex).toContain("docs-site-version-switcher");
    expect(latestIndex).toContain('data-fleet-hue="');
    // The description falls back to the site title (no settings.yml
    // description in the fixture); a docs tree without public/favicon.*
    // gets no icon link, since an invented one would 404 on every page.
    expect(
      select(latestIndex, 'meta[name="description"]').map((meta) => meta.attrs.content),
    ).toEqual(["Fixture Docs"]);
    expect(select(latestIndex, 'link[rel="icon"]')).toEqual([]);
  });

  test("inlines each tier's own provenance label into its site data", () => {
    // vitepress inlines the site data as an escaped JSON string, hence the
    // backslashes; anchored on the provenance key because the version
    // dropdown lists every tier's label in every page.
    expect(latestIndex).toContain('\\"provenance\\":{\\"label\\":\\"main\\"');
    const v010 = readSite(site, "v0.1.0/index.html");
    expect(v010).toContain('\\"provenance\\":{\\"label\\":\\"v0.1.0\\"');
    expect(v010).not.toContain('\\"provenance\\":{\\"label\\":\\"main\\"');
  });

  test("applies carbon's skin and filters its fonts without stripping the theme's own", () => {
    // The brand token hex is stable because vitepress-carbon is pinned
    // EXACT in the action's package.json; a bump that moves it updates
    // this pin.
    expect(latestAssets).toContain("58a6ff");
    // Carbon's remote @imports and its unused Mona Sans @font-face are
    // dropped (so vite emits neither the woff2 nor a preload link); the
    // theme's fontsource asset is the positive control.
    expect(latestAssets).not.toContain("fonts.googleapis.com");
    expect(latestAssets).not.toContain("fonts.cdnfonts.com");
    expect(latestAssets).not.toContain("Mona-Sans");
    expect(
      readdirSync(join(site, "latest/assets")).filter((n) => n.startsWith("Mona-Sans")),
    ).toEqual([]);
    expect(select(latestIndex, 'link[as="font"]')).toEqual([]);
    expect(latestAssets).toContain("wix-madefor-text-latin-wght-normal");
  });

  test("renders the facts card with the tier being read marked, and the provenance line per tier", () => {
    expect(latestIndex).toContain("fleet-facts");
    expect(latestIndex).toContain(
      'fleet-facts-repository" href="https://github.com/fixture-owner/fixture-repo">' +
        '<span class="fleet-facts-segment">fixture-owner/</span><wbr>' +
        '<span class="fleet-facts-segment">fixture-repo</span><',
    );
    expect(latestIndex).toContain('aria-current="true">latest</a>');
    expect(latestIndex).toContain('fleet-facts-note">reading');
    expect(latestIndex).toContain("fleet-provenance");
    expect(latestIndex).toContain("Built from main");
    expect(latestIndex).toContain("Source: docs/README.md");
    const v020 = readSite(site, "v0.2.0/index.html");
    expect(v020).toContain('aria-current="true">v0.2.0</a>');
    expect(v020).toContain("Built from v0.2.0");
  });

  test("hands the landing's other-version links to the browser and routes the tier's own pages", () => {
    // The guard judges the links the build EMITTED (the facts card's
    // versions, the launcher's first page row) under each tier's base, as
    // the client does: a version link the router served itself was the
    // SPA's 404 until a reload.
    const verdicts = (rel: string, base: string) => {
      const html = readSite(site, `${rel}index.html`);
      const roots = select(html, "select.docs-site-version-switcher option").map(
        (o) => o.attrs.value,
      );
      const left: string[] = [];
      const guard = tierRouteGuard(base, roots, { here: () => base, leave: (to) => left.push(to) });
      const links = [
        ...select(html, ".fleet-facts-items a"),
        ...select(html, "a.fleet-launcher-link").slice(0, 1),
      ];
      const hrefs = links.map((a) => a.attrs.href);
      const routed = hrefs.filter((href) => guard(href) === undefined);
      return { routed, left };
    };
    expect(verdicts("", "/fixture-repo/")).toEqual({
      routed: ["/fixture-repo/setup.html"],
      left: ["/fixture-repo/latest/", "/fixture-repo/v0.2.0/", "/fixture-repo/v0.1.0/"],
    });
    expect(verdicts("latest/", "/fixture-repo/latest/")).toEqual({
      routed: ["/fixture-repo/latest/", "/fixture-repo/latest/setup.html"],
      left: ["/fixture-repo/v0.2.0/", "/fixture-repo/v0.1.0/"],
    });
    expect(latestAssets).toContain("onBeforeRouteChange=");
  });

  test("wraps every table in the scroll wrapper, which is the one tab stop", () => {
    const setup = readSite(site, "latest/setup.html");
    expect(setup).toContain('<div class="vp-table" tabindex="0"><table>');
    expect(setup).not.toContain("<table tabindex");
    expect(setup).toContain("</table></div>");
    expect(latestAssets).toContain(".vp-table{overflow-x:auto;max-width:100%;");
  });

  test("renders every custom-block kind with its class and sentence-case title", () => {
    const alerts = readSite(site, "latest/alerts.html");
    const kinds = ["note", "tip", "important", "warning", "caution"];
    // The title is the block's first paragraph, where the theme's CSS
    // expects it.
    const titles = kinds.map((kind) =>
      texts(alerts, `.${kind}.custom-block.github-alert > p.custom-block-title:first-child`),
    );
    expect(titles).toEqual([["Note"], ["Tip"], ["Important"], ["Warning"], ["Caution"]]);
    expect(alerts).toContain(
      '<div class="info custom-block"><p class="custom-block-title">Info</p>',
    );
    expect(alerts).toContain(
      '<div class="danger custom-block"><p class="custom-block-title">Danger</p>',
    );
    expect(alerts).toContain('<details class="details custom-block"><summary>Show</summary>');
    expect(latestAssets).toContain(
      ".vp-doc .custom-block.warning{border-left-color:var(--color-warning)}",
    );
  });

  test("colors code tokens and ansi fences through the theme's custom properties", () => {
    const alerts = readSite(site, "latest/alerts.html");
    expect(alerts).toContain('style="color:var(--fleet-code-token-comment);"');
    expect(alerts).toContain('style="color:var(--fleet-code-ansi-red);"');
    expect(alerts).not.toContain("color:#000000");
    expect(alerts).not.toContain("shiki-dark");
  });

  test("renders a mermaid fence as the mount with its escaped source, and loads mermaid only from it", () => {
    const alerts = readSite(site, "latest/alerts.html");
    expect(alerts).toContain(MERMAID_MOUNT_HTML);
    expect(alerts).not.toContain("language-mermaid");
    // The mermaid package is its own chunk (mermaidAPI is its export, in
    // nothing else): no page's HTML preloads or scripts it, the theme chunk
    // that owns the mount reaches it by dynamic import alone.
    const assets = assetFiles(site, "latest/assets");
    const scripts = assets.filter((file) => file.name.endsWith(".js"));
    const mermaidChunks = scripts.filter((file) => file.text.includes("mermaidAPI"));
    expect(mermaidChunks.length).toBeGreaterThan(0);
    const themeChunk = scripts.filter((file) => file.text.includes("fleet-mermaid-diagram"));
    expect(themeChunk).toHaveLength(1);
    expect(mermaidChunks.some((chunk) => themeChunk[0].text.includes(chunk.name))).toBe(true);
    for (const page of [latestIndex, alerts, readSite(site, "latest/setup.html")]) {
      expect(mermaidChunks.filter((chunk) => page.includes(chunk.name))).toEqual([]);
    }
    expect(latestAssets).toContain(".fleet-mermaid{");
  });

  test("ships the scrollers' reduced-motion override and the print sheet's cell wrapping", () => {
    // Both rules are pinned whole, selectors included: carbon resets
    // background-attachment under reduced motion for BOTH scrollers, and
    // a declaration alone could sit under either selector.
    expect(latestAssets).toContain(
      ".vp-doc .vp-table,.vp-doc [class*=language-] pre{background-attachment:local,local,scroll,scroll!important}",
    );
    expect(latestAssets).toContain(
      ".vp-doc .vp-table :is(th,td){overflow-wrap:anywhere}.vp-doc .vp-table :is(th,td) code{white-space:normal;overflow-wrap:anywhere}",
    );
  });

  test("turns the landing table into the launcher panel and indexes headings for it", () => {
    // The curated row is in view with the page's two h2s folded behind the
    // group's fold row; every other page carries the nav button; the
    // inlined page index carries the h2 (the proof it indexes headings).
    expect(latestIndex).toContain('class="fleet-launcher fleet-launcher-mode-panel"');
    expect(latestIndex).toContain('fleet-launcher-label">Set things up<');
    expect(latestIndex).toContain(">Show 2 headings on Setup<");
    expect(latestIndex).not.toContain('fleet-launcher-label">Install steps<');
    expect(latestIndex).toContain('fleet-launcher-target">guide<');
    expect(readSite(site, "latest/setup.html")).toContain('class="fleet-launcher-button"');
    expect(latestAssets).toContain('"anchor":"install-steps"');
  });

  test("orders the sidebar by landing, ranked group, table placement, unplaced, directory", () => {
    expect(texts(latestIndex, ".VPSidebar .text")).toEqual([
      "Fixture",
      "Basics",
      "Zulu",
      "Alpha",
      "Setup",
      "Alerts",
      "Bravo",
      "Guide",
      "Guide",
    ]);
    // The launcher's groups follow the sidebar after the curated row, and
    // the guide/ directory's title keeps its capital.
    expect(texts(latestIndex, ".fleet-launcher-group-title")).toEqual([
      "Setup",
      "Zulu",
      "Alpha",
      "Alerts",
      "Bravo",
      "Guide",
    ]);
    expect(readSite(site, "latest/alpha.html")).not.toContain("group: Basics");
    expect(readSite(site, "latest/zulu.html")).not.toContain("order: 1");
  });
});

describe("a nested docs-dir", () => {
  test(
    "lands the leaf tree at the fixed docs/ slot for the tag and HEAD tiers, favicon included",
    () => {
      const workspace = temp.dir("pages-site-nested-");
      mkdirSync(join(workspace, "site", "manual", "public"), { recursive: true });
      writeFileSync(
        join(workspace, "site", "manual", "README.md"),
        "# Nested\n\nnested landing page\n",
      );
      writeFileSync(
        join(workspace, "site", "manual", "public", "favicon.svg"),
        '<svg xmlns="http://www.w3.org/2000/svg"/>\n',
      );
      initRepo(workspace);
      commitAll(workspace, "nested docs");
      fixtureGit(workspace, ["tag", "v1.0.0"]);
      const runner = runnerTemp(temp);
      const result = buildSite(workspace, "fixture-owner/nested-repo", runner, {
        DOCS_DIR: "site/manual",
        MOUNTS: VITEPRESS_MOUNT,
      });
      expect(result.exitCode, describeRun(result)).toBe(0);
      expect(readSite(runner.site, "index.html")).toContain("nested landing page");
      const latest = readSite(runner.site, "latest/index.html");
      expect(latest).toContain("nested landing page");
      expect(latest).toContain("Source: site/manual/README.md");
      // The shipped favicon is linked at the tier's own base and served there.
      expect(select(latest, 'link[rel="icon"]').map((link) => link.attrs.href)).toEqual([
        "/nested-repo/latest/favicon.svg",
      ]);
      expect(isFile(runner.site, "latest/favicon.svg")).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("link strictness", () => {
  test(
    "CHECK mode is green on clean docs and red on a dead internal link",
    () => {
      const workspace = temp.dir("pages-site-check-");
      docsFixture(workspace);
      const clean = buildSite(workspace, DOCS_REPO, runnerTemp(temp), { CHECK: "true" });
      expect(clean.exitCode, describeRun(clean)).toBe(0);
      appendDeadLink(workspace);
      const rotten = buildSite(workspace, DOCS_REPO, runnerTemp(temp), { CHECK: "true" });
      expect(rotten.exitCode, describeRun(rotten)).not.toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the deploy builds a dead link sealed in a tag lenient and fails the same rot on HEAD",
    () => {
      // Hardcoding strictness either way in the builder turns exactly one
      // of these two runs the wrong color: history cannot be fixed, HEAD can.
      const workspace = temp.dir("pages-site-deploy-");
      docsFixture(workspace);
      appendDeadLink(workspace);
      commitAll(workspace, "seal a dead link into history");
      fixtureGit(workspace, ["tag", "v0.3.0"]);
      revertHead(workspace);
      const sealed: RunnerTemp = runnerTemp(temp);
      const lenient = buildSite(workspace, DOCS_REPO, sealed, DEPLOY_ENV);
      expect(lenient.exitCode, describeRun(lenient)).toBe(0);
      expect(versionLabels(sealed.site)).toEqual(["latest", "v0.3.0", "v0.2.0", "v0.1.0"]);
      appendDeadLink(workspace);
      const strict = buildSite(workspace, DOCS_REPO, runnerTemp(temp), DEPLOY_ENV);
      expect(strict.exitCode, describeRun(strict)).not.toBe(0);
    },
    TEST_TIMEOUT_MS,
  );
});
