// The rendered diagrams in a real browser over a built site. Mermaid measures each html label
// in a container on <body> and clips the label's foreignObject to that measurement, while the
// page draws the SVG inside the article, so an article rule reaching a label, or a face that
// arrives after the measuring pass, cuts or shifts the drawn text. Headless Chrome (CHROME_BIN,
// else the platform's install) loads the fixture from a local server with the mono face served,
// held back until the pass is waiting on it, or refused, and every label must end inside its
// foreignObject and its node's shape each time, the held page ending in the served page's
// geometry. The browser harness is headless_chrome.ts.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SHARED_TOKENS } from "../../../actions/pages-site/.vitepress/theme/tokens.ts";
import {
  buildSite,
  commitAll,
  describeRun,
  initRepo,
  runnerTemp,
  siteConfig,
  TEST_TIMEOUT_MS,
} from "../../ci/pages_site_build/fixtures.ts";
import { harnessBound } from "../../shared/harness_bound.ts";
import { tempDirs } from "../../shared/temp_dir.ts";
import { Chrome, serve, Tab } from "./headless_chrome.ts";

const REPOSITORY = "fixture-owner/fixture-repo";
const PAGE = "/fixture-repo/latest/";
const FONT = `${SHARED_TOKENS.code["--vp-code-font-size"]} ${SHARED_TOKENS.fonts["--vp-font-family-mono"]}`;
const SCENARIO_TIMEOUT_MS = harnessBound(60_000);

/** The reported node (its second line wraps into a third at mermaid's
 *  wrapping width), then the flowchart it was reported in. */
const DOCS_MD = `# Fixture

\`\`\`mermaid
flowchart TD
  fold["src/engine/layers.ts<br>stripNulls() mergeLayers()"]
  one["one line"]
  two["two<br>lines"]
  one --> fold --> two
\`\`\`

\`\`\`mermaid
flowchart TD
  read["src/flows/settings-read.ts<br>readSettingsFile()"]
  mode{"mode"}
  fold["src/engine/layers.ts<br>stripNulls() mergeLayers()"]
  validate["src/engine/orchestrate.ts<br>validateSettingsDoc()"]
  merged["merged-file"]
  repo["src/engine/orchestrate.ts<br>runForRepo()"]
  plan["each section plans<br>src/sections/contract/plan.ts planContext() SectionPlan<br>src/engine/diff.ts deltas()"]
  read -->|YAML text, parsed to an unknown document per file| mode
  mode -->|merge: every layer, each validated on its own first| fold
  fold -->|one folded document, a notice per null opt-out| validate
  mode -->|check or apply: the one file| validate
  validate -->|ValidatedSettings, in merge mode| merged
  validate -->|ValidatedSettings, in check or apply| repo
  repo -->|the declared value of each active section| plan
\`\`\`
`;

interface Label {
  text: string;
  lines: number;
  width: number;
  height: number;
}

interface Settled {
  states: string[];
  faceLoaded: boolean;
  overflowing: string[];
  foldLines: number;
  labels: Label[];
  faceReadyAtRender: boolean;
}

/** Installed before any page script: records whether the mono face was
 *  usable at the moment the first mount reported a state. */
const TIMELINE_SCRIPT = `(() => {
  const timeline = { faceReadyAtRender: null };
  window.__fleetTimeline = timeline;
  new MutationObserver(() => {
    if (timeline.faceReadyAtRender === null && document.querySelector(".fleet-mermaid[data-state]")) {
      timeline.faceReadyAtRender = document.fonts.check(${JSON.stringify(FONT)});
    }
  }).observe(document, { subtree: true, attributes: true, attributeFilter: ["data-state"] });
})()`;

const WHEN_SETTLED = `new Promise((resolve) => {
  const settled = () => {
    const mounts = [...document.querySelectorAll(".fleet-mermaid")];
    return mounts.length > 0 && mounts.every((mount) => mount.dataset.state !== undefined);
  };
  if (settled()) return resolve(true);
  new MutationObserver((_, observer) => {
    if (!settled()) return;
    observer.disconnect();
    resolve(true);
  }).observe(document, { subtree: true, attributes: true, attributeFilter: ["data-state"] });
})`;

/** Resolves once the mermaid chunk has been fetched: the pass is then past
 *  its import and, with the face held, waiting on it. */
const WHEN_MERMAID_FETCHED = `new Promise((resolve) => {
  const fetched = () =>
    performance.getEntriesByType("resource").some((entry) => /mermaid/.test(entry.name));
  if (fetched()) return resolve(true);
  new PerformanceObserver((_, observer) => {
    if (!fetched()) return;
    observer.disconnect();
    resolve(true);
  }).observe({ type: "resource", buffered: true });
})`;

