// The provenance line under every page: which ref and commit this tier
// was built from (linking to that commit) and which source file rendered
// the page. It reads the same build-time facts as the facts card and
// renders nothing without them. Mounted in the doc-after slot rather than
// carbon's doc footer, which only exists when an edit link or a pager does.

import { useData } from "vitepress";
import { defineComponent, h } from "vue";
import type { ProjectFacts } from "../../facts.ts";

export default defineComponent({
  name: "ProvenanceLine",
  setup() {
    const { theme, page } = useData<{ docsSiteFacts?: ProjectFacts }>();
    return () => {
      const facts = theme.value.docsSiteFacts;
      if (facts === undefined) return null;
      const { label, sha, url } = facts.provenance;
      return h("div", { class: "fleet-provenance" }, [
        h("a", { href: url }, `Built from ${label} at ${sha.slice(0, 7)}`),
        h("span", `Source: ${page.value.filePath}`),
      ]);
    };
  },
});
