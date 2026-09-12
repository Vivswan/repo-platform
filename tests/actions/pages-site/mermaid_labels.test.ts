// The rendered diagrams in a real browser over a built site. Mermaid measures each html label
// in a container on <body> and clips the label's foreignObject to that measurement, while the
// page draws the SVG inside the article, so an article rule reaching a label, or a face that
// arrives after the measuring pass, cuts or shifts the drawn text. Headless Chrome (CHROME_BIN,
// else the platform's install) loads the fixture from a local server with the mono face served,
// held back until the pass is waiting on it, or refused, and every label must end inside its
// foreignObject and its node's shape each time, the held page ending in the served page's
// geometry.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
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
import { tempDirs } from "../../shared/temp_dir.ts";

const REPOSITORY = "fixture-owner/fixture-repo";
const PAGE = "/fixture-repo/latest/";
const FONT = `${SHARED_TOKENS.code["--vp-code-font-size"]} ${SHARED_TOKENS.fonts["--vp-font-family-mono"]}`;
const SCENARIO_TIMEOUT_MS = 60_000;

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

/** What a loaded page settled into: the mount states, whether the mono face
 *  is usable, the label of every node and edge that overflows its
 *  foreignObject or its node's shape (with the amounts), the reported
 *  node's line count, each node's drawn size, and whether the mono face
 *  was already usable when the first render landed. */
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
    for (const fo of mount.querySelectorAll("svg foreignObject")) {
      const owner = fo.closest("g.node, g.edgeLabel");
      const drawn = fo.firstElementChild;
      const text = drawn.textContent.trim();
      const box = fo.getBoundingClientRect();
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

function chromePath(): string {
  const found = [
    process.env.CHROME_BIN,
    ...["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].map((name) =>
      Bun.which(name),
    ),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].find((path): path is string => typeof path === "string" && path !== "" && existsSync(path));
  if (found === undefined) {
    throw new Error("no Chrome or Chromium found: set CHROME_BIN to the executable");
  }
  return found;
}

interface Message {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
  result?: Record<string, unknown>;
  error?: { message: string };
}

type Listener = (params: Record<string, unknown>, sessionId: string | undefined) => void;

/** Chrome over its DevTools protocol: one browser socket, flat sessions. */
class Chrome {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (result: Record<string, unknown>) => void; reject: (error: Error) => void }
  >();
  private readonly listeners = new Map<string, Set<Listener>>();

  private constructor(
    private readonly process: Subprocess<"ignore", "ignore", "pipe">,
    private readonly socket: WebSocket,
  ) {
    socket.addEventListener("message", (event) => {
      const message: Message = JSON.parse(String(event.data));
      if (message.id !== undefined) {
        const waiter = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) waiter?.reject(new Error(message.error.message));
        else waiter?.resolve(message.result ?? {});
        return;
      }
      for (const listener of this.listeners.get(message.method ?? "") ?? []) {
        listener(message.params ?? {}, message.sessionId);
      }
    });
  }

  static async launch(userDataDir: string): Promise<Chrome> {
    const process = Bun.spawn(
      [
        chromePath(),
        "--headless=new",
        "--remote-debugging-port=0",
        `--user-data-dir=${userDataDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-gpu",
        "--hide-scrollbars",
        "--window-size=1400,1200",
        "about:blank",
      ],
      { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
    );
    // Chrome is owned from the spawn on: a launch that fails past it must not leave it running.
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let text = "";
        const decoder = new TextDecoder();
        void (async () => {
          for await (const chunk of process.stderr) {
            text += decoder.decode(chunk, { stream: true });
            const match = /DevTools listening on (ws:\/\/\S+)/.exec(text);
            if (match !== null) resolve(match[1]);
          }
          reject(new Error(`chrome exited before announcing its DevTools socket:\n${text}`));
        })();
      });
      const socket = new WebSocket(url);
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve());
        socket.addEventListener("error", () => reject(new Error(`no DevTools socket at ${url}`)));
      });
      return new Chrome(process, socket);
    } catch (error) {
      process.kill("SIGKILL");
      await process.exited;
      throw error;
    }
  }

  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  on(method: string, listener: Listener): void {
    const set = this.listeners.get(method) ?? new Set();
    set.add(listener);
    this.listeners.set(method, set);
  }

  async close(): Promise<void> {
    void this.send("Browser.close").catch(() => undefined);
    const exited = await Promise.race([this.process.exited, Bun.sleep(5_000).then(() => null)]);
    if (exited === null) {
      this.process.kill("SIGKILL");
      await this.process.exited;
    }
    this.socket.close();
  }
}

/** A fresh tab with the timeline recorder installed and the face requests
 *  routed per `fonts`: served untouched, refused failed, held parked until
 *  `releaseFaces`, after which later ones pass straight through. */
class Tab {
  private readonly heldFaces: string[] = [];
  private released = false;
  private faceRequested!: () => void;
  readonly faceRequest = new Promise<void>((resolve) => {
    this.faceRequested = resolve;
  });

  private constructor(
    private readonly chrome: Chrome,
    private readonly sessionId: string,
    private readonly targetId: string,
  ) {}

  static async open(chrome: Chrome, fonts: "served" | "held" | "refused"): Promise<Tab> {
    const { targetId } = (await chrome.send("Target.createTarget", { url: "about:blank" })) as {
      targetId: string;
    };
    const { sessionId } = (await chrome.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    })) as { sessionId: string };
    const tab = new Tab(chrome, sessionId, targetId);
    await chrome.send("Page.enable", {}, sessionId);
    await chrome.send(
      "Page.addScriptToEvaluateOnNewDocument",
      { source: TIMELINE_SCRIPT },
      sessionId,
    );
    if (fonts !== "served") {
      chrome.on("Fetch.requestPaused", (params, session) => {
        if (session !== sessionId) return;
        const requestId = params.requestId as string;
        if (fonts === "refused") {
          void chrome.send("Fetch.failRequest", { requestId, errorReason: "Failed" }, sessionId);
        } else if (tab.released) {
          void chrome.send("Fetch.continueRequest", { requestId }, sessionId);
        } else {
          tab.heldFaces.push(requestId);
        }
        tab.faceRequested();
      });
      await chrome.send(
        "Fetch.enable",
        { patterns: [{ urlPattern: "*.woff2", requestStage: "Request" }] },
        sessionId,
      );
    }
    return tab;
  }

  navigate(url: string): Promise<Record<string, unknown>> {
    return this.chrome.send("Page.navigate", { url }, this.sessionId);
  }

  async evaluate<T>(expression: string): Promise<T> {
    const { result, exceptionDetails } = (await this.chrome.send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      this.sessionId,
    )) as { result: { value: T }; exceptionDetails?: { text: string } };
    if (exceptionDetails !== undefined)
      throw new Error(`page script failed: ${exceptionDetails.text}`);
    return result.value;
  }

  async releaseFaces(): Promise<void> {
    this.released = true;
    for (const requestId of this.heldFaces.splice(0)) {
      await this.chrome.send("Fetch.continueRequest", { requestId }, this.sessionId);
    }
  }

  close(): Promise<Record<string, unknown>> {
    return this.chrome.send("Target.closeTarget", { targetId: this.targetId });
  }
}

let chrome: Chrome | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;

// Registered before tempDirs() so Chrome is gone before its profile directory is removed.
afterAll(async () => {
  await chrome?.close();
  server?.stop(true);
}, 15_000);
const temp = tempDirs();

/** The site as Pages would serve it: the repository's base stripped, a
 *  directory to its index. */
function serve(site: string): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: 0,
    fetch(request) {
      const path = decodeURIComponent(new URL(request.url).pathname).replace(/^\/fixture-repo/, "");
      let file = join(site, path);
      if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
      if (!existsSync(file)) return new Response("not found", { status: 404 });
      return new Response(Bun.file(file));
    },
  });
}

beforeAll(async () => {
  const workspace = temp.dir("mermaid-labels-fixture-");
  mkdirSync(join(workspace, "docs"));
  writeFileSync(join(workspace, "docs", "README.md"), DOCS_MD);
  writeFileSync(join(workspace, "README.md"), "# fixture\n");
  initRepo(workspace);
  commitAll(workspace, "fixture");
  const runner = runnerTemp(temp);
  const result = buildSite(workspace, REPOSITORY, runner, {
    CONFIG: siteConfig({ site_title: "Fixture" }),
  });
  if (result.exitCode !== 0) throw new Error(`the fixture build failed: ${describeRun(result)}`);
  server = serve(runner.site);
  chrome = await Chrome.launch(temp.dir("mermaid-labels-chrome-"));
}, TEST_TIMEOUT_MS);

async function settle(fonts: "served" | "held" | "refused"): Promise<Settled> {
  const tab = await Tab.open(chrome!, fonts);
  try {
    await tab.navigate(`http://127.0.0.1:${server!.port}${PAGE}`);
    if (fonts === "held") {
      await tab.faceRequest;
      await tab.evaluate(WHEN_MERMAID_FETCHED);
      await tab.releaseFaces();
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
