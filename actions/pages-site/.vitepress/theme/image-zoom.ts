// Every article image opens in medium-zoom's lightbox. The instance is made in the browser (mediumZoom binds document
// listeners as it is created), once, and re-attached on each content update so the images of the new page are the
// ones it holds: an image anywhere inside a link (a <picture> between them included) is left to its link. medium-zoom
// binds a click alone, so each attached image is also a focusable button that Enter and Space open.

import mediumZoom, { type Zoom } from "medium-zoom";
import { onContentUpdated } from "vitepress";
import { defineComponent } from "vue";

const IMAGE_SELECTOR = ".vp-doc img:not(a img)";

let zoom: Zoom | undefined;

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  const image = event.currentTarget as HTMLElement;
  // medium-zoom hides the original while its copy is up, which drops focus to <body>.
  image.addEventListener("medium-zoom:closed", () => image.focus(), { once: true });
  void zoom?.open({ target: image });
}

/** The copy is a cloneNode of the original, button attributes included, but a click alone closes it. */
function stripCopy(): void {
  for (const copy of document.querySelectorAll(".medium-zoom-image--opened")) {
    copy.removeAttribute("tabindex");
    copy.removeAttribute("role");
  }
}

function attachImageZoom(): void {
  // A listener registered on the instance rides onto every image a later attach adds.
  zoom ??= mediumZoom({ background: "var(--vp-c-bg)", margin: 24 }).on("opened", stripCopy);
  for (const image of zoom.getImages()) {
    image.removeAttribute("tabindex");
    image.removeAttribute("role");
    image.removeEventListener("keydown", onKeydown);
  }
  zoom.detach();
  zoom.attach(IMAGE_SELECTOR);
  for (const image of zoom.getImages()) {
    image.tabIndex = 0;
    image.setAttribute("role", "button");
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
