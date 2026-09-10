// The render pass over a page's mermaid mounts (../mermaid.ts's fence
// output): load the mermaid package, once, on the first mount ever seen (a
// page without one costs no mermaid bytes), then draw each mount's source
// into a diagram child. Mermaid bakes the theme's colors into the SVG, so
// the pass runs again on every appearance flip. A failed render keeps the
// source in view and adds the error under it. Kept apart from the component
// in mermaid.ts so the pass is testable without VitePress.

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

/** Renders the page's mounts with the given mode's theme. A run that a
 *  later one overtakes (a toggle mid-render, a navigation) stops at its
 *  next await, so the newest theme always lands last. */
export async function renderAll(dark: boolean): Promise<void> {
  const run = ++generation;
  const mounts = [...document.querySelectorAll<HTMLElement>(`.${MERMAID_CLASS}`)];
  if (mounts.length === 0) return;
  let mermaid: Mermaid;
  try {
    mermaid = await loadMermaid();
    if (run !== generation) return;
    const slot = Number(document.documentElement.dataset.fleetHue);
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: "base",
      themeVariables: mermaidThemeVariables(dark ? "dark" : "light", HUES[slot] ?? HUES[0]),
    });
  } catch (error) {
    // Not cached: an import that failed offline gets another try next run.
    loading = undefined;
    if (run !== generation) return;
    for (const mount of mounts) fail(mount, error);
    return;
  }
  for (const [index, mount] of mounts.entries()) {
    const source = directChild(mount, MERMAID_SOURCE_CLASS)?.textContent ?? "";
    try {
      const { svg, bindFunctions } = await mermaid.render(`fleet-mermaid-${run}-${index}`, source);
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
