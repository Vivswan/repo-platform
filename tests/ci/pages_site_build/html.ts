// CSS-selector reads over built HTML, so the build asserts pin elements instead of grepping markup.
// Text is collected up to each match's own end tag and a nested match takes it from there on, so callers select leaves or use the child combinator.

export interface MatchedElement {
  attrs: Record<string, string>;
  text: string;
}

export function select(html: string, selector: string): MatchedElement[] {
  const found: MatchedElement[] = [];
  let open: MatchedElement | undefined;
  new HTMLRewriter()
    .on(selector, {
      element(element) {
        const match: MatchedElement = { attrs: Object.fromEntries(element.attributes), text: "" };
        found.push(match);
        if (!element.canHaveContent) return;
        open = match;
        element.onEndTag(() => {
          open = undefined;
        });
      },
      text(chunk) {
        if (open) open.text += chunk.text;
      },
    })
    .transform(html);
  return found;
}

export function texts(html: string, selector: string): string[] {
  return select(html, selector).map((element) => element.text);
}
