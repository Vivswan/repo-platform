// One deploy build of a fleet-shaped repository (a hook's website at the root, docs/ at three versions, skills/ and
// agents/ rendered inside the docs), read by every case: the theme's unit tests pin each rule over hand-written
// input, these pin what the real vitepress and vite builds emit and the artifact the deploy hands on.

import { beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tierRouteGuard } from "../../../actions/pages-site/.vitepress/theme/tier-routes.ts";
import { tempDirs } from "../../shared/temp_dir.ts";
import {
  assetFiles,
  type BuildResult,
  buildSite,
  commitAll,
  deployLinkCheckArgs,
  describeRun,
  FLEET_ENV,
  FLEET_REPO,
  fleetRepo,
  initRepo,
  isFile,
  linkCheckInputs,
  MERMAID_MOUNT_HTML,
  outputs,
  pinnedLychee,
  present,
  type RunnerTemp,
  readAssets,
  readSite,
  runLinkCheck,
  runnerTemp,
  SEALED_DEAD_LINK,
  SITE_TITLE,
  TEST_TIMEOUT_MS,
  versionLabels,
} from "./fixtures.ts";
import { select, texts } from "./html.ts";

const temp = tempDirs();

/** The one build, shared by every case below; RUNNER_TEMP is a symlink on purpose (fixtures.ts), the shape under
 *  which every internal link once read dead. */
let workspace = "";
let runner: RunnerTemp;
let built: BuildResult;
let site = "";
let latestIndex = "";
let latestAssets = "";

beforeAll(() => {
  workspace = temp.dir("pages-site-fleet-");
  fleetRepo(workspace);
  runner = runnerTemp(temp, FLEET_REPO);
  built = buildSite(workspace, FLEET_REPO, runner, FLEET_ENV);
  if (built.exitCode !== 0)
    throw new Error(`the fleet fixture's build failed: ${describeRun(built)}`);
  site = runner.site;
  latestIndex = readSite(site, "docs/latest/index.html");
  latestAssets = readAssets(site, "docs/latest/assets");
}, TEST_TIMEOUT_MS);

const hrefs = (html: string, selector: string) => select(html, selector).map((a) => a.attrs.href);

