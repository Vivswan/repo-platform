// One deploy build of a three-tier fixture (HEAD, v0.2.0, v0.1.0) read by most cases; the theme's
// unit tests pin each rule over hand-written input, these pin what the real vitepress and vite
// builds emit.

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
  siteConfig,
  TEST_TIMEOUT_MS,
  versionLabels,
} from "./fixtures.ts";
import { select, texts } from "./html.ts";

const temp = tempDirs();

const DOCS_REPO = "fixture-owner/fixture-repo";
const DEPLOY_ENV = { CONFIG: siteConfig({ site_title: "Fixture Docs" }) };

describe("the versioned vitepress deploy", () => {
  let site = "";
  let latestIndex = "";
  let latestAssets = "";

  beforeAll(() => {
    const workspace = temp.dir("pages-site-fixture-");
    docsFixture(workspace);
    const runner = runnerTemp(temp, DOCS_REPO);
    const result = buildSite(workspace, DOCS_REPO, runner, DEPLOY_ENV);
    if (result.exitCode !== 0)
      throw new Error(`the versioned build failed: ${describeRun(result)}`);
    site = runner.site;
    latestIndex = readSite(site, "latest/index.html");
    latestAssets = readAssets(site, "latest/assets");
  }, TEST_TIMEOUT_MS);

  test("lays out root = newest tag, latest = HEAD, stable = newest tag, one dir per tag, and the indexes", () => {
    // docs/site.md's docs-only Layout row as the artifact tree, llms.txt included.
    const expected = [
      "index.html",
      "latest/index.html",
      "stable/index.html",
      "v0.1.0/index.html",
      "v0.2.0/index.html",
      "versions.json",
      "llms.txt",
      "latest/llms.txt",
      "stable/llms.txt",
    ];
    expect(expected.filter((rel) => !isFile(site, rel))).toEqual([]);
    expect(versionLabels(site)).toEqual(["latest", "stable", "v0.2.0", "v0.1.0"]);
  });

  test("isolates each tier's content: the HEAD edit in latest alone, the v0.2.0 line at the root and under stable", () => {
    // Tag tiers build from their git trees, HEAD from the checkout; the layout case stays green
    // on a build that copies HEAD everywhere.
    expect(readSite(site, "latest/setup.html")).toContain("HEAD-only line");
    expect(readSite(site, "setup.html")).not.toContain("HEAD-only line");
    expect(readSite(site, "stable/setup.html")).not.toContain("HEAD-only line");
    expect(readSite(site, "v0.2.0/setup.html")).not.toContain("HEAD-only line");
    expect(readSite(site, "guide/index.html")).toContain("Second version line");
    expect(readSite(site, "stable/guide/index.html")).toContain("Second version line");
    expect(readSite(site, "v0.1.0/guide/index.html")).not.toContain("Second version line");
  });

  test("serves the root's content again under stable/: the same article and provenance, the dropdown marking stable", () => {
    // stable/ is its own build of the newest tag (its base sits in the client bundle, the site data,
    // and the chunk hashes), so the article text and the provenance line are the comparison, not
    // the bytes.
    // Carbon's hidden markdown hint spells the tier's base inside the article, so each compared
    // tier's base is normalized away; the latest tier is the control.
    const article = (tier: string, page: string) =>
      texts(readSite(site, `${tier}${page}`), ".vp-doc").map((text) =>
        text.replaceAll(`/fixture-repo/${tier}`, "/fixture-repo/"),
      );
    const provenance = (rel: string) => texts(readSite(site, rel), ".fleet-provenance a");
    for (const page of ["setup.html", "guide/index.html"]) {
      expect(article("stable/", page)).toEqual(article("", page));
    }
    expect(article("latest/", "setup.html").join()).toContain("HEAD-only line");
    expect(article("stable/", "setup.html")).not.toEqual(article("latest/", "setup.html"));
    expect(provenance("stable/index.html")).toEqual(provenance("index.html"));
    expect(provenance("stable/index.html")[0]).toStartWith("Built from v0.2.0 at ");
    const selected = (rel: string) =>
      texts(readSite(site, rel), "select.docs-site-version-switcher option[selected]");
    expect(["index.html", "stable/index.html", "latest/index.html"].map(selected)).toEqual([
      ["v0.2.0"],
      ["stable"],
      ["latest"],
    ]);
  });

  test("renders the zh-cn locale only in the tiers whose tree carries it, with the translations menu", () => {
    // The per-tier locales config reaching vitepress; the translations menu has no unit home.
    expect(readSite(site, "latest/zh-cn/index.html")).toContain("locale landing page");
    expect(isFile(site, "v0.2.0/zh-cn/index.html")).toBe(true);
    expect(existsSync(join(site, "v0.1.0/zh-cn"))).toBe(false);
    expect(latestIndex).toContain("VPNavBarTranslations");
  });

  test("marks the tier being read in the facts card, names it in the provenance label and line per tier, and stamps the repository's hue", () => {
    // The tier's and the repository's identity reaching the render: facts_panel.test pins the
    // card's markup alone, theme_tokens.test the hue's CSS selectors, neither the built HTML.
    // vitepress inlines the site data as an escaped JSON string, hence the backslashes; anchored
    // on the provenance key because the version dropdown lists every tier's label in every page.
    const tiers: [string, string, string][] = [
      ["latest/", "main", "latest"],
      ["stable/", "v0.2.0", "stable"],
      ["v0.2.0/", "v0.2.0", "v0.2.0"],
      ["v0.1.0/", "v0.1.0", "v0.1.0"],
    ];
    for (const [rel, label, current] of tiers) {
      const page = readSite(site, `${rel}index.html`);
      const labels = [...new Set(tiers.map(([, other]) => other))].filter((other) =>
        page.includes(`\\"provenance\\":{\\"label\\":\\"${other}\\"`),
      );
      expect([rel, labels]).toEqual([rel, [label]]);
      expect(texts(page, '.fleet-facts-items a[aria-current="true"]')).toEqual([current]);
      expect(page).toContain(`Built from ${label}`);
    }
    expect(latestIndex).toContain('data-fleet-hue="');
    // The site description falls back to the title when settings.yml names none.
    expect(
      select(latestIndex, 'meta[name="description"]').map((meta) => meta.attrs.content),
    ).toEqual(["Fixture Docs"]);
  });

  test("filters carbon's remote fonts and its unused face without stripping the theme's own", () => {
    // vitepress-carbon's CSS carries remote @imports and an unused Mona Sans @font-face, which
    // the theme's build filter drops (so vite emits neither the woff2 nor a preload link); a
    // carbon bump that moves the import past the filter makes every page fetch Google fonts.
    // The theme's fontsource asset is the positive control.
    expect(latestAssets).not.toContain("fonts.googleapis.com");
    expect(latestAssets).not.toContain("fonts.cdnfonts.com");
    expect(latestAssets).not.toContain("Mona-Sans");
    expect(
      readdirSync(join(site, "latest/assets")).filter((n) => n.startsWith("Mona-Sans")),
    ).toEqual([]);
    expect(select(latestIndex, 'link[as="font"]')).toEqual([]);
    expect(latestAssets).toContain("wix-madefor-text-latin-wght-normal");
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
      left: [
        "/fixture-repo/latest/",
        "/fixture-repo/stable/",
        "/fixture-repo/v0.2.0/",
        "/fixture-repo/v0.1.0/",
      ],
    });
    expect(verdicts("latest/", "/fixture-repo/latest/")).toEqual({
      routed: ["/fixture-repo/latest/", "/fixture-repo/latest/setup.html"],
      left: ["/fixture-repo/stable/", "/fixture-repo/v0.2.0/", "/fixture-repo/v0.1.0/"],
    });
    expect(verdicts("stable/", "/fixture-repo/stable/")).toEqual({
      routed: ["/fixture-repo/stable/", "/fixture-repo/stable/setup.html"],
      left: ["/fixture-repo/latest/", "/fixture-repo/v0.2.0/", "/fixture-repo/v0.1.0/"],
    });
    expect(latestAssets).toContain("onBeforeRouteChange=");
  });

  test("renders every custom-block kind with its class and sentence-case title, and wraps each table as the one tab stop", () => {
    // vitepress's alert and container markup is what the theme's CSS targets (the title as the
    // block's first paragraph); a vitepress bump that moves it restyles every alert silently.
    // The table wrapper is the theme's renderer rule registered in config.mts; table_wrap.test
    // installs the rule itself, so only the built page shows the registration reached vitepress.
    const setup = readSite(site, "latest/setup.html");
    expect(setup).toContain('<div class="vp-table" tabindex="0"><table>');
    expect(setup).not.toContain("<table tabindex");
    const alerts = readSite(site, "latest/alerts.html");
    const kinds = ["note", "tip", "important", "warning", "caution"];
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
  });

  test("colors code tokens and ansi fences through the theme's custom properties", () => {
    // shiki's `ansi` language and the CSS-variables theme, as the build emits them; the ansi
    // palette has no unit home.
    const alerts = readSite(site, "latest/alerts.html");
    expect(alerts).toContain('style="color:var(--fleet-code-token-comment);"');
    expect(alerts).toContain('style="color:var(--fleet-code-ansi-red);"');
    expect(alerts).not.toContain("color:#000000");
    expect(alerts).not.toContain("shiki-dark");
  });

  test("renders a mermaid fence as the mount with its escaped source, and loads mermaid only from it", () => {
    // Only a real vite build shows which chunk holds mermaid and which pages preload it: the
    // package is its own chunk (mermaidAPI is its export, in nothing else), no page's HTML
    // preloads or scripts it, and the theme chunk that owns the mount reaches it by dynamic
    // import alone.
    const alerts = readSite(site, "latest/alerts.html");
    expect(alerts).toContain(MERMAID_MOUNT_HTML);
    expect(alerts).not.toContain("language-mermaid");
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

  test("places the landing table's row and the sidebar's groups in the launcher, mounts its button on every other page, and orders the sidebar by landing, ranked group, table placement, unplaced, directory", () => {
    // The landing table and the sidebar both reaching the real page. The unit tests pin the
    // order and the model over hand-written input and mount the launcher component alone; the
    // theme's slot and the rendered group titles have no other home.
    expect(latestIndex).toContain('fleet-launcher-label">Set things up<');
    expect(readSite(site, "latest/setup.html")).toContain('class="fleet-launcher-button"');
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

  test(
    "links a shipped favicon at the tier's own base and serves it there, for the tag and HEAD tiers",
    () => {
      // Per-tier `head` and public/ copy. The control is the fixture above, whose docs tree
      // ships no public/favicon.*: an invented icon link would 404 on every page.
      expect(select(latestIndex, 'link[rel="icon"]')).toEqual([]);
      const workspace = temp.dir("pages-site-favicon-");
      mkdirSync(join(workspace, "docs", "public"), { recursive: true });
      writeFileSync(join(workspace, "docs", "README.md"), "# Favicon\n\nfavicon landing page\n");
      writeFileSync(
        join(workspace, "docs", "public", "favicon.svg"),
        '<svg xmlns="http://www.w3.org/2000/svg"/>\n',
      );
      initRepo(workspace);
      commitAll(workspace, "docs with a favicon");
      fixtureGit(workspace, ["tag", "v1.0.0"]);
      const runner = runnerTemp(temp, "fixture-owner/favicon-repo");
      const result = buildSite(workspace, "fixture-owner/favicon-repo", runner, {});
      expect(result.exitCode, describeRun(result)).toBe(0);
      expect(readSite(runner.site, "index.html")).toContain("favicon landing page");
      const latest = readSite(runner.site, "latest/index.html");
      expect(latest).toContain("Source: docs/README.md");
      expect(select(latest, 'link[rel="icon"]').map((link) => link.attrs.href)).toEqual([
        "/favicon-repo/latest/favicon.svg",
      ]);
      expect(isFile(runner.site, "latest/favicon.svg")).toBe(true);
      expect(isFile(runner.site, "favicon.svg")).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("link strictness", () => {
  test(
    "the deploy builds a dead link sealed in a tag lenient and fails the same rot on HEAD, as the PR check does",
    () => {
      // Hardcoding strictness either way in the builder turns exactly one of the deploy runs
      // the wrong color: history cannot be fixed, HEAD can. pages-site.test reads the wiring
      // as a value; only a build shows it armed.
      const workspace = temp.dir("pages-site-deploy-");
      docsFixture(workspace);
      appendDeadLink(workspace);
      commitAll(workspace, "seal a dead link into history");
      fixtureGit(workspace, ["tag", "v0.3.0"]);
      revertHead(workspace);
      const sealed: RunnerTemp = runnerTemp(temp, DOCS_REPO);
      const lenient = buildSite(workspace, DOCS_REPO, sealed, DEPLOY_ENV);
      expect(lenient.exitCode, describeRun(lenient)).toBe(0);
      expect(versionLabels(sealed.site)).toEqual([
        "latest",
        "stable",
        "v0.3.0",
        "v0.2.0",
        "v0.1.0",
      ]);
      appendDeadLink(workspace);
      const strict = buildSite(workspace, DOCS_REPO, runnerTemp(temp, DOCS_REPO), DEPLOY_ENV);
      expect(strict.exitCode, describeRun(strict)).not.toBe(0);
      const check = buildSite(workspace, DOCS_REPO, runnerTemp(temp, DOCS_REPO), { CHECK: "true" });
      expect(check.exitCode, describeRun(check)).not.toBe(0);
    },
    TEST_TIMEOUT_MS,
  );
});
