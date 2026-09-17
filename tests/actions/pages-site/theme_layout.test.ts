// The theme's layout in a real browser over a built site (the harness is headless_chrome.ts): the diagram view a
// reader opens from a rendered mermaid mount, the lightbox an article image opens, and the width a prose cell keeps
// beside a long inline-code cell. All are browser facts no unit render can show: the view's natural size against the
// scaled-down column copy, focus and scroll lock across a native dialog, a lightbox finishing under reduced motion,
// and the table's auto layout distributing a scroll wrapper's width.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
const BASE = "/fixture-repo";
const PAGE = `${BASE}/latest/`;
const SCENARIO_TIMEOUT_MS = harnessBound(60_000);
const REM = 16;

/** Twelve chained nodes draw far wider than the reading column, so the column copy is scaled down. */
const DIAGRAM = [
  "```mermaid",
  "flowchart LR",
  ...Array.from({ length: 12 }, (_, i) => `  n${i}["src/engine/module-${i}.ts stepOf(${i})"]`),
  `  ${Array.from({ length: 12 }, (_, i) => `n${i}`).join(" --> ")}`,
  "```",
].join("\n");

/** The reported shape: a 90-character code token beside twelve words of prose. */
const LONG_TOKEN =
  "error[E0433]: failed to resolve: use of undeclared crate or module edges in an import path";
const PROSE = "Move the import, or add the edge under the section declaring it.";
const CRUSH_TABLE = ["| Message | Fix |", "|---|---|", `| \`${LONG_TOKEN}\` | ${PROSE} |`].join(
  "\n",
);

/** Six code columns, each a whole token, so the table can only overflow the column. */
const WIDE_TABLE = [
  `| ${Array.from({ length: 6 }, (_, i) => `Column ${i}`).join(" | ")} |`,
  `|${"---|".repeat(6)}`,
  `| ${Array.from({ length: 6 }, (_, i) => `\`src/sections/contract/plan-${i}.ts\``).join(" | ")} |`,
].join("\n");

/** A 1600px picture in a 648px column, so the lightbox has room to grow; the linked one stays its link's. */
const PICTURE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000" viewBox="0 0 1600 1000">' +
  '<rect width="1600" height="1000" fill="#345"/><circle cx="800" cy="500" r="300" fill="#fc6"/></svg>\n';
const IMAGES_MD =
  "![A picture](picture.svg)\n\n" +
  '<a href="./other.html"><picture><img src="./picture.svg" alt="A linked picture"></picture></a>\n\n' +
  "![A second picture](picture.svg)";

const DOCS_MD = `# Fixture\n\n${DIAGRAM}\n\n${IMAGES_MD}\n\n${CRUSH_TABLE}\n\n${WIDE_TABLE}\n`;
/** A second page with no diagram, one history step away. */
const OTHER_MD = "# Other\n\nNo diagram here.\n";

const WHEN_RENDERED = `new Promise((resolve) => {
  const settled = () => document.querySelector(".fleet-mermaid")?.dataset.state === "rendered";
  if (settled()) return resolve(true);
  new MutationObserver((_, observer) => {
    if (!settled()) return;
    observer.disconnect();
    resolve(true);
  }).observe(document, { subtree: true, attributes: true, attributeFilter: ["data-state"] });
})`;

/** Page-side probes shared by the steps of the view test. Panzoom writes its transform on the next animation frame,
 *  so every measurement waits one out. */
