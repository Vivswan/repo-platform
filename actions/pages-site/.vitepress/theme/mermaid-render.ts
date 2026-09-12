// mermaid loads on the first mount ever seen, so a page without one costs no mermaid bytes; the pass runs again on
// every appearance flip because mermaid bakes the theme's colors into the SVG. Kept apart from the component in
// mermaid.ts so the pass is testable without VitePress.

import { MERMAID_CLASS, MERMAID_SOURCE_CLASS } from "../mermaid.ts";
import { mermaidThemeVariables } from "./mermaid-theme.ts";
import { HUES } from "./tokens.ts";

type Mermaid = typeof import("mermaid")["default"];

export const MERMAID_DIAGRAM_CLASS = "fleet-mermaid-diagram";
export const MERMAID_ERROR_CLASS = "fleet-mermaid-error";

let loading: Promise<Mermaid> | undefined;
let generation = 0;

function loadMermaid(): Promise<Mermaid> {
  loading ??= import("mermaid").then((module) => module.default);
  return loading;
}

function directChild(mount: HTMLElement, className: string): HTMLElement | null {
  return mount.querySelector<HTMLElement>(`:scope > .${className}`);
}

/** The mount's child of `className`, made on first use so a re-render
 *  replaces the previous diagram or error rather than stacking one more. */
function ensureChild(mount: HTMLElement, tag: "div" | "p", className: string): HTMLElement {
  const found = directChild(mount, className);
  if (found !== null) return found;
  const made = document.createElement(tag);
  made.className = className;
  mount.append(made);
  return made;
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n", 1)[0].trim() || "unknown error";
}

function fail(mount: HTMLElement, error: unknown): void {
  directChild(mount, MERMAID_DIAGRAM_CLASS)?.remove();
  ensureChild(mount, "p", MERMAID_ERROR_CLASS).textContent =
    `The diagram did not render: ${firstLine(error)}`;
  mount.dataset.state = "error";
}

/** A face still in flight at the deadline is drawn in the fallback, exactly as a failed one is; unbounded, a
 *  request that never settles would leave every diagram on the page unrendered. */
const FACE_DEADLINE_MS = 3_000;

// The browser fetches a face only once laid-out text uses it, so the theme's mono face can still be in flight
// when the pass starts, and mermaid would measure every label in the fallback face and draw it in the real one.
function faceOrDeadline(font: string, text: string): Promise<void> {
  const fonts: FontFaceSet | undefined = document.fonts;
  if (fonts === undefined) return Promise.resolve();
  return new Promise((resolve) => {
    const deadline = setTimeout(resolve, FACE_DEADLINE_MS);
    const settle = () => {
      clearTimeout(deadline);
      resolve();
    };
    fonts.load(font, text).then(settle, settle);
  });
}

/** A run that a later one overtakes (a toggle mid-render, a navigation) stops at its next await, so the newest theme
 *  always lands last. */
export async function renderAll(dark: boolean): Promise<void> {
  const run = ++generation;
  const mounts = [...document.querySelectorAll<HTMLElement>(`.${MERMAID_CLASS}`)];
  if (mounts.length === 0) return;
  const sources = mounts.map(
    (mount) => directChild(mount, MERMAID_SOURCE_CLASS)?.textContent ?? "",
  );
  const slot = Number(document.documentElement.dataset.fleetHue);
  const themeVariables = mermaidThemeVariables(dark ? "dark" : "light", HUES[slot] ?? HUES[0]);
  const face = faceOrDeadline(
    `${themeVariables.fontSize} ${themeVariables.fontFamily}`,
    sources.join(""),
  );
  let mermaid: Mermaid;
  try {
    mermaid = await loadMermaid();
    await face;
    if (run !== generation) return;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: "base",
      themeVariables,
    });
  } catch (error) {
    // Not cached: an import that failed offline gets another try next run.
    loading = undefined;
    if (run !== generation) return;
    for (const mount of mounts) fail(mount, error);
    return;
  }
  for (const [index, mount] of mounts.entries()) {
    try {
      const { svg, bindFunctions } = await mermaid.render(
        `fleet-mermaid-${run}-${index}`,
        sources[index],
      );
      if (run !== generation) return;
      const diagram = ensureChild(mount, "div", MERMAID_DIAGRAM_CLASS);
      diagram.innerHTML = svg;
      bindFunctions?.(diagram);
      directChild(mount, MERMAID_ERROR_CLASS)?.remove();
      mount.dataset.state = "rendered";
    } catch (error) {
      if (run !== generation) return;
      fail(mount, error);
    }
  }
}
