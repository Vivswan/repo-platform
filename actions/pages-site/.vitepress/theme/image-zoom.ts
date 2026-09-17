// Every article image opens in medium-zoom's lightbox. The instance is made in the browser (mediumZoom binds document
// listeners as it is created), once, and re-attached on each content update so the images of the new page are the
// ones it holds: an image anywhere inside a link (a <picture> between them included) is left to its link, and one
// without a word of alt has no name to be a button under. medium-zoom binds a click alone, so each attached image
// is also a focusable button that Enter and Space open, and its lightbox is not modal, so the page behind the overlay
// goes inert while it is up.

import mediumZoom, { type Zoom } from "medium-zoom";
import { onContentUpdated } from "vitepress";
import { defineComponent } from "vue";

const IMAGE_SELECTOR = ".vp-doc img:not(a img)";
/** Carbon's root, everything on the page but what medium-zoom appends to <body>. */
const PAGE_SELECTOR = ".Layout";

let zoom: Zoom | undefined;
/** The image that had focus as its lightbox opened (a key opened it, or a click on the focusable image), which takes
 *  focus back on close: medium-zoom hides the original while its copy is up, and a hidden element drops focus. */
let focusedAtOpen: HTMLElement | null = null;
/** Whether the current open finished: medium-zoom never finishes one whose srcset candidate fails to load, and
 *  such an open never closes either. */
let openFinished = false;

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
  openFinished = false;
  unmakeButton(image);
  setPageInert(true);
}

/** An open that finishes after a content update freed the page (a route change inside the transition) takes the
 *  page back; the lightbox is still up over it, and Escape still closes it. */
function onOpened(): void {
  openFinished = true;
  setPageInert(true);
}

/** The page comes back before focus does: an inert element cannot take it. */
function onClosed(event: Event): void {
  const image = event.target as HTMLElement;
  setPageInert(false);
  makeButton(image);
  if (focusedAtOpen === image) image.focus();
  focusedAtOpen = null;
}

function attachImageZoom(): void {
  // A listener registered on the instance rides onto every image a later attach adds.
  zoom ??= mediumZoom({ background: "var(--vp-c-bg)", margin: 24 })
    .on("open", onOpen)
    .on("opened", onOpened)
    .on("closed", onClosed);
  for (const image of zoom.getImages()) {
    unmakeButton(image);
    image.removeEventListener("keydown", onKeydown);
  }
  zoom.detach();
  // A stuck open (its candidate never loaded) never closes, so the page it made inert is freed here; a finished one
  // is closing now, its fade over the page, and onClosed frees it. One still in its transition takes the page back
  // when it finishes (onOpened): medium-zoom's detach leaves the listeners on the image.
  if (!openFinished) setPageInert(false);
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
