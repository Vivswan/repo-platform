// The full-size view of one rendered diagram. Mermaid draws its SVG at width 100% under a max-width, so in the column
// it only ever shrinks; the view is a modal <dialog> holding a copy of the SVG at its viewBox size, built once per
// page on first use and appended to <body>. The copy keeps the SVG's id: mermaid scopes the styles inside the SVG to
// that id, so a renamed copy would lose them. Panzoom drives the canvas around the copy, not the copy itself, so a
// redraw swaps the copy under an untouched transform; `animate` stays off, so nothing here moves on its own.

import Panzoom, { type PanzoomObject } from "@panzoom/panzoom";

export const ZOOM_BUTTON_CLASS = "fleet-mermaid-zoom";
export const VIEW_CLASS = "fleet-mermaid-view";

const KEY_PAN_PIXELS = 40;

/** The diagram on show: its mount, the mount's diagram element (the SVG's parent across re-renders), and the
 *  button that opened it, which takes focus back on close. */
interface Shown {
  mount: HTMLElement;
  diagram: HTMLElement;
  opener: HTMLElement;
}

interface View {
  dialog: HTMLDialogElement;
  stage: HTMLElement;
  canvas: HTMLElement;
  panzoom: PanzoomObject;
  shown: Shown | null;
}

let view: View | undefined;

function naturalSize(svg: SVGSVGElement): { width: number; height: number } | null {
  const [, , width, height] = (svg.getAttribute("viewBox") ?? "").split(/[\s,]+/).map(Number);
  return Number.isFinite(width) && Number.isFinite(height) ? { width, height } : null;
}

function fill(current: View, shown: Shown): void {
  const svg = shown.diagram.querySelector<SVGSVGElement>(":scope > svg");
  current.canvas.replaceChildren();
  if (svg === null) return;
  const copy = svg.cloneNode(true) as SVGSVGElement;
  const size = naturalSize(svg);
  copy.style.maxWidth = "none";
  if (size !== null) {
    copy.style.width = `${size.width}px`;
    copy.style.height = `${size.height}px`;
  }
  current.canvas.append(copy);
}

/** Natural size, centered on each axis where it fits and starting at the edge where it does not; Reset returns here. */
function place(current: View): void {
  const svg = current.canvas.firstElementChild as SVGSVGElement | null;
  const size = svg === null ? null : naturalSize(svg);
  const rect = current.stage.getBoundingClientRect();
  current.panzoom.setOptions({
    startScale: 1,
    startX: size === null ? 0 : Math.max(0, (rect.width - size.width) / 2),
    startY: size === null ? 0 : Math.max(0, (rect.height - size.height) / 2),
  });
  current.panzoom.reset({ animate: false });
}

/** A chord (Alt, Ctrl, Meta) stays the browser's: Alt+ArrowLeft is Back. The arrows scroll the stage, so
 *  ArrowRight reveals the right side. */
function onKey(current: View, event: KeyboardEvent): boolean {
  if (event.altKey || event.ctrlKey || event.metaKey) return false;
  const { panzoom } = current;
  const scroll = (x: number, y: number) =>
    panzoom.pan(x / panzoom.getScale(), y / panzoom.getScale(), { relative: true });
  switch (event.key) {
    case "ArrowLeft":
      scroll(KEY_PAN_PIXELS, 0);
      return true;
    case "ArrowRight":
      scroll(-KEY_PAN_PIXELS, 0);
      return true;
    case "ArrowUp":
      scroll(0, KEY_PAN_PIXELS);
      return true;
    case "ArrowDown":
      scroll(0, -KEY_PAN_PIXELS);
      return true;
    case "+":
    case "=":
      panzoom.zoomIn({ animate: false });
      return true;
    case "-":
      panzoom.zoomOut({ animate: false });
      return true;
    case "0":
      place(current);
      return true;
    default:
      return false;
  }
}

function control(text: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = text;
  button.addEventListener("click", onClick);
  return button;
}

function build(): View {
  const dialog = document.createElement("dialog");
  dialog.className = VIEW_CLASS;
  dialog.setAttribute("aria-label", "Diagram at full size");
  const bar = document.createElement("div");
  bar.className = `${VIEW_CLASS}-bar`;
  const stage = document.createElement("div");
  stage.className = `${VIEW_CLASS}-stage`;
  stage.tabIndex = 0;
  // A generic element takes no accessible name, so the key instructions ride on a role that does.
  stage.setAttribute("role", "group");
  stage.setAttribute("aria-label", "Diagram: arrow keys pan, plus and minus zoom, 0 resets");
  const canvas = document.createElement("div");
  canvas.className = `${VIEW_CLASS}-canvas`;
  stage.append(canvas);
  dialog.append(bar, stage);
  document.body.append(dialog);
  // `canvas: true` binds the drag to the stage, so a pull on empty ground moves the diagram too.
  const panzoom = Panzoom(canvas, {
    canvas: true,
    animate: false,
    minScale: 0.2,
    maxScale: 8,
    cursor: "grab",
  });
  const current: View = { dialog, stage, canvas, panzoom, shown: null };
  bar.append(
    control("Zoom in", () => panzoom.zoomIn({ animate: false })),
    control("Zoom out", () => panzoom.zoomOut({ animate: false })),
    control("Reset", () => place(current)),
    control("Close", () => dialog.close()),
  );
  // Focus goes back to the opener on every close: a modal took it, and Escape would leave it on <body>.
  dialog.addEventListener("close", () => {
    current.shown?.opener.focus();
    current.shown = null;
  });
  stage.addEventListener("wheel", panzoom.zoomWithWheel, { passive: false });
  stage.addEventListener("keydown", (event) => {
    if (onKey(current, event)) event.preventDefault();
  });
  return current;
}

function open(shown: Shown): void {
  view ??= build();
  view.shown = shown;
  fill(view, shown);
  view.dialog.showModal();
  place(view);
}

function showing(mount: HTMLElement): Shown | null {
  return view?.dialog.open && view.shown?.mount === mount ? view.shown : null;
}

/** The mount's zoom button, made once; a mount whose diagram is showing in the view gets the copy redrawn from the
 *  fresh SVG (a theme flip bakes new colors), the transform kept. */
export function attachZoom(mount: HTMLElement, diagram: HTMLElement): void {
  if (mount.querySelector(`:scope > .${ZOOM_BUTTON_CLASS}`) === null) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = ZOOM_BUTTON_CLASS;
    button.textContent = "Zoom";
    button.setAttribute("aria-label", "Zoom the diagram");
    button.addEventListener("click", () => open({ mount, diagram, opener: button }));
    mount.append(button);
  }
  const shown = showing(mount);
  if (shown !== null) fill(view!, shown);
}

export function detachZoom(mount: HTMLElement): void {
  mount.querySelector(`:scope > .${ZOOM_BUTTON_CLASS}`)?.remove();
  if (showing(mount) !== null) view!.dialog.close();
}

/** Closes a view whose mount is not among the page's `mounts`: the view sits on <body>, outside the content a route
 *  change swaps, and the browser's Back and Forward reach a page under a modal. */
export function closeZoomOutside(mounts: readonly HTMLElement[]): void {
  if (view?.dialog.open && view.shown !== null && !mounts.includes(view.shown.mount)) {
    view.dialog.close();
  }
}
