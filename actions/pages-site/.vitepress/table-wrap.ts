// Wraps every top-level markdown table in <div class="vp-table" tabindex="0">
// so the theme can make the WRAPPER the horizontal scroller (components.css):
// a table wider than the doc column scrolls inside the wrapper instead of
// clipping at the viewport, and the wrapper, not the table, is the tab stop
// keyboard users scroll from. VitePress renders every table as
// <table tabindex="0"> because its own theme scrolls the table itself; on a
// wrapped table that would be a second stop that scrolls nothing, so the
// wrapped table drops it. A table nested in a blockquote or list item gets
// no wrapper, keeps carbon's scrolling block, and so keeps that tab stop.

// Typed through vitepress's renderer, the type markdown.config hands over,
// so the rule cannot drift from the markdown-it typings vitepress binds to.
import type { MarkdownRenderer } from "vitepress";

type StateCore = Parameters<MarkdownRenderer["core"]["process"]>[0];
type Token = StateCore["tokens"][number];
type RenderRule = NonNullable<MarkdownRenderer["renderer"]["rules"]["table_open"]>;

export const TABLE_WRAP_CLASS = "vp-table";
const WRAPPED = "fleetTableWrapped";

function htmlBlock(state: StateCore, content: string): Token {
  const token = new state.Token("html_block", "", 0);
  token.content = content;
  token.block = true;
  return token;
}

/** Must run in markdown.config (after VitePress installs its table_open
 *  renderer, which the wrapped-table branch below bypasses). */
export function tableWrapRule(md: MarkdownRenderer): void {
  md.core.ruler.push("fleet_table_wrap", (state) => {
    const wrapped: Token[] = [];
    for (const token of state.tokens) {
      const topLevel = token.level === 0;
      if (topLevel && token.type === "table_open") {
        token.meta = { ...token.meta, [WRAPPED]: true };
        wrapped.push(htmlBlock(state, `<div class="${TABLE_WRAP_CLASS}" tabindex="0">\n`));
      }
      wrapped.push(token);
      if (topLevel && token.type === "table_close") {
        wrapped.push(htmlBlock(state, "</div>\n"));
      }
    }
    state.tokens = wrapped;
  });
  const installed: RenderRule =
    md.renderer.rules.table_open ??
    ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.table_open = (tokens, idx, options, env, self) =>
    tokens[idx].meta?.[WRAPPED] ? "<table>\n" : installed(tokens, idx, options, env, self);
}
