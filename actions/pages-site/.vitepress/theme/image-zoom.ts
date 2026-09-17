// Every article image opens in medium-zoom's lightbox. The instance is made in the browser (mediumZoom binds document
// listeners as it is created), once, and re-attached on each content update so the images of the new page are the
// ones it holds: an image anywhere inside a link (a <picture> between them included) is left to its link. medium-zoom
// binds a click alone, so each attached image is also a focusable button that Enter and Space open.

import mediumZoom, { type Zoom } from "medium-zoom";
import { onContentUpdated } from "vitepress";
import { defineComponent } from "vue";

const IMAGE_SELECTOR = ".vp-doc img:not(a img)";

let zoom: Zoom | undefined;
/** The image a key opened, which takes focus back on close: medium-zoom hides the original while its copy is up,
 *  and a hidden element drops focus to <body>. */
let openedByKey: HTMLElement | null = null;

function makeButton(image: Element): void {
  image.setAttribute("tabindex", "0");
  image.setAttribute("role", "button");
}

function unmakeButton(image: Element): void {
  image.removeAttribute("tabindex");
  image.removeAttribute("role");
}

/** Tab still reaches the images behind the overlay; a key there is medium-zoom's to ignore, and the pending
 *  focus return stays with the image that is up. */
function onKeydown(event: KeyboardEvent): void {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  if (zoom === undefined || zoom.getZoomedImage() !== null) return;
  openedByKey = event.currentTarget as HTMLElement;
  void zoom.open({ target: openedByKey });
}

/** Fires before medium-zoom clones the original, so no copy (a srcset image gets a second one later) inherits the
 *  button attributes; the original is hidden until close anyway. */
function onOpen(event: Event): void {
  unmakeButton(event.target as Element);
}

function onClosed(event: Event): void {
  const image = event.target as HTMLElement;
  makeButton(image);
  if (openedByKey === image) {
    image.focus();
    openedByKey = null;
  }
}

function attachImageZoom(): void {
  // A listener registered on the instance rides onto every image a later attach adds.
  zoom ??= mediumZoom({ background: "var(--vp-c-bg)", margin: 24 })
    .on("open", onOpen)
    .on("closed", onClosed);
  for (const image of zoom.getImages()) {
    unmakeButton(image);
    image.removeEventListener("keydown", onKeydown);
  }
  zoom.detach();
  zoom.attach(IMAGE_SELECTOR);
  for (const image of zoom.getImages()) {
    makeButton(image);
    image.addEventListener("keydown", onKeydown);
  }
}

export default defineComponent({
  name: "ImageZoom",
  setup() {
    onContentUpdated(attachImageZoom);
    return () => null;
  },
});
