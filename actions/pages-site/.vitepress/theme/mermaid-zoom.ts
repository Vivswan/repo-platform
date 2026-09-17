// The full-size view of one rendered diagram. Mermaid draws its SVG at width 100% under a max-width, so in the column
// it only ever shrinks; the view is reka-ui's modal Dialog holding a copy of the SVG at its viewBox size. The copy keeps
// the SVG's id: mermaid scopes the styles inside the SVG to that id, so a renamed copy would lose them. Panzoom drives
// the canvas around the copy, not the copy itself, so a redraw swaps the copy under an untouched transform; `animate`
// stays off, so nothing here moves on its own.

import Panzoom, { type PanzoomObject } from "@panzoom/panzoom";
import {
  DialogClose,
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
  VisuallyHidden,
} from "reka-ui";
import type { PropType } from "vue";
import { defineComponent, h, onBeforeUnmount, onMounted, shallowRef, watch } from "vue";

export const ZOOM_BUTTON_CLASS = "fleet-mermaid-zoom";
export const VIEW_CLASS = "fleet-mermaid-view";

const KEY_PAN_PIXELS = 40;
/** The arrows scroll the stage, so ArrowRight reveals the right side. */
const PAN_KEYS: Readonly<Record<string, readonly [number, number]>> = {
  ArrowLeft: [1, 0],
  ArrowRight: [-1, 0],
  ArrowUp: [0, 1],
  ArrowDown: [0, -1],
};

/** The diagram on show: its mount and the mount's diagram element (the SVG's parent across re-renders). */
interface Shown {
  mount: HTMLElement;
  diagram: HTMLElement;
}

/** An object opens the view, null closes it, and a fresh object for the mount already on show redraws the copy: a
 *  render pass keeps the diagram element and swaps the SVG inside it, so only the object's identity carries the news. */
const shown = shallowRef<Shown | null>(null);

function naturalSize(svg: SVGSVGElement): { width: number; height: number } | null {
  const [, , width, height] = (svg.getAttribute("viewBox") ?? "").split(/[\s,]+/).map(Number);
  return Number.isFinite(width) && Number.isFinite(height) ? { width, height } : null;
}

function fill(canvas: HTMLElement, diagram: HTMLElement): void {
  const svg = diagram.querySelector<SVGSVGElement>(":scope > svg");
  canvas.replaceChildren();
  if (svg === null) return;
  const copy = svg.cloneNode(true) as SVGSVGElement;
  const size = naturalSize(svg);
  copy.style.maxWidth = "none";
  if (size !== null) {
    copy.style.width = `${size.width}px`;
    copy.style.height = `${size.height}px`;
  }
  canvas.append(copy);
}

const control = (text: string, onClick: () => void) =>
  h("button", { type: "button", onClick }, text);

