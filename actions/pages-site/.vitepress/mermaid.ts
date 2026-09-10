// A ```mermaid fence renders as a diagram in the browser (theme/mermaid.ts),
// so it leaves the highlighter path: the fence becomes a mount holding the
// source in a <pre>, which is also what no-JS readers and paper get. The
// mount is v-pre because `{{ }}` is mermaid syntax (a hexagon node) and Vue
// would otherwise compile it as an interpolation.

import type { MarkdownRenderer } from "vitepress";

type RenderRule = NonNullable<MarkdownRenderer["renderer"]["rules"]["fence"]>;
type Token = Parameters<RenderRule>[0][number];

export const MERMAID_CLASS = "fleet-mermaid";
export const MERMAID_SOURCE_CLASS = "fleet-mermaid-source";
/** The info string's first word, so `mermaid {1}` and `mermaid:line-numbers`
 *  count and `mermaidjs` does not. */
const MERMAID_INFO = /^mermaid(?![\w-])/;
/** VitePress's code-group container marks its first fence `active` in the
 *  info string (its own fence wrapper reads and strips the same marker). */
const ACTIVE_MARKER = / active( |$)/;
const CODE_GROUP_OPEN = "container_code-group_open";
const CODE_GROUP_CLOSE = "container_code-group_close";

/** Whether the fence at `idx` sits inside a `::: code-group` container: the
 *  nearest unmatched open before it. */
function inCodeGroup(tokens: Token[], idx: number): boolean {
  let closed = 0;
  for (let i = idx - 1; i >= 0; i -= 1) {
    if (tokens[i].type === CODE_GROUP_CLOSE) closed += 1;
    else if (tokens[i].type === CODE_GROUP_OPEN) {
      if (closed === 0) return true;
      closed -= 1;
    }
  }
  return false;
}

/** Must run in markdown.config, after VitePress wraps the fence renderer
 *  (highlighter, copy button, line numbers): a mermaid fence bypasses them
 *  all, every other fence reaches them untouched. Inside a code group the
 *  mount is a `vp-block`, the class VitePress gives a group's non-code
 *  block, so the tabs show and hide it like its sibling fences. */
export function mermaidRule(md: MarkdownRenderer): void {
  const installed: RenderRule =
    md.renderer.rules.fence ??
    ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    if (!MERMAID_INFO.test(token.info.trim())) return installed(tokens, idx, options, env, self);
    const classes = [MERMAID_CLASS];
    if (inCodeGroup(tokens, idx)) {
      classes.push("vp-block");
      if (ACTIVE_MARKER.test(token.info)) classes.push("active");
    }
    const source = md.utils.escapeHtml(token.content.replace(/\n$/, ""));
    return `<div class="${classes.join(" ")}" v-pre><pre class="${MERMAID_SOURCE_CLASS}">${source}</pre></div>\n`;
  };
}
