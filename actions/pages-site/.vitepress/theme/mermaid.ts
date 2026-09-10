// The diagram component: no markup of its own, it runs the render pass in
// mermaid-render.ts after every content update (the first mount, every
// navigation) and again when the appearance flips. Browser APIs stay inside
// the callbacks, so the server render touches nothing.

import { onContentUpdated, useData } from "vitepress";
import { defineComponent, watch } from "vue";
import { renderAll } from "./mermaid-render.ts";

export default defineComponent({
  name: "MermaidDiagrams",
  setup() {
    const { isDark } = useData();
    onContentUpdated(() => void renderAll(isDark.value));
    watch(isDark, (dark) => void renderAll(dark));
    return () => null;
  },
});
