// The provenance line under every page: which ref and commit this tier
// was built from (linking to that commit) and which source file rendered
// the page. It reads the same build-time facts as the facts card and
// renders nothing without them. Mounted in the doc-after slot rather than
// carbon's doc footer, which only exists when an edit link or a pager does.
// A labelled <section> (a region landmark), not a <footer>: carbon's own
// doc footer beside it is one, and a page may carry only one contentinfo.

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
      const source = `${facts.docsDir}/${page.value.filePath}`;
      return h("section", { class: "fleet-provenance", "aria-label": "Page provenance" }, [
        h("a", { href: url }, `Built from ${label} at ${sha.slice(0, 7)}`),
        h("span", `Source: ${source}`),
      ]);
    };
  },
});