const PROBES = `(() => {
  const round = (n) => Math.round(n * 10) / 10;
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const view = () => document.querySelector("dialog.fleet-mermaid-view");
  const viewSvg = () => view().querySelector("svg");
  const columnSvg = () => document.querySelector(".fleet-mermaid > .fleet-mermaid-diagram > svg");
  const bar = (text) => [...view().querySelectorAll("button")].find((b) => b.textContent === text);
  window.__probe = {
    async open() {
      const button = document.querySelector(".fleet-mermaid > button.fleet-mermaid-zoom");
      const column = columnSvg().getBoundingClientRect().width;
      button.focus();
      button.click();
      await frame();
      const rect = viewSvg().getBoundingClientRect();
      const viewBox = viewSvg().getAttribute("viewBox").split(/[\\s,]+/).map(Number);
      const stage = view().querySelector(".fleet-mermaid-view-stage").getBoundingClientRect();
      return {
        label: button.getAttribute("aria-label"),
        open: view().open,
        column: round(column),
        natural: round(rect.width),
        viewBox: viewBox[2],
        locked: getComputedStyle(document.documentElement).overflow,
        focusInside: view().contains(document.activeElement),
        stage: { x: stage.left, y: stage.top, width: stage.width, height: stage.height },
      };
    },
    async width() { await frame(); return round(viewSvg().getBoundingClientRect().width); },
    async corner() { await frame(); const r = viewSvg().getBoundingClientRect(); return [round(r.left), round(r.top)]; },
    async press(text) { bar(text).click(); return window.__probe.width(); },
    pageWheel() {
      const stage = view().querySelector(".fleet-mermaid-view-stage");
      const rect = stage.getBoundingClientRect();
      stage.dispatchEvent(new WheelEvent("wheel", {
        deltaY: -1, deltaMode: WheelEvent.DOM_DELTA_PAGE, cancelable: true, bubbles: true,
        clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
      }));
      return window.__probe.width();
    },
    focusStage() { view().querySelector(".fleet-mermaid-view-stage").focus(); return document.activeElement.className; },
    ids() { return { column: columnSvg().id, view: viewSvg().id, open: view().open }; },
    closed() {
      return {
        open: view().open,
        focusOnOpener: document.activeElement === document.querySelector(".fleet-mermaid-zoom"),
        locked: getComputedStyle(document.documentElement).overflow,
      };
    },
  };
  return true;
})()`;

const WHEN_REDRAWN = (previous: string) => `new Promise((resolve) => {
  const redrawn = () => {
    const svg = document.querySelector(".fleet-mermaid > .fleet-mermaid-diagram > svg");
    return svg !== null && svg.id !== ${JSON.stringify(previous)};
  };
  if (redrawn()) return resolve(true);
  new MutationObserver((_, observer) => {
    if (!redrawn()) return;
    observer.disconnect();
    resolve(true);
  }).observe(document, { subtree: true, childList: true });
})`;

/** Resolves once the page's h1 starts with `title` (its anchor follows): VitePress swapped the content in. */
const WHEN_TITLED = (title: string) => `new Promise((resolve) => {
  const titled = () => document.querySelector("h1")?.textContent.startsWith(${JSON.stringify(title)}) === true;
  if (titled()) return resolve(true);
  new MutationObserver((_, observer) => {
    if (!titled()) return;
    observer.disconnect();
    resolve(true);
  }).observe(document, { subtree: true, childList: true, characterData: true });
})`;

interface Column {
  wrapper: number;
  cells: number[];
  codeLines: number;
  scrolls: boolean;
}

/** On paper nothing scrolls, so every wrapped table must fit its wrapper. */
const MEASURE_PRINT = `[...document.querySelectorAll(".vp-doc .vp-table")].map((wrapper) =>
  wrapper.querySelector("table").getBoundingClientRect().width <= wrapper.getBoundingClientRect().width + 1
)`;

const MEASURE_TABLES = `(() => {
  const round = (n) => Math.round(n * 10) / 10;
  return [...document.querySelectorAll(".vp-doc .vp-table")].map((wrapper) => {
    const row = wrapper.querySelector("tbody tr");
    const code = row.querySelector("code");
    return {
      wrapper: round(wrapper.getBoundingClientRect().width),
      cells: [...row.children].map((cell) => round(cell.getBoundingClientRect().width)),
      codeLines: Math.round(code.getBoundingClientRect().height / parseFloat(getComputedStyle(code).lineHeight)),
      scrolls: wrapper.scrollWidth > wrapper.clientWidth + 1,
    };
  });
})()`;

let chrome: Chrome | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;