const MEASURE = `(() => {
  const round = (n) => Math.round(n * 10) / 10;
  const mounts = [...document.querySelectorAll(".fleet-mermaid")];
  const overflowing = [];
  const labels = [];
  let foldLines = 0;
  for (const mount of mounts) {
    for (const frame of mount.querySelectorAll("svg foreignObject")) {
      const owner = frame.closest("g.node, g.edgeLabel");
      const drawn = frame.firstElementChild;
      const text = drawn.textContent.trim();
      const box = frame.getBoundingClientRect();
      const ink = drawn.getBoundingClientRect();
      const past = [];
      if (ink.bottom - box.bottom > 0.5) past.push("foreignObject bottom by " + round(ink.bottom - box.bottom));
      if (ink.right - box.right > 0.5) past.push("foreignObject right by " + round(ink.right - box.right));
      if (owner?.classList.contains("node")) {
        const shape = [...owner.children].find((child) => !child.classList.contains("label"));
        const edge = shape.getBoundingClientRect();
        if (ink.bottom - edge.bottom > 0.5) past.push("shape bottom by " + round(ink.bottom - edge.bottom));
        if (ink.right - edge.right > 0.5) past.push("shape right by " + round(ink.right - edge.right));
        const lines = Math.round(ink.height / parseFloat(getComputedStyle(drawn.querySelector("p") ?? drawn).lineHeight));
        labels.push({ text, lines, width: round(edge.width), height: round(edge.height) });
        if (text === "src/engine/layers.tsstripNulls() mergeLayers()") foldLines = Math.max(foldLines, lines);
      }
      if (past.length > 0) overflowing.push(text + ": past " + past.join(", "));
    }
  }
  const timeline = window.__fleetTimeline;
  return {
    states: mounts.map((mount) => mount.dataset.state ?? "none"),
    faceLoaded: document.fonts.check(${JSON.stringify(FONT)}),
    overflowing,
    foldLines,
    labels,
    faceReadyAtRender: timeline.faceReadyAtRender === true,
  };
})()`;

/** The face requests routed per `fonts`: served untouched, refused failed, held parked until `release`, after
 *  which later ones pass straight through. */
async function interceptFaces(
  chrome: Chrome,
  tab: Tab,
  fonts: "held" | "refused",
): Promise<{ requested: Promise<void>; release(): Promise<void> }> {
  const held: string[] = [];
  let released = false;
  let requested!: () => void;
  const firstRequest = new Promise<void>((resolve) => {
    requested = resolve;
  });
  chrome.on("Fetch.requestPaused", (params, session) => {
    if (session !== tab.sessionId) return;
    const requestId = params.requestId as string;
    if (fonts === "refused") {
      void tab.send("Fetch.failRequest", { requestId, errorReason: "Failed" });
    } else if (released) {
      void tab.send("Fetch.continueRequest", { requestId });
    } else {
      held.push(requestId);
    }
    requested();
  });
  await tab.send("Fetch.enable", {
    patterns: [{ urlPattern: "*.woff2", requestStage: "Request" }],
  });
  return {
    requested: firstRequest,
    async release() {
      released = true;
      for (const requestId of held.splice(0)) {
        await tab.send("Fetch.continueRequest", { requestId });
      }
    },
  };
}

let chrome: Chrome | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;

// Registered before tempDirs() so Chrome is gone before its profile directory is removed.
afterAll(async () => {
  await chrome?.close();
  server?.stop(true);
}, harnessBound(15_000));
const temp = tempDirs();

beforeAll(async () => {
  const workspace = temp.dir("mermaid-labels-fixture-");
  mkdirSync(join(workspace, "docs"));
  writeFileSync(join(workspace, "docs", "README.md"), DOCS_MD);
  writeFileSync(join(workspace, "README.md"), "# fixture\n");
  initRepo(workspace);
  commitAll(workspace, "fixture");
  const runner = runnerTemp(temp, REPOSITORY);
  const result = buildSite(workspace, REPOSITORY, runner, {
    CONFIG: siteConfig({ site_title: "Fixture" }),
  });
  if (result.exitCode !== 0) throw new Error(`the fixture build failed: ${describeRun(result)}`);
  server = serve(runner.site, "/fixture-repo");
  chrome = await Chrome.launch(temp.dir("mermaid-labels-chrome-"));
}, TEST_TIMEOUT_MS);

async function settle(fonts: "served" | "held" | "refused"): Promise<Settled> {
  const tab = await Tab.open(chrome!, TIMELINE_SCRIPT);
  const faces = fonts === "served" ? null : await interceptFaces(chrome!, tab, fonts);
  try {
    await tab.navigate(`http://127.0.0.1:${server!.port}${PAGE}`);
    if (faces !== null && fonts === "held") {
      await faces.requested;
      await tab.evaluate(WHEN_MERMAID_FETCHED);
      await faces.release();
    }
    await tab.evaluate(WHEN_SETTLED);
    return await tab.evaluate<Settled>(MEASURE);
  } finally {
    await tab.close();
  }
}

test(
  "every label ends inside its foreignObject and shape, in the mono face once it arrives and in the fallback when it never does",
  async () => {
    const served = await settle("served");
    expect(served).toEqual({
      states: ["rendered", "rendered"],
      faceLoaded: true,
      overflowing: [],
      foldLines: 3,
      labels: served.labels,
      faceReadyAtRender: true,
    });
    expect(served.labels.length).toBeGreaterThanOrEqual(10);
    const held = await settle("held");
    expect(held).toEqual({ ...served });
    const refused = await settle("refused");
    expect(refused).toEqual({
      states: ["rendered", "rendered"],
      faceLoaded: false,
      overflowing: [],
      foldLines: 3,
      labels: refused.labels,
      faceReadyAtRender: false,
    });
  },
  SCENARIO_TIMEOUT_MS,
);
