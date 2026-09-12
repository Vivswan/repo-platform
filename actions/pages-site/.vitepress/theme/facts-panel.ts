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

function row(label: Cell, value: Cell): VNode {
  return h("div", { class: "fleet-facts-row" }, [h("dt", label), h("dd", value)]);
}

/** A counted group: the label with its count, then the items as a nested
 *  list INSIDE the value cell, so the one markup lays out both ways: as
 *  indented rows under the count in the aside (facts.css places the
 *  nested lists on the card's shared label column), and as one inline run
 *  next to the label when the card sits in flow. */
function group(label: string, items: [Cell, Cell][]): VNode {
  return h("div", { class: "fleet-facts-row fleet-facts-group" }, [
    h("dt", label),
    h("dd", [
      h("span", { class: "fleet-facts-count" }, String(items.length)),
      h(
        "dl",
        { class: "fleet-facts-items" },
        items.map(([name, value]) =>
          h("div", { class: "fleet-facts-item" }, [h("dt", name), h("dd", value)]),
        ),
      ),
    ]),
  ]);
}

function section(rows: VNode[]): VNode {
  return h("dl", { class: "fleet-facts-section" }, rows);
}

/** The scheme and a trailing slash carry nothing on a card whose value
 *  column is 200px wide. */
function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

/** A path-like value (`owner/repo`, `host/path`) as one segment per slash,
 *  each an inline block (facts.css) with a `<wbr>` between them: a
 *  value too wide for the column splits at a slash, and only a segment too
 *  wide on its own breaks inside a word. A bare `<wbr>` is not enough: a
 *  hyphen later in the value is the break the line breaker prefers. */
function slashBreakable(text: string): VNode[] {
  const parts = text.split("/");
  return parts.flatMap((part, index) => {
    const segment = h(
      "span",
      { class: "fleet-facts-segment" },
      index === parts.length - 1 ? part : `${part}/`,
    );
    return index === parts.length - 1 ? [segment] : [segment, h("wbr")];
  });
}

/** Topics as a list of chips: each chip is a flex item, so a hyphenated
 *  topic moves to the next line whole instead of breaking at its hyphen.
 *  The explicit role keeps the list a list where `list-style: none`
 *  drops the native semantics (Safari). */
function topicChips(topics: string[]): VNode {
  return h(
    "ul",
    { class: "fleet-facts-topics", role: "list" },
    topics.map((topic) => h("li", { class: "fleet-facts-topic" }, topic)),
  );
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
          h(
            "a",
            { class: "fleet-facts-repository", href: facts.repoUrl },
            slashBreakable(facts.repository),
          ),
        ),
      ];
      if (facts.homepage !== null) {
        about.push(
          row(
            "Homepage",
            h("a", { href: facts.homepage }, slashBreakable(shortUrl(facts.homepage))),
          ),
        );
      }
      if (facts.topics.length > 0) about.push(row("Topics", topicChips(facts.topics)));

      const sections: VNode[] = [section(about)];

      if (facts.toolchains.length > 0) {
        sections.push(
          section([
            group(
              "Toolchain",
              facts.toolchains.map((tool) => [tool.name, tool.version]),
            ),
          ]),
        );
      }

      const versions = theme.value.docsSiteVersions ?? [];
      if (versions.length > 0) {
        const current = theme.value.docsSiteCurrent ?? "";
        sections.push(
          section([
            group(
              "Versions",
              versions.map(({ label, link }) => [
                h(
                  "a",
                  { href: link, "aria-current": label === current ? "true" : undefined },
                  label,
                ),
                label === current ? note("reading") : "",
              ]),
            ),
          ]),
        );
      }

      if (facts.license !== null) {
        const href = `${facts.repoUrl}/blob/${facts.provenance.label}/${facts.license.path}`;
        sections.push(section([row("License", h("a", { href }, facts.license.name))]));
      }

      // No title and no heading: the landing h1 beside the card already
      // names the project, and the aside-top slot renders before that h1.
      return h("aside", { class: "fleet-facts", "aria-label": "About" }, [
        facts.description === null
          ? null
          : h("p", { class: "fleet-facts-description" }, facts.description),
        h("hr", { class: "fleet-facts-rule" }),
        h("div", { class: "fleet-facts-body" }, sections),
      ]);
    };
  },
});