// Registered before tempDirs() so Chrome is gone before its profile directory is removed.
afterAll(async () => {
  await chrome?.close();
  server?.stop(true);
}, harnessBound(15_000));
const temp = tempDirs();

beforeAll(async () => {
  const workspace = temp.dir("theme-layout-fixture-");
  mkdirSync(join(workspace, "docs"));
  writeFileSync(join(workspace, "docs", "README.md"), DOCS_MD);
  writeFileSync(join(workspace, "docs", "other.md"), OTHER_MD);
  writeFileSync(join(workspace, "docs", "picture.svg"), PICTURE_SVG);
  writeFileSync(join(workspace, "README.md"), "# fixture\n");
  initRepo(workspace);
  commitAll(workspace, "fixture");
  const runner = runnerTemp(temp, REPOSITORY);
  const result = buildSite(workspace, REPOSITORY, runner, {
    CONFIG: siteConfig({ site_title: "Fixture" }),
  });
  if (result.exitCode !== 0) throw new Error(`the fixture build failed: ${describeRun(result)}`);
  server = serve(runner.site, BASE);
  chrome = await Chrome.launch(temp.dir("theme-layout-chrome-"));
}, TEST_TIMEOUT_MS);

/** Carbon's config starts every site dark and VitePress stores that choice, so the system preference reaches the
 *  page only for a reader whose stored choice is `auto` (what VitePress stores when a toggle lands on the system's
 *  own mode). The view test starts as that reader on a light system, whatever the host prefers. */
const FOLLOW_SYSTEM = 'localStorage.setItem("vitepress-theme-appearance", "auto")';

function preferScheme(tab: Tab, value: "light" | "dark"): Promise<Record<string, unknown>> {
  return tab.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value }],
  });
}

async function openPage(followSystem: "light" | null = null): Promise<Tab> {
  const tab = await Tab.open(chrome!, followSystem === null ? undefined : FOLLOW_SYSTEM);
  if (followSystem !== null) await preferScheme(tab, followSystem);
  await tab.navigate(`http://127.0.0.1:${server!.port}${PAGE}`);
  await tab.evaluate(WHEN_RENDERED);
  return tab;
}