/** The dialog's body, mounted while the view is open, so Panzoom lives exactly as long as its canvas. */
const Body = defineComponent({
  name: "MermaidZoomBody",
  props: { shown: { type: Object as PropType<Shown>, required: true } },
  setup(props) {
    const stage = shallowRef<HTMLElement | null>(null);
    const canvas = shallowRef<HTMLElement | null>(null);
    let panzoom: PanzoomObject;

    /** Natural size, centered on each axis where it fits and starting at the edge where it does not; Reset returns here. */
    function place(): void {
      const svg = canvas.value!.firstElementChild as SVGSVGElement | null;
      const size = svg === null ? null : naturalSize(svg);
      const rect = stage.value!.getBoundingClientRect();
      panzoom.setOptions({
        startScale: 1,
        startX: size === null ? 0 : Math.max(0, (rect.width - size.width) / 2),
        startY: size === null ? 0 : Math.max(0, (rect.height - size.height) / 2),
      });
      panzoom.reset({ animate: false });
    }

    /** A chord (Alt, Ctrl, Meta) stays the browser's: Alt+ArrowLeft is Back. */
    function onKey(event: KeyboardEvent): void {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const pan = PAN_KEYS[event.key];
      if (pan !== undefined) {
        const step = KEY_PAN_PIXELS / panzoom.getScale();
        panzoom.pan(pan[0] * step, pan[1] * step, { relative: true });
      } else if (event.key === "+" || event.key === "=") panzoom.zoomIn({ animate: false });
      else if (event.key === "-") panzoom.zoomOut({ animate: false });
      else if (event.key === "0") place();
      else return;
      event.preventDefault();
    }

    onMounted(() => {
      // `canvas: true` binds the drag to the stage, so a pull on empty ground moves the diagram too.
      panzoom = Panzoom(canvas.value!, {
        canvas: true,
        animate: false,
        minScale: 0.2,
        maxScale: 8,
        cursor: "grab",
      });
      fill(canvas.value!, props.shown.diagram);
      place();
    });
    watch(
      () => props.shown,
      (current) => fill(canvas.value!, current.diagram),
    );
    onBeforeUnmount(() => panzoom.destroy());
    return () => [
      h(VisuallyHidden, null, () => h(DialogTitle, null, () => "Diagram at full size")),
      h("div", { class: `${VIEW_CLASS}-bar` }, [
        control("Zoom in", () => panzoom.zoomIn({ animate: false })),
        control("Zoom out", () => panzoom.zoomOut({ animate: false })),
        control("Reset", place),
        h(DialogClose, null, () => "Close"),
      ]),
      h(
        "div",
        {
          ref: stage,
          class: `${VIEW_CLASS}-stage`,
          tabindex: 0,
          // A generic element takes no accessible name, so the key instructions ride on a role that does.
          role: "group",
          "aria-label": "Diagram: arrow keys pan, plus and minus zoom, 0 resets",
          onKeydown: onKey,
          onWheel: (event: WheelEvent) => panzoom.zoomWithWheel(event),
        },
        h("div", { ref: canvas, class: `${VIEW_CLASS}-canvas` }),
      ),
    ];
  },
});

/** The view, rendered on every page by the diagram component; reka owns the modal layer: the focus trap, Escape, the
 *  page's scroll lock, and focus back to the element that had it as the view opened. */
export default defineComponent({
  name: "MermaidZoomView",
  setup() {
    return () => {
      const current = shown.value;
      return h(
        DialogRoot,
        {
          open: current !== null,
          "onUpdate:open": (open: boolean) => {
            if (!open) shown.value = null;
          },
        },
        () =>
          h(DialogPortal, null, () => [
            // The Overlay carries reka's scroll lock; the content fills the viewport, so it needs no look of its own.
            h(DialogOverlay),
            // No description: the title says it all, and reka's dev warning reads the attribute's absence.
            h(DialogContent, { class: VIEW_CLASS, "aria-describedby": undefined }, () =>
              current === null ? null : h(Body, { shown: current }),
            ),
          ]),
      );
    };
  },
});

/** The mount's zoom button, made once; a mount whose diagram is on show gets the copy redrawn from the fresh SVG (a
 *  theme flip bakes new colors), the transform kept. */
export function attachZoom(mount: HTMLElement, diagram: HTMLElement): void {
  if (mount.querySelector(`:scope > .${ZOOM_BUTTON_CLASS}`) === null) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = ZOOM_BUTTON_CLASS;
    button.textContent = "Zoom";
    button.setAttribute("aria-label", "Zoom the diagram");
    button.addEventListener("click", () => {
      shown.value = { mount, diagram };
    });
    mount.append(button);
  }
  if (shown.value?.mount === mount) shown.value = { mount, diagram };
}

export function detachZoom(mount: HTMLElement): void {
  mount.querySelector(`:scope > .${ZOOM_BUTTON_CLASS}`)?.remove();
  if (shown.value?.mount === mount) shown.value = null;
}

/** Closes a view whose mount is not among the page's `mounts`: the view sits on <body>, outside the content a route
 *  change swaps, and the browser's Back and Forward reach a page under a modal. */
export function closeZoomOutside(mounts: readonly HTMLElement[]): void {
  if (shown.value !== null && !mounts.includes(shown.value.mount)) shown.value = null;
}
