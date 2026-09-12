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
          "aria-label": "Version",
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