// A synthetic click on the button is the reader's; the wheel, the drag, and Escape go through the browser's input
// path, which is what decides whether the stage's listener, the pointer capture, and the dialog's cancel see them.
test(
  "the zoom button opens the diagram at its natural size in a modal view that zooms and pans by wheel, drag, and keys, follows a theme flip, and hands focus back on Escape",
  async () => {
    const tab = await openPage("light");
    try {
      await tab.evaluate(PROBES);
      const opened = await tab.evaluate<{
        label: string;
        open: boolean;
        column: number;
        natural: number;
        viewBox: number;
        locked: string;
        focusInside: boolean;
        stage: { x: number; y: number; width: number; height: number };
      }>("window.__probe.open()");
      expect(opened).toEqual({
        label: "Zoom the diagram",
        open: true,
        column: opened.column,
        natural: opened.viewBox,
        viewBox: opened.viewBox,
        locked: "hidden",
        focusInside: true,
        stage: opened.stage,
      });
      expect(opened.natural).toBeGreaterThan(opened.column * 2);

      const zoomedIn = await tab.evaluate<number>('window.__probe.press("Zoom in")');
      const zoomedOut = await tab.evaluate<number>('window.__probe.press("Zoom out")');
      const reset = await tab.evaluate<number>('window.__probe.press("Reset")');
      expect(zoomedIn).toBeGreaterThan(opened.natural);
      expect(zoomedOut).toBeLessThan(zoomedIn);
      expect(reset).toBe(opened.natural);

      const { stage } = opened;
      const center = { x: stage.x + stage.width / 2, y: stage.y + stage.height / 2 };
      await tab.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        ...center,
        deltaX: 0,
        deltaY: -120,
      });
      const wheeled = await tab.evaluate<number>("window.__probe.width()");
      expect(wheeled).toBeGreaterThan(reset);

      const before = await tab.evaluate<[number, number]>("window.__probe.corner()");
      await tab.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        ...center,
        button: "left",
        buttons: 1,
        clickCount: 1,
      });
      await tab.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: center.x + 100,
        y: center.y + 50,
        button: "left",
        buttons: 1,
      });
      await tab.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: center.x + 100,
        y: center.y + 50,
        button: "left",
        clickCount: 1,
      });
      const after = await tab.evaluate<[number, number]>("window.__probe.corner()");
      expect([after[0] - before[0], after[1] - before[1]]).toEqual([100, 50]);

      // A notch is a notch: a page-unit wheel zooms exactly as far as the 120px pixel-unit one did.
      const pageWheeled = await tab.evaluate<number>("window.__probe.pageWheel()");
      expect(pageWheeled / wheeled).toBeCloseTo(wheeled / reset, 2);

      // Without a pointer the stage takes focus and the arrows scroll it (right reveals the right side, so the
      // copy shifts left); minus zooms out. ARIA lets no name onto a generic element, so the stage's key
      // instructions reach assistive technology only under a role that takes one.
      expect(await tab.evaluate<string>("window.__probe.focusStage()")).toBe(
        "fleet-mermaid-view-stage",
      );
      const stageNode = await tab.accessibleNode(".fleet-mermaid-view-stage");
      expect(stageNode.role).not.toBe("generic");
      expect(stageNode.name).toMatch(/arrow keys/);
      const beforeKeys = await tab.evaluate<[number, number]>("window.__probe.corner()");
      await tab.press("ArrowRight", 39);
      const afterKeys = await tab.evaluate<[number, number]>("window.__probe.corner()");
      expect(afterKeys[0]).toBeLessThan(beforeKeys[0]);
      expect(afterKeys[1]).toBe(beforeKeys[1]);
      await tab.press("-", 189);
      expect(await tab.evaluate<number>("window.__probe.width()")).toBeLessThan(pageWheeled);
      // A chord stays the browser's (Alt+ArrowLeft is Back), so it moves nothing.
      const beforeChord = await tab.evaluate<[number, number]>("window.__probe.corner()");
      await tab.press("ArrowLeft", 37, 1);
      expect(await tab.evaluate<[number, number]>("window.__probe.corner()")).toEqual(beforeChord);

      // The system appearance flipping under an open view: the pass redraws the mount, and the view follows.
      const ids = await tab.evaluate<{ column: string; view: string }>("window.__probe.ids()");
      expect(ids.view).toBe(ids.column);
      const beforeFlip = await tab.evaluate<number>("window.__probe.width()");
      await preferScheme(tab, "dark");
      await tab.evaluate(WHEN_REDRAWN(ids.column));
      const flipped = await tab.evaluate<{ column: string; view: string; open: boolean }>(
        "window.__probe.ids()",
      );
      expect(flipped).toEqual({ column: flipped.column, view: flipped.column, open: true });
      expect(flipped.column).not.toBe(ids.column);
      expect(await tab.evaluate<number>("window.__probe.width()")).toBe(beforeFlip);

      await tab.press("Escape", 27);
      expect(await tab.evaluate<Record<string, unknown>>("window.__probe.closed()")).toEqual({
        open: false,
        focusOnOpener: true,
        locked: "visible",
      });
    } finally {
      await tab.close();
    }
  },
  SCENARIO_TIMEOUT_MS,
);

// The view is appended to <body>, outside the content VitePress swaps on a route change, so a reader who leaves the
// page through history (the browser's Back or Forward, which the modal cannot make inert) would otherwise keep the
// old diagram over the new page with its scroll locked.
test(
  "the view closes when the reader leaves its page through history",
  async () => {
    const tab = await openPage();
    try {
      await tab.evaluate("document.querySelector('a[href*=\"other\"]').click()");
      await tab.evaluate(WHEN_TITLED("Other"));
      await tab.evaluate("history.back()");
      await tab.evaluate(WHEN_TITLED("Fixture"));
      await tab.evaluate(WHEN_RENDERED);
      await tab.evaluate(PROBES);
      expect(await tab.evaluate<{ open: boolean }>("window.__probe.open()")).toMatchObject({
        open: true,
      });
      await tab.evaluate("history.forward()");
      await tab.evaluate(WHEN_TITLED("Other"));
      expect(await tab.evaluate<Record<string, unknown>>("window.__probe.closed()")).toMatchObject({
        open: false,
        locked: "visible",
      });
    } finally {
      await tab.close();
    }
  },
  SCENARIO_TIMEOUT_MS,
);

