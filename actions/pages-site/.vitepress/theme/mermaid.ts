// Browser APIs stay inside the callbacks, so the server render touches nothing.

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
