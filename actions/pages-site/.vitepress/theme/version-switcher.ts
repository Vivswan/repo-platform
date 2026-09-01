// The version dropdown: reads the version list the pages-site action
// injects at build time (themeConfig.docsSiteVersions, derived from the
// repository's version tags) and navigates to the selected version's root.
// It renders nothing when fewer than two versions exist, so an unversioned
// or not-yet-tagged site carries no dropdown at all.

import { useData } from "vitepress";
import { defineComponent, h } from "vue";

interface VersionLink {
  label: string;
  link: string;
}

export default defineComponent({
  name: "VersionSwitcher",
  setup() {
    const { theme } = useData();
    return () => {
      const versions = (theme.value.docsSiteVersions ?? []) as VersionLink[];
      if (versions.length < 2) return null;
      const current = (theme.value.docsSiteCurrent ?? "") as string;
      return h(
        "select",
        {
          class: "docs-site-version-switcher",
          "aria-label": "Documentation version",
          onChange: (event: Event) => {
            const link = (event.target as HTMLSelectElement).value;
            if (link !== "") window.location.href = link;
          },
        },
        versions.map(({ label, link }) =>
          h("option", { value: link, selected: label === current }, label),
        ),
      );
    };
  },
});
