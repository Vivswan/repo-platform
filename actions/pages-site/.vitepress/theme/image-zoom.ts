// Every article image opens in medium-zoom's lightbox. The instance is made in the browser (mediumZoom binds document
// listeners as it is created), once, and re-attached on each content update so the images of the new page are the
// ones it holds: an image anywhere inside a link (a <picture> between them included) is left to its link.

import mediumZoom, { type Zoom } from "medium-zoom";
import { onContentUpdated } from "vitepress";
import { defineComponent } from "vue";

const IMAGE_SELECTOR = ".vp-doc img:not(a img)";

let zoom: Zoom | undefined;

function attachImageZoom(): void {
  zoom ??= mediumZoom({ background: "var(--vp-c-bg)", margin: 24 });
  zoom.detach();
  zoom.attach(IMAGE_SELECTOR);
}

export default defineComponent({
  name: "ImageZoom",
  setup() {
    onContentUpdated(attachImageZoom);
    return () => null;
  },
});