interface Lightbox {
  inline: number;
  zoomed: number;
  opened: boolean;
  overlay: { color: string; opacity: string };
  /** What a click on the nav bar's title would hit: the lightbox, or the nav still above it. */
  atNavCorner: string;
  linkedAttached: boolean;
  /** On paper, with the lightbox open, whether the original image still shows. */
  printedOriginal: string;
}

/** Opens the first article image and measures once medium-zoom reports the open finished. */
const OPEN_LIGHTBOX = `new Promise((resolve) => {
  const img = document.querySelector(".vp-doc :not(a) > img");
  const inline = img.getBoundingClientRect().width;
  img.addEventListener("medium-zoom:opened", () => {
    const zoomed = document.querySelector(".medium-zoom-image--opened");
    const overlay = getComputedStyle(document.querySelector(".medium-zoom-overlay"));
    resolve({
      inline: Math.round(inline),
      zoomed: Math.round(zoomed.getBoundingClientRect().width),
      opened: document.body.classList.contains("medium-zoom--opened"),
      overlay: { color: overlay.backgroundColor, opacity: overlay.opacity },
      atNavCorner: (() => {
        const title = document.querySelector(".VPNavBarTitle a").getBoundingClientRect();
        return document.elementFromPoint(title.left + 4, title.top + 4).className;
      })(),
      linkedAttached: document.querySelector(".vp-doc a img").classList.contains("medium-zoom-image"),
      printedOriginal: "",
    });
  }, { once: true });
  img.click();
})`;

const PRINTED_ORIGINAL = `getComputedStyle(document.querySelector(".vp-doc img")).visibility`;

const FOCUS_IMAGE = `(() => {
  const img = document.querySelector(".vp-doc img");
  img.focus();
  return document.activeElement === img;
})()`;

/** Whether the lightbox finished opening within a second of the key press, and what the original and its copy
 *  carry. The
 *  body class medium-zoom sets a frame into the open is not that: an Escape before the transition ends is one the
 *  library drops. */
const KEY_OPENED = `new Promise((resolve) => {
  const timer = setTimeout(() => resolve({ opened: false }), 1000);
  document.querySelector(".vp-doc img").addEventListener("medium-zoom:opened", () => {
    clearTimeout(timer);
    const img = document.querySelector(".vp-doc img");
    const copy = document.querySelector(".medium-zoom-image--opened");
    resolve({
      opened: true,
      originalTabIndex: img.getAttribute("tabindex"),
      copyTabIndex: copy.getAttribute("tabindex"),
      copyRole: copy.getAttribute("role"),
    });
  }, { once: true });
})`;

const FOCUS_ON_IMAGE = `document.activeElement === document.querySelector(".vp-doc img")`;

/** Tab lands on the second image behind the overlay while the first is up. */
const FOCUS_SECOND_IMAGE = `(() => {
  const second = document.querySelectorAll(".vp-doc img:not(a img)")[1];
  second.focus();
  return document.activeElement === second;
})()`;

const WHEN_LIGHTBOX_CLOSED = `new Promise((resolve) => {
  const img = document.querySelector(".vp-doc :not(a) > img");
  const closed = () => ({
    overlay: document.querySelector(".medium-zoom-overlay") !== null,
    hidden: img.classList.contains("medium-zoom-image--hidden"),
  });
  if (!closed().overlay) return resolve(closed());
  img.addEventListener("medium-zoom:closed", () => resolve(closed()), { once: true });
})`;

