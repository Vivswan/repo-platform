// Wraps every top-level markdown table in <div class="vp-table"> so the
// theme can give tables a horizontal-scroll fallback (components.css) while
// the table itself keeps display: table and full width: a table wider than
// the doc column scrolls inside the wrapper instead of clipping at the
// viewport. Tables nested in a blockquote or list item are left alone.

// Typed through vitepress's renderer, the type preConfig hands over, so the
// rule cannot drift from the markdown-it typings vitepress binds to.
import type { MarkdownRenderer } from "vitepress";

type StateCore = Parameters<MarkdownRenderer["core"]["process"]>[0];
type Token = StateCore["tokens"][number];

export const TABLE_WRAP_CLASS = "vp-table";

function htmlBlock(state: StateCore, content: string): Token {
  const token = new state.Token("html_block", "", 0);
  token.content = content;
  token.block = true;
  return token;
}

export function tableWrapRule(md: MarkdownRenderer): void {
  md.core.ruler.push("fleet_table_wrap", (state) => {
    const wrapped: Token[] = [];
    for (const token of state.tokens) {
      const topLevel = token.level === 0;
      if (topLevel && token.type === "table_open") {
        wrapped.push(htmlBlock(state, `<div class="${TABLE_WRAP_CLASS}">\n`));
      }
      wrapped.push(token);
      if (topLevel && token.type === "table_close") {
        wrapped.push(htmlBlock(state, "</div>\n"));
      }
    }
    state.tokens = wrapped;
  });
}
