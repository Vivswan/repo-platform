// The custom-block titles in sentence case, in one place for the two
// VitePress plugins that render them: the `:::` container plugin takes the
// labels as options, while VitePress 1.6 installs its GitHub-alert plugin
// (`> [!NOTE]`) with no options, so a core rule retitles those tokens from
// the same table.

import type { MarkdownOptions, MarkdownRenderer } from "vitepress";

export const CUSTOM_BLOCK_LABELS = {
  infoLabel: "Info",
  noteLabel: "Note",
  tipLabel: "Tip",
  warningLabel: "Warning",
  dangerLabel: "Danger",
  detailsLabel: "Details",
  importantLabel: "Important",
  cautionLabel: "Caution",
} satisfies NonNullable<MarkdownOptions["container"]>;

type LabelKey = keyof typeof CUSTOM_BLOCK_LABELS;

/** An author-written title spelling the uppercase default reaches the token indistinguishable from none;
 *  the fleet reads labels in sentence case anyway, so it is retitled the same way. */
export function alertTitlesRule(md: MarkdownRenderer): void {
  md.core.ruler.after("github-alerts", "alert_titles", (state) => {
    for (const token of state.tokens) {
      if (token.type !== "github_alert_open") continue;
      const { title, type } = token.meta as { title: string; type: string };
      if (title !== type.toUpperCase()) continue;
      const key = `${type}Label`;
      if (!(key in CUSTOM_BLOCK_LABELS)) {
        throw new Error(`GitHub alert type '${type}' has no sentence-case label`);
      }
      token.meta = { ...token.meta, title: CUSTOM_BLOCK_LABELS[key as LabelKey] };
    }
  });
}