// medium-zoom finishes an open or close on transitionend, so a reduced-motion sheet that stops its transition
// outright leaves the lightbox stuck open; the second pass runs under that preference.
test(
  "an article image opens in a lightbox over the nav by click or by Enter, larger than its inline box, a linked image does not, the original still prints, and Escape closes it, under reduced motion too",
  async () => {
    const tab = await openPage();
    try {
      for (const motion of ["no-preference", "reduce"]) {
        await tab.send("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-reduced-motion", value: motion }],
        });
        const lightbox = await tab.evaluate<Lightbox>(OPEN_LIGHTBOX);
        await tab.send("Emulation.setEmulatedMedia", { media: "print" });
        lightbox.printedOriginal = await tab.evaluate<string>(PRINTED_ORIGINAL);
        await tab.send("Emulation.setEmulatedMedia", { media: "" });
        expect(lightbox).toEqual({
          inline: lightbox.inline,
          zoomed: lightbox.zoomed,
          opened: true,
          overlay: { color: lightbox.overlay.color, opacity: "1" },
          atNavCorner: "medium-zoom-overlay",
          linkedAttached: false,
          printedOriginal: "visible",
        });
        expect(lightbox.zoomed).toBeGreaterThan(lightbox.inline * 1.5);
        expect(lightbox.overlay.color).not.toBe("rgba(0, 0, 0, 0)");
        await tab.press("Escape", 27);
        expect(await tab.evaluate<Record<string, unknown>>(WHEN_LIGHTBOX_CLOSED)).toEqual({
          overlay: false,
          hidden: false,
        });
      }
      expect(await tab.evaluate<boolean>(FOCUS_IMAGE)).toBe(true);
      expect(await tab.accessibleNode(".vp-doc img")).toEqual({
        role: "button",
        name: "A picture",
      });
      const keyOpened = tab.evaluate<Record<string, unknown>>(KEY_OPENED);
      await tab.press("Enter", 13);
      // The original is what medium-zoom clones (a srcset image gets a second, later copy), so it carries no
      // button attributes while it is hidden behind its copy.
      expect(await keyOpened).toEqual({
        opened: true,
        originalTabIndex: null,
        copyTabIndex: null,
        copyRole: null,
      });
      // Enter on another image behind the overlay changes nothing, the focus return included.
      expect(await tab.evaluate<boolean>(FOCUS_SECOND_IMAGE)).toBe(true);
      await tab.press("Enter", 13);
      await tab.press("Escape", 27);
      expect(await tab.evaluate<Record<string, unknown>>(WHEN_LIGHTBOX_CLOSED)).toEqual({
        overlay: false,
        hidden: false,
      });
      // medium-zoom hid the original while its copy was up, which drops focus to <body>.
      expect(await tab.evaluate<boolean>(FOCUS_ON_IMAGE)).toBe(true);
    } finally {
      await tab.close();
    }
  },
  SCENARIO_TIMEOUT_MS,
);

// Auto layout hands a column its longest word once the table is wider than the wrapper, so a whole 90-character token
// left its prose neighbour a dozen lines of two words each; the token now counts whole only up to a share of the
// wrapper and wraps inside past it, while a table of whole tokens still scrolls in the wrapper.
test(
  "a prose cell beside a long code token keeps a readable width, a table of many code columns scrolls in its wrapper, and on paper both fit the page",
  async () => {
    const tab = await openPage();
    try {
      const [crush, wide] = await tab.evaluate<Column[]>(MEASURE_TABLES);
      expect(crush.cells).toHaveLength(2);
      expect(crush.cells[1]).toBeGreaterThanOrEqual(14 * REM);
      expect(crush.cells[0] + crush.cells[1]).toBeLessThanOrEqual(crush.wrapper);
      expect(crush.codeLines).toBeGreaterThanOrEqual(2);
      expect(crush.scrolls).toBe(false);
      expect(wide.scrolls).toBe(true);
      expect(wide.codeLines).toBe(1);
      await tab.send("Emulation.setEmulatedMedia", { media: "print" });
      expect(await tab.evaluate<boolean[]>(MEASURE_PRINT)).toEqual([true, true]);
    } finally {
      await tab.close();
    }
  },
  SCENARIO_TIMEOUT_MS,
);
