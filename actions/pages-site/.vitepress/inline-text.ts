// Stamped before text_join: VitePress's text_join puts `&amp;` back as written so Vue can decode it, and the stamp wants the decoded text.
// The landing-table rule and the page index read the stamp, so a label, a note, and a heading title all spell text one way.

import type { Token } from "markdown-it";
import type { MarkdownRenderer } from "vitepress";

const STAMP = "plainText";
const BR_RE = /^<br\s*\/?>$/i;

export function inlineTextRule(md: MarkdownRenderer): void {
  md.core.ruler.before("text_join", "inline_text", (state) => {
    for (const token of state.tokens) {
      if (token.type !== "inline") continue;
      token.meta = { ...token.meta, [STAMP]: textOf(token.children ?? []) };
    }
  });
}

/** A token from a renderer without inlineTextRule throws: the stamp is the contract, not an optional extra. */
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
      case "html_inline":
        if (BR_RE.test(child.content)) parts.push(" ");
        break;
    }
  }
  return parts.join("");
}
