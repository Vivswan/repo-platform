// Every article image opens in medium-zoom's lightbox. The instance is made in the browser (mediumZoom builds its
// overlay from the document as it is created), once, and re-attached on each content update so the images of the new page are the
// ones it holds: an image anywhere inside a link or a button (a <picture> between them included) is left to it, and
// one without a word of alt has no name to be a button under. medium-zoom binds a click alone, so each attached image
// is also a focusable button that Enter and Space open, and its lightbox is not modal, so the page behind the overlay
// goes inert while it is up.

import mediumZoom, { type Zoom } from "medium-zoom";
import { onContentUpdated } from "vitepress";
import { defineComponent } from "vue";

/** Article images, minus those inside a link or a button, which already act on a click. */
const IMAGE_SELECTOR = ".vp-doc img:not(a img, button img)";

/** Carbon's root, everything on the page but what medium-zoom appends to <body>. */
const PAGE_SELECTOR = ".Layout";

let zoom: Zoom | undefined;
/** The image that had focus as its lightbox opened (a key opened it, or a click on the focusable image), which takes
 *  focus back on close: medium-zoom hides the original while its copy is up, and a hidden element drops focus. */
let focusedAtOpen: HTMLElement | null = null;

function makeButton(image: Element): void {
  image.setAttribute("tabindex", "0");
  image.setAttribute("role", "button");
}

function unmakeButton(image: Element): void {
  image.removeAttribute("tabindex");
  image.removeAttribute("role");
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  void zoom?.open({ target: event.currentTarget as HTMLElement });
}

function setPageInert(inert: boolean): void {
  const page = document.querySelector<HTMLElement>(PAGE_SELECTOR);
  if (page !== null) page.inert = inert;
}

/** Fires before medium-zoom clones the original, so no copy (a srcset image gets a second one later) inherits the
 *  button attributes; the original is hidden until close anyway. */
function onOpen(event: Event): void {
  const image = event.target as HTMLElement;
  focusedAtOpen = document.activeElement === image ? image : null;
  unmakeButton(image);
  setPageInert(true);
}

/** The page comes back before focus does: an inert element cannot take it. A scroll past medium-zoom's offset is
 *  one way to close, so the focus return leaves the scroll where the reader put it. */
function onClosed(event: Event): void {
  const image = event.target as HTMLElement;
  setPageInert(false);
  makeButton(image);
  if (focusedAtOpen === image) image.focus({ preventScroll: true });
  focusedAtOpen = null;
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
  // A lightbox that is up or still opening is closing from here, its fade over the new page, and onClosed frees the
  // page when the close lands: medium-zoom's detach leaves the listeners on the image.
  zoom.detach();
  // CSS cannot tell a blank alt from a word, so the name check is here.
  zoom.attach(
    [...document.querySelectorAll<HTMLImageElement>(IMAGE_SELECTOR)].filter(
      (image) => image.alt.trim() !== "",
    ),
  );
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