describe("the artifact a deploy lands", () => {
  test("lays out the website at the root and the docs beside it (root = newest tag, latest = HEAD, stable = newest tag, one dir per served tag, the indexes), skips the landing-less tag with a notice, and emits the outputs the deploy step reads", () => {
    // docs/modules/site.md's "website and docs" Layout row as the artifact tree, llms.txt included; siteLayout's unit
    // table pins the rows as values, this pins the artifact and the `publish` output.
    const expected = [
      "index.html",
      "assets/app.js",
      "[guide].html",
      "docs/index.html",
      "docs/latest/index.html",
      "docs/stable/index.html",
      "docs/v0.1.0/index.html",
      "docs/v0.2.0/index.html",
      "docs/versions.json",
      "docs/llms.txt",
      "docs/latest/llms.txt",
      "docs/stable/llms.txt",
    ];
    expect(expected.filter((rel) => !isFile(site, rel))).toEqual([]);
    const indexes = ["docs/", "docs/latest/", "docs/stable/", "docs/v0.2.0/", "docs/v0.1.0/"];
    expect(
      indexes.filter((rel) => !readSite(site, `${rel}index.html`).includes("Welcome.")),
    ).toEqual([]);
    expect(readSite(site, "index.html")).toContain("WEBSITE-ROOT");
    expect(readSite(site, "assets/app.js")).toContain("console.log(1)");
    expect(latestIndex).toContain('href="/fixture-repo/docs/latest/');
    expect(present(site, ["docs/v0.0.1", "versions.json", "latest", "stable"])).toEqual([]);
    expect(versionLabels(join(site, "docs"))).toEqual(["latest", "stable", "v0.2.0", "v0.1.0"]);
    expect(built.stdout).toContain(
      "::notice::docs version v0.0.1 skipped: docs/ has no landing page (README.md or index.md) at that tag",
    );
    expect(outputs(built.stdout)).toEqual({
      "publish": "true",
      "site-dir": site,
      "link-check-args": deployLinkCheckArgs(runner, FLEET_REPO),
      "link-rot-label": "rot",
      "link-rot-color": "",
      "link-rot-description": "",
      "site-title": "Fixture Docs",
    });
  });

  test("isolates each tier's content: the HEAD edit in latest alone, the v0.2.0 line at the root and under stable, the dead link sealed in v0.1.0 built lenient and served there alone", () => {
    // Tag tiers build from their git trees, HEAD from the checkout; the layout case stays green on a build that
    // copies HEAD everywhere. The sealed link is the one strictness fact a passing build can show: hardcoded
    // strict, this build is red (the HEAD half is below).
    expect(readSite(site, "docs/latest/setup.html")).toContain("HEAD-only line");
    expect(readSite(site, "docs/setup.html")).not.toContain("HEAD-only line");
    expect(readSite(site, "docs/stable/setup.html")).not.toContain("HEAD-only line");
    expect(readSite(site, "docs/v0.2.0/setup.html")).not.toContain("HEAD-only line");
    expect(readSite(site, "docs/guide/index.html")).toContain("Second version line");
    expect(readSite(site, "docs/stable/guide/index.html")).toContain("Second version line");
    expect(readSite(site, "docs/v0.1.0/guide/index.html")).not.toContain("Second version line");
    expect(texts(readSite(site, "docs/v0.1.0/setup.html"), ".vp-doc a")).toContain("dead link");
    expect(texts(readSite(site, "docs/setup.html"), ".vp-doc a")).not.toContain("dead link");
    expect(texts(readSite(site, "docs/latest/setup.html"), ".vp-doc a")).not.toContain("dead link");
  });

  test("serves the root's content again under stable/: the same article and provenance, the version menu marking stable", () => {
    // stable/ is its own build of the newest tag (its base sits in the client bundle, the site data, and the chunk
    // hashes), so the article text and the provenance line are the comparison, not the bytes. Carbon's hidden
    // markdown hint spells the tier's base inside the article, so each compared tier's base is normalized away;
    // the latest tier is the control.
    const article = (tier: string, page: string) =>
      texts(readSite(site, `docs/${tier}${page}`), ".vp-doc").map((text) =>
        text.replaceAll(`/fixture-repo/docs/${tier}`, "/fixture-repo/docs/"),
      );
    const provenance = (rel: string) => texts(readSite(site, rel), ".fleet-provenance a");
    for (const page of ["setup.html", "guide/index.html"]) {
      expect(article("stable/", page)).toEqual(article("", page));
    }
    expect(article("latest/", "setup.html").join()).toContain("HEAD-only line");
    expect(article("stable/", "setup.html")).not.toEqual(article("latest/", "setup.html"));
    expect(provenance("docs/stable/index.html")).toEqual(provenance("docs/index.html"));
    expect(provenance("docs/stable/index.html")[0]).toStartWith("Built from v0.2.0 at ");
    // The version menu's items are VitePress nav links: absolute at the site's origin (VPLink would prefix this
    // tier's base onto a root-relative href) and targeted (the router hands a targeted link to the browser); the
    // tier being read is the active entry.
    const menu = (rel: string) =>
      select(readSite(site, rel), ".VPNavBarMenuGroup .VPMenuLink a").map((a) => ({
        href: a.attrs.href,
        target: a.attrs.target,
        text: a.text.trim(),
        active: a.attrs.class.split(" ").includes("active"),
      }));
    const tier = (label: string, active = false) => ({
      href: `https://fixture-owner.github.io/fixture-repo/docs/${label}/`,
      target: "_self",
      text: label,
      active,
    });
    expect(menu("docs/stable/index.html")).toEqual([
      tier("latest"),
      tier("stable", true),
      tier("v0.2.0"),
      tier("v0.1.0"),
    ]);
    const active = (rel: string) =>
      menu(rel)
        .filter((item) => item.active)
        .map((item) => item.text);
    expect(["docs/index.html", "docs/latest/index.html"].map(active)).toEqual([
      ["v0.2.0"],
      ["latest"],
    ]);
  });

  test("renders the zh-cn locale only in the tiers whose tree carries it, with the translations menu", () => {
    // The per-tier locales config reaching vitepress; the translations menu has no unit home.
    expect(readSite(site, "docs/latest/zh-cn/index.html")).toContain("locale landing page");
    expect(isFile(site, "docs/v0.2.0/zh-cn/index.html")).toBe(true);
    expect(existsSync(join(site, "docs/v0.1.0/zh-cn"))).toBe(false);
    expect(latestIndex).toContain("VPNavBarTranslations");
  });

  test("marks the tier being read in the facts card, names it in the provenance label and line per tier, and stamps the repository's hue", () => {
    // The tier's and the repository's identity reaching the render: facts_panel.test pins the card's markup
    // alone, theme_tokens.test the hue's CSS selectors, neither the built HTML. vitepress inlines the site data as
    // an escaped JSON string, hence the backslashes; anchored on the provenance key because the version dropdown
    // lists every tier's label in every page.
    const tiers: [string, string, string][] = [
      ["docs/latest/", "main", "latest"],
      ["docs/stable/", "v0.2.0", "stable"],
      ["docs/v0.2.0/", "v0.2.0", "v0.2.0"],
      ["docs/v0.1.0/", "v0.1.0", "v0.1.0"],
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

  test("links a shipped favicon at the tier's own base and serves it there, for the tag and HEAD tiers; a tier whose tree ships none links none", () => {
    // Per-tier `head` and public/ copy. v0.1.0, from before the icon, is the control: an invented icon link would
    // 404 on every page there.
    const icon = (rel: string) => hrefs(readSite(site, `${rel}index.html`), 'link[rel="icon"]');
    expect(icon("docs/latest/")).toEqual(["/fixture-repo/docs/latest/favicon.svg"]);
    expect(icon("docs/")).toEqual(["/fixture-repo/docs/favicon.svg"]);
    expect(icon("docs/v0.1.0/")).toEqual([]);
    const icons = ["docs/latest/favicon.svg", "docs/favicon.svg", "docs/v0.1.0/favicon.svg"];
    expect(icons.filter((rel) => isFile(site, rel))).toEqual(icons.slice(0, 2));
    expect(present(site, icons.slice(2))).toEqual([]);
  });
});

describe("the theme in the built pages", () => {
  test("filters carbon's remote fonts and its unused face without stripping the theme's own", () => {
    // vitepress-carbon's CSS carries remote @imports and an unused Mona Sans @font-face, which the theme's build
    // filter drops (so vite emits neither the woff2 nor a preload link); a carbon bump that moves the import past
    // the filter makes every page fetch Google fonts. The theme's fontsource asset is the positive control.
    expect(latestAssets).not.toContain("fonts.googleapis.com");
    expect(latestAssets).not.toContain("fonts.cdnfonts.com");
    expect(latestAssets).not.toContain("Mona-Sans");
    expect(
      readdirSync(join(site, "docs/latest/assets")).filter((n) => n.startsWith("Mona-Sans")),
    ).toEqual([]);
    expect(select(latestIndex, 'link[as="font"]')).toEqual([]);
    expect(latestAssets).toContain("wix-madefor-text-latin-wght-normal");
  });

  test("hands the landing's other-version links to the browser and routes the tier's own pages", () => {
    // The guard judges the links the build EMITTED (the facts card's versions, the launcher's first page row)
    // under each tier's base, as the client does: a version link the router served itself was the SPA's 404
    // until a reload.
    const verdicts = (rel: string, base: string) => {
      const html = readSite(site, `${rel}index.html`);
      const roots = hrefs(html, ".VPNavBarMenuGroup .VPMenuLink a").map(
        (href) => new URL(href).pathname,
      );
      const left: string[] = [];
      const guard = tierRouteGuard(base, roots, { here: () => base, leave: (to) => left.push(to) });
      const links = [
        ...hrefs(html, ".fleet-facts-items a"),
        ...hrefs(html, "a.fleet-launcher-link").slice(0, 1),
      ];
      return { routed: links.filter((href) => guard(href) === undefined), left };
    };
    const others = (...labels: string[]) => labels.map((label) => `/fixture-repo/docs/${label}/`);
    expect(verdicts("docs/", "/fixture-repo/docs/")).toEqual({
      routed: ["/fixture-repo/docs/setup.html"],
      left: others("latest", "stable", "v0.2.0", "v0.1.0"),
    });
    expect(verdicts("docs/latest/", "/fixture-repo/docs/latest/")).toEqual({
      routed: ["/fixture-repo/docs/latest/", "/fixture-repo/docs/latest/setup.html"],
      left: others("stable", "v0.2.0", "v0.1.0"),
    });
    expect(verdicts("docs/stable/", "/fixture-repo/docs/stable/")).toEqual({
      routed: ["/fixture-repo/docs/stable/", "/fixture-repo/docs/stable/setup.html"],
      left: others("latest", "v0.2.0", "v0.1.0"),
    });
    expect(latestAssets).toContain("onBeforeRouteChange=");
  });

  test("renders every custom-block kind with its class and sentence-case title, and wraps each table as the one tab stop", () => {
    // vitepress's alert and container markup is what the theme's CSS targets (the title as the block's first
    // paragraph); a vitepress bump that moves it restyles every alert silently. The table wrapper is the theme's
    // renderer rule registered in config.mts; table_wrap.test installs the rule itself, so only the built page
    // shows the registration reached vitepress.
    const setup = readSite(site, "docs/latest/setup.html");
    expect(setup).toContain('<div class="vp-table" tabindex="0"><table>');
    expect(setup).not.toContain("<table tabindex");
    const alerts = readSite(site, "docs/latest/alerts.html");
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
    // shiki's `ansi` language and the CSS-variables theme, as the build emits them; the ansi palette has no unit
    // home.
    const alerts = readSite(site, "docs/latest/alerts.html");
    expect(alerts).toContain('style="color:var(--fleet-code-token-comment);"');
    expect(alerts).toContain('style="color:var(--fleet-code-ansi-red);"');
    expect(alerts).not.toContain("color:#000000");
    expect(alerts).not.toContain("shiki-dark");
  });

  test("renders a mermaid fence as the mount with its escaped source, and loads mermaid only from it", () => {
    // Only a real vite build shows which chunk holds mermaid and which pages preload it: the package is its own
    // chunk (mermaidAPI is its export, in nothing else), no page's HTML preloads or scripts it, and the theme
    // chunk that owns the mount reaches it by dynamic import alone.
    const alerts = readSite(site, "docs/latest/alerts.html");
    expect(alerts).toContain(MERMAID_MOUNT_HTML);
    expect(alerts).not.toContain("language-mermaid");
    const scripts = assetFiles(site, "docs/latest/assets").filter((file) =>
      file.name.endsWith(".js"),
    );
    const mermaidChunks = scripts.filter((file) => file.text.includes("mermaidAPI"));
    expect(mermaidChunks.length).toBeGreaterThan(0);
    const themeChunk = scripts.filter((file) => file.text.includes("fleet-mermaid-diagram"));
    expect(themeChunk).toHaveLength(1);
    expect(mermaidChunks.some((chunk) => themeChunk[0].text.includes(chunk.name))).toBe(true);
    for (const page of [latestIndex, alerts, readSite(site, "docs/latest/setup.html")]) {
      expect(mermaidChunks.filter((chunk) => page.includes(chunk.name))).toEqual([]);
    }
    expect(latestAssets).toContain(".fleet-mermaid{");
  });

  test("places the landing table's row and the sidebar's groups in the launcher, mounts its button on every other page, and orders the sidebar by landing, ranked group, table placement, unplaced, directory", () => {
    // The landing table and the sidebar both reaching the real page. The unit tests pin the order and the model
    // over hand-written input and mount the launcher component alone; the theme's slot and the rendered group
    // titles have no other home. The include roots sit among the directories under their title-cased mounts.
    expect(latestIndex).toContain('fleet-launcher-label">Set things up<');
    expect(readSite(site, "docs/latest/setup.html")).toContain('class="fleet-launcher-button"');
    expect(texts(latestIndex, ".VPSidebar .text")).toEqual([
      "Fixture",
      "Basics",
      "Zulu",
      "Delta",
      "Setup",
      "Alerts",
      "Bravo",
      "Guide",
      "Guide",
      "Skills",
      "Skills",
      "Agents",
      "One",
      "one",
      "Alpha",
      "Alpha skill",
      "Alpha reference",
      "Beta",
      "beta",
      "Gamma",
      "SKILL",
    ]);
    expect(texts(latestIndex, ".fleet-launcher-group-title")).toEqual([
      "Setup",
      "Zulu",
      "Delta",
      "Alerts",
      "Bravo",
      "Guide",
      "Skills",
      "Skills/Agents/One",
      "Skills/Alpha",
      "Skills/Beta",
      "Skills/Gamma",
    ]);
    expect(readSite(site, "docs/latest/delta.html")).not.toContain("group: Basics");
    expect(readSite(site, "docs/latest/zulu.html")).not.toContain("order: 1");
  });
});

describe("include roots inside the docs mount", () => {
  test("stages skills/ and agents/ per tier from the tier's own tree: a tag from before a root existed keeps its docs page at the mount's name with a notice, and the child mount lands inside its parent whichever the list named first", () => {
    // Per-tier staging of a root absent at some refs is a whole-run fact with no unit home (stageIncludes's unit
    // table pins HEAD's refusals). Staging order is the mount's depth, never the list's: a child staged first
    // would be refused as the skills mount's collision.
    const served = [
      "docs/latest/skills/index.html",
      "docs/latest/skills/alpha/index.html",
      "docs/latest/skills/alpha/reference.html",
      "docs/latest/skills/beta/index.html",
      "docs/latest/skills/agents/one/index.html",
      "docs/skills/alpha/index.html",
      "docs/v0.2.0/skills/alpha/index.html",
    ];
    expect(served.filter((rel) => !isFile(site, rel))).toEqual([]);
    expect(
      present(site, [
        "docs/latest/skills/alpha/SKILL.html",
        "docs/latest/skills/agents/one/AGENT.html",
        "docs/v0.2.0/skills/beta",
        "docs/v0.2.0/skills/agents",
        "docs/v0.1.0/skills/alpha",
      ]),
    ).toEqual([]);
    expect(readSite(site, "docs/v0.1.0/skills/index.html")).toContain("Skills, hand-written");
    // Tiers build latest, stable, the tags, then the root; within a tier the shallower mount stages first.
    const notice = (version: string, mount: string, path: string, ref: string) =>
      `::notice::docs version ${version} has no ${mount}/: ${path}/ does not exist at ${ref}`;
    expect(built.stdout.match(/^::notice::docs version \S+ has no .*$/gm)).toEqual([
      notice("stable", "skills/agents", "agents", "v0.2.0"),
      notice("v0.2.0", "skills/agents", "agents", "v0.2.0"),
      notice("v0.1.0", "skills", "skills", "v0.1.0"),
      notice("v0.1.0", "skills/agents", "agents", "v0.1.0"),
      notice("v0.2.0", "skills/agents", "agents", "v0.2.0"),
    ]);
  });

  test("titles and describes a skill from its frontmatter where it has no h1, sources and edit-links it at the repository path, and blob-links an unpublished file at the tier's ref", () => {
    // The edit-link and blob-link bases at the tier's ref are whole-run facts; the page title and description
    // rules have unit homes, the built <head> none.
    const alpha = readSite(site, "docs/latest/skills/alpha/index.html");
    const beta = readSite(site, "docs/latest/skills/beta/index.html");
    const gamma = readSite(site, "docs/latest/skills/gamma/index.html");
    expect([alpha, beta, gamma].map((page) => texts(page, "title"))).toEqual([
      ["Alpha skill | Fixture Docs"],
      ["beta | Fixture Docs"],
      // A blank name says nothing: the file name titles the document, as it titles the sidebar row.
      ["SKILL | Fixture Docs"],
    ]);
    expect(select(beta, 'meta[name="description"]').map((m) => m.attrs.content)).toEqual([
      "Beta does things.",
    ]);
    expect(alpha).toContain("Source: skills/alpha/SKILL.md");
    // A file the site never publishes reads on GitHub at the tier's ref; a directory link without its slash is
    // the directory URL.
    const blob = (ref: string) =>
      `https://github.com/fixture-owner/fixture-repo/blob/${ref}/skills/alpha/.codex-plugin/plugin.json`;
    expect(hrefs(alpha, ".vp-doc a")).toContain(blob("main"));
    expect(hrefs(alpha, ".vp-doc a")).toContain("./../beta/");
    expect(hrefs(readSite(site, "docs/v0.2.0/skills/alpha/index.html"), ".vp-doc a")).toContain(
      blob("v0.2.0"),
    );
    expect(hrefs(alpha, "a.edit-link-button")).toEqual([
      "https://github.com/fixture-owner/fixture-repo/edit/main/skills/alpha/SKILL.md",
    ]);
    expect(latestIndex).toContain("Source: docs/README.md");
    expect(hrefs(latestIndex, "a.edit-link-button")).toEqual([
      "https://github.com/fixture-owner/fixture-repo/edit/main/docs/README.md",
    ]);
    // A skill page is an article with its outline; the root's README is the section's landing page.
    expect(alpha).not.toContain('class="fleet-facts');
    expect(readSite(site, "docs/latest/skills/index.html")).toContain('class="fleet-facts');
  });

  test("serves the include pages at their directory URLs in the launcher's index, and links across the mounts in both directions", () => {
    // The sidebar carries the same URL, so the index is read alone. The skill links the agent and the agent the
    // skill in repository space; both resolve to the staged pages.
    expect(latestAssets).toContain('"url":"/fixture-repo/docs/latest/skills/beta/"');
    expect(latestAssets).not.toContain("skills/beta/SKILL.html");
    const skill = readSite(site, "docs/latest/skills/alpha/index.html");
    const agent = readSite(site, "docs/latest/skills/agents/one/index.html");
    expect(hrefs(skill, ".vp-doc a")).toContain("./../agents/one/");
    expect(hrefs(agent, ".vp-doc a")).toContain("./../../alpha/#install");
  });
});

describe("the link check over the whole artifact", () => {
  // A link from the website half into the docs mount has no judge but the check over the assembled artifact. The
  // build hands lychee its arguments and the action's next step runs it, so the failing run is reproduced here
  // with the step's own args, when the pinned lychee is on PATH.
  const lychee = pinnedLychee();

  test("lists the pages built from HEAD for lychee, the website's and latest/'s, a glob-named one as the pattern matching it alone, and never a tag tier's", () => {
    // The docs root and stable/ serve v0.2.0 here: a sealed dead link in history must not fail the deploy.
    const listed = linkCheckInputs(runner);
    expect(listed.filter((rel) => !rel.startsWith("docs/latest/")).sort()).toEqual([
      "[[]guide[]].html",
      "index.html",
    ]);
    expect(listed).toContain("docs/latest/index.html");
    expect(listed).toContain("docs/latest/skills/alpha/index.html");
    for (const rel of ["docs/index.html", "docs/stable/index.html", "docs/v0.1.0/index.html"]) {
      expect(listed).not.toContain(rel);
    }
  });

  test.skipIf(lychee === null)(
    "lychee, run as the step runs it, fails on the website's links into missing docs pages (the glob-named page's included) and the docs' link to a missing anchor, naming each",
    () => {
      const check = runLinkCheck(
        lychee ?? "",
        outputs(built.stdout)["link-check-args"],
        dirname(dirname(site)),
      );
      expect(check.exitCode, describeRun(check)).toBe(2);
      expect(check.stdout).toContain(`### Errors in ${site}/index.html`);
      expect(check.stdout).toMatch(
        new RegExp(
          `^\\* \\[ERROR\\] <file://${site}/docs/skills/missing> \\(at \\d+:\\d+\\) \\| File not found\\. Check if file exists and path is correct$`,
          "m",
        ),
      );
      expect(check.stdout).toContain(`### Errors in ${site}/docs/latest/index.html`);
      expect(check.stdout).toMatch(
        new RegExp(
          `^\\* \\[ERROR\\] <file://${site}/docs/latest/skills/alpha#nope> \\(at \\d+:\\d+\\) \\| Cannot find fragment$`,
          "m",
        ),
      );
      expect(check.stdout).toContain(`### Errors in ${site}/[guide].html`);
      expect(check.stdout).toContain(`<file://${site}/docs/skills/also-missing>`);
      expect(check.stdout.match(/^\* \[ERROR\]/gm)).toHaveLength(3);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("link strictness on HEAD", () => {
  test(
    "the dead link history seals lenient fails the deploy and the PR check on HEAD, naming it",
    () => {
      // Hardcoding strictness either way in the builder turns exactly one of the deploy runs the wrong color:
      // history cannot be fixed, HEAD can. pages-site.test reads the wiring as a value; only a build shows it armed.
      // A copy of the checkout, so the shared build's input stays as built.
      const rotten = temp.dir("pages-site-rotten-");
      cpSync(workspace, rotten, { recursive: true });
      const setup = join(rotten, "docs", "setup.md");
      writeFileSync(setup, `${readFileSync(setup, "utf-8")}\n${SEALED_DEAD_LINK}`);
      const deploy = buildSite(rotten, FLEET_REPO, runnerTemp(temp, FLEET_REPO), FLEET_ENV);
      const check = buildSite(rotten, FLEET_REPO, runnerTemp(temp, FLEET_REPO), {
        CHECK: "true",
        CONFIG: FLEET_ENV.CONFIG,
      });
      for (const result of [deploy, check]) {
        expect(result.exitCode, describeRun(result)).toBe(1);
        expect(result.stderr).toContain("missing-page");
      }
    },
    TEST_TIMEOUT_MS,
  );
});

describe("layouts that build no docs tier", () => {
  // docs/modules/site.md's two Layout rows a deploy settles without vitepress; the refused layouts are resolvePrebuilt's
  // and assertDocsLanding's unit tables.
  const NO_LINK_ROT = { "link-rot-label": "", "link-rot-color": "", "link-rot-description": "" };
  test.each<{
    layout: string;
    fixture: (repo: string) => void;
    env: Record<string, string>;
    pages: [string, string][];
    /** Paths under the site that must not exist; "." is the site directory itself. */
    absent: string[];
    stdout: string[];
    outputs: (runner: RunnerTemp) => Record<string, string>;
  }>([
    {
      layout:
        "website alone: one copy at the root, no version layout, the configured title verbatim",
      fixture: (repo) => {
        mkdirSync(join(repo, "dist"), { recursive: true });
        writeFileSync(
          join(repo, "dist", "index.html"),
          "<html><body>WEBSITE-ALONE</body></html>\n",
        );
        initRepo(repo);
        commitAll(repo, "site only");
      },
      env: { SITE_DIR: "dist" },
      pages: [["index.html", "WEBSITE-ALONE"]],
      absent: ["versions.json", "latest"],
      stdout: [],
      outputs: (runner) => ({
        ...NO_LINK_ROT,
        "publish": "true",
        "site-dir": runner.site,
        "link-check-args": deployLinkCheckArgs(runner, FLEET_REPO),
        "site-title": SITE_TITLE,
      }),
    },
    {
      layout:
        "neither a hook directory nor docs/: green, a notice, publish false, no site directory",
      fixture: (repo) => {
        writeFileSync(join(repo, "README.md"), "# Bare\n");
        initRepo(repo);
        commitAll(repo, "no site");
      },
      env: {},
      pages: [],
      absent: ["."],
      stdout: [
        "::notice::nothing to publish: the site-build hook named no directory and the repository has no docs/",
      ],
      outputs: () => ({
        ...NO_LINK_ROT,
        "publish": "false",
        "site-dir": "",
        "link-check-args": "",
        "site-title": SITE_TITLE,
      }),
    },
  ])("$layout", (row) => {
    const repo = temp.dir("pages-site-layout-");
    row.fixture(repo);
    const runner = runnerTemp(temp, FLEET_REPO);
    const result = buildSite(repo, FLEET_REPO, runner, row.env);
    expect(result.exitCode, describeRun(result)).toBe(0);
    expect(result.stdout).not.toMatch(/vitepress|building docs tier/);
    const missing = row.pages.filter(
      ([rel, text]) => !(isFile(runner.site, rel) && readSite(runner.site, rel).includes(text)),
    );
    expect(missing).toEqual([]);
    expect(present(runner.site, row.absent)).toEqual([]);
    for (const line of row.stdout) expect(result.stdout).toContain(line);
    expect(outputs(result.stdout)).toEqual(row.outputs(runner));
  });
});
