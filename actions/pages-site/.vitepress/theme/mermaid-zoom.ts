// The full-size view of one rendered diagram. Mermaid draws its SVG at width 100% under a max-width, so in the column
// it only ever shrinks; the view is a modal <dialog> holding a copy of the SVG at its viewBox size, built once per
// page on first use and appended to <body>. The copy keeps the SVG's id: mermaid scopes the styles inside the SVG to
// that id, so a renamed copy would lose them. No transition anywhere: the transform follows the pointer.

export const ZOOM_BUTTON_CLASS = "fleet-mermaid-zoom";
export const VIEW_CLASS = "fleet-mermaid-view";

const SCALE_MIN = 0.2;
const SCALE_MAX = 8;
const STEP = 1.25;
/** Wheel pixels per e-fold of scale: a 120px notch is about x1.5. */
const WHEEL_PIXELS = 300;
const LINE_PIXELS = 16;
const KEY_PAN_PIXELS = 40;

interface Point {
  x: number;
  y: number;
}

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
  shown: Shown | null;
  scale: number;
  x: number;
  y: number;
  /** The pointers down on the stage: one drags, two pinch. */
  pointers: Map<number, Point>;
}

let view: View | undefined;

function clampScale(scale: number): number {
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, scale));
}

function apply(current: View): void {
  current.canvas.style.transform = `translate(${current.x}px, ${current.y}px) scale(${current.scale})`;
}

/** Scales about a stage-relative point, so that point stays under the pointer. */
function zoomAt(current: View, factor: number, at: Point): void {
  const next = clampScale(current.scale * factor);
  const ratio = next / current.scale;
  current.x = at.x - (at.x - current.x) * ratio;
  current.y = at.y - (at.y - current.y) * ratio;
  current.scale = next;
  apply(current);
}

function stageCenter(current: View): Point {
  const rect = current.stage.getBoundingClientRect();
  return { x: rect.width / 2, y: rect.height / 2 };
}

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

/** Natural size, centered on each axis where it fits and starting at the edge where it does not. */
function place(current: View): void {
  const svg = current.canvas.firstElementChild as SVGSVGElement | null;
  const size = svg === null ? null : naturalSize(svg);
  const rect = current.stage.getBoundingClientRect();
  current.scale = 1;
  current.x = size === null ? 0 : Math.max(0, (rect.width - size.width) / 2);
  current.y = size === null ? 0 : Math.max(0, (rect.height - size.height) / 2);
  apply(current);
}

function wheelUnit(deltaMode: number, pageHeight: number): number {
  if (deltaMode === WheelEvent.DOM_DELTA_LINE) return LINE_PIXELS;
  if (deltaMode === WheelEvent.DOM_DELTA_PAGE) return pageHeight;
  return 1;
}

/** A chord (Alt, Ctrl, Meta) stays the browser's: Alt+ArrowLeft is Back. */
function onKey(current: View, event: KeyboardEvent): boolean {
  if (event.altKey || event.ctrlKey || event.metaKey) return false;
  const pan = (x: number, y: number) => {
    current.x += x;
    current.y += y;
    apply(current);
  };
  switch (event.key) {
    case "ArrowLeft":
      pan(KEY_PAN_PIXELS, 0);
      return true;
    case "ArrowRight":
      pan(-KEY_PAN_PIXELS, 0);
      return true;
    case "ArrowUp":
      pan(0, KEY_PAN_PIXELS);
      return true;
    case "ArrowDown":
      pan(0, -KEY_PAN_PIXELS);
      return true;
    case "+":
    case "=":
      zoomAt(current, STEP, stageCenter(current));
      return true;
    case "-":
      zoomAt(current, 1 / STEP, stageCenter(current));
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

function onPointerMove(current: View, event: PointerEvent): void {
  const previous = current.pointers.get(event.pointerId);
  if (previous === undefined) return;
  const now = { x: event.clientX, y: event.clientY };
  const others = [...current.pointers].filter(([id]) => id !== event.pointerId);
  if (others.length === 0) {
    current.x += now.x - previous.x;
    current.y += now.y - previous.y;
    apply(current);
  } else if (others.length === 1) {
    const [, other] = others[0];
    const rect = current.stage.getBoundingClientRect();
    const midBefore = { x: (previous.x + other.x) / 2, y: (previous.y + other.y) / 2 };
    const midNow = { x: (now.x + other.x) / 2, y: (now.y + other.y) / 2 };
    current.x += midNow.x - midBefore.x;
    current.y += midNow.y - midBefore.y;
    const factor =
      Math.hypot(now.x - other.x, now.y - other.y) /
      Math.hypot(previous.x - other.x, previous.y - other.y);
    zoomAt(current, factor, { x: midNow.x - rect.left, y: midNow.y - rect.top });
  }
  current.pointers.set(event.pointerId, now);
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
  const current: View = {
    dialog,
    stage,
    canvas,
    shown: null,
    scale: 1,
    x: 0,
    y: 0,
    pointers: new Map(),
  };
  bar.append(
    control("Zoom in", () => zoomAt(current, STEP, stageCenter(current))),
    control("Zoom out", () => zoomAt(current, 1 / STEP, stageCenter(current))),
    control("Reset", () => place(current)),
    control("Close", () => dialog.close()),
  );
  // Focus goes back to the opener on every close: a modal took it, and Escape would leave it on <body>.
  dialog.addEventListener("close", () => {
    current.pointers.clear();
    current.shown?.opener.focus();
    current.shown = null;
  });
  stage.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const rect = stage.getBoundingClientRect();
      const pixels = event.deltaY * wheelUnit(event.deltaMode, rect.height);
      zoomAt(current, Math.exp(-pixels / WHEEL_PIXELS), {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
    },
    { passive: false },
  );
  stage.addEventListener("keydown", (event) => {
    if (onKey(current, event)) event.preventDefault();
  });
  stage.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    stage.setPointerCapture(event.pointerId);
    current.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  });
  stage.addEventListener("pointermove", (event) => onPointerMove(current, event));
  for (const type of ["pointerup", "pointercancel"] as const) {
    stage.addEventListener(type, (event) => current.pointers.delete(event.pointerId));
  }
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
