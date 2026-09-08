// Plain text for inline tokens, computed once per parse in the shared
// markdown-it instance: a core rule stamps every inline token's visible
// text on it before markdown-it's text_join merges entity and escape
// tokens back into text (VitePress keeps `&amp;` as written there so Vue
// can decode it). The landing-table rule and the page index read the
// stamp, so a label, a note, and a heading title all spell text one way:
// entities and escapes decoded, code spans literal, emoji as their glyph,
// images as their alt text, markup dropped.

import type { Token } from "markdown-it";
import type { MarkdownRenderer } from "vitepress";

const STAMP = "plainText";

export function inlineTextRule(md: MarkdownRenderer): void {
  md.core.ruler.before("text_join", "inline_text", (state) => {
    for (const token of state.tokens) {
      if (token.type !== "inline") continue;
      token.meta = { ...token.meta, [STAMP]: textOf(token.children ?? []) };
    }
  });
}

/** The stamped text of an inline token, whitespace collapsed. Throws when
 *  the token came from a renderer without inlineTextRule: the stamp is the
 *  contract, not an optional extra. */
export function plainTextOf(token: Token): string {
  const stamped: unknown = token.meta?.[STAMP];
  if (typeof stamped !== "string") {
    throw new Error("inline token carries no plain text: inlineTextRule is not installed");
  }
  return stamped.replace(/\s+/g, " ").trim();
}

function textOf(children: Token[]): string {
  const parts: string[] = [];
  for (const child of children) {
    switch (child.type) {
      case "text":
      case "text_special":
      case "code_inline":
      case "emoji":
        parts.push(child.content);
        break;
      case "image":
        parts.push(textOf(child.children ?? []));
        break;
      case "softbreak":
      case "hardbreak":
        parts.push(" ");
        break;
    }
  }
  return parts.join("");
}
