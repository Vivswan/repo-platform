// The Zoom button on each rendered diagram and the state the view (mermaid-zoom-view.ts) follows. reka-ui reads
// `window` as it loads and keeps the answer, so the render pass, which bun tests under a fake document, never loads it.

import { shallowRef } from "vue";

export const ZOOM_BUTTON_CLASS = "fleet-mermaid-zoom";

/** The diagram on show: its mount and the mount's diagram element (the SVG's parent across re-renders). */
export interface Shown {
  mount: HTMLElement;
  diagram: HTMLElement;
}

/** An object opens the view, null closes it, and a fresh object for the mount already on show redraws the copy: a
 *  render pass keeps the diagram element and swaps the SVG inside it, so only the object's identity carries the news. */
export const shown = shallowRef<Shown | null>(null);

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
