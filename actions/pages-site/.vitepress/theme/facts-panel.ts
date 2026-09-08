// The project facts card in the landing page's aside. Both inputs are
// build-time contracts with config.mts: themeConfig.docsSiteFacts and the
// landing page's frontmatter.fleetLanding.

import { useData } from "vitepress";
import { defineComponent, h, type VNode } from "vue";
import type { ProjectFacts } from "../../facts.ts";

interface VersionLink {
  label: string;
  link: string;
}

interface FactsTheme {
  docsSiteFacts?: ProjectFacts;
  docsSiteVersions?: VersionLink[];
  docsSiteCurrent?: string;
}

type Cell = string | VNode | (string | VNode)[];

function row(label: Cell, value: Cell, sub = false): VNode {
  return h("tr", { class: sub ? "fleet-facts-sub" : undefined }, [
    h("th", { scope: "row" }, label),
    h("td", value),
  ]);
}

function section(rows: VNode[]): VNode {
  return h("div", { class: "fleet-facts-section" }, [h("table", [h("tbody", rows)])]);
}

/** The scheme and a trailing slash carry nothing on a card whose value
 *  column is 200px wide. */
function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

function note(text: string): VNode {
  return h("span", { class: "fleet-facts-note" }, text);
}

export default defineComponent({
  name: "FactsPanel",
  setup() {
    const { theme, frontmatter } = useData<FactsTheme>();
    return () => {
      const facts = theme.value.docsSiteFacts;
      if (frontmatter.value.fleetLanding !== true || facts === undefined) return null;

      const about: VNode[] = [
        row(
          "Repository",
          h("a", { class: "fleet-facts-repository", href: facts.repoUrl }, facts.repository),
        ),
      ];
      if (facts.homepage !== null) {
        about.push(row("Homepage", h("a", { href: facts.homepage }, shortUrl(facts.homepage))));
      }
      if (facts.topics.length > 0) about.push(row("Topics", facts.topics.join(", ")));

      const sections: VNode[] = [section(about)];

      if (facts.toolchains.length > 0) {
        sections.push(
          section([
            row("Toolchain", String(facts.toolchains.length)),
            ...facts.toolchains.map((tool) => row(tool.name, tool.version, true)),
          ]),
        );
      }

      const versions = theme.value.docsSiteVersions ?? [];
      if (versions.length > 0) {
        const current = theme.value.docsSiteCurrent ?? "";
        sections.push(
          section([
            row("Versions", String(versions.length)),
            ...versions.map(({ label, link }) =>
              row(
                h(
                  "a",
                  { href: link, "aria-current": label === current ? "true" : undefined },
                  label,
                ),
                label === current ? note("reading") : "",
                true,
              ),
            ),
          ]),
        );
      }

      if (facts.license !== null) {
        const href = `${facts.repoUrl}/blob/${facts.provenance.label}/${facts.license.path}`;
        sections.push(section([row("License", h("a", { href }, facts.license.name))]));
      }

      return h("aside", { class: "fleet-facts", "aria-labelledby": "fleet-facts-title" }, [
        h("h2", { class: "fleet-facts-title", id: "fleet-facts-title" }, facts.name),
        facts.description === null
          ? null
          : h("p", { class: "fleet-facts-description" }, facts.description),
        h("hr", { class: "fleet-facts-rule" }),
        ...sections,
      ]);
    };
  },
});
