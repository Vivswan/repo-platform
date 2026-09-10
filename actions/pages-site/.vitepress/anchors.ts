// Heading ids as GitHub assigns them, so a `#fragment` written for the
// README on GitHub (`new-repo.md#3-add-checks-to-checksyml`) reaches the
// same heading on the site. VitePress's own slugify turns punctuation into
// hyphens and prefixes a leading digit with `_`, so those links 404 while
// its dead-link check, which ignores fragments, passes them.

import { decodeHTML } from "entities";
import type { Token } from "markdown-it";

/** The heading text GitHub slugs, from the heading's inline tokens: text
 *  with its entities decoded (VitePress hands `&amp;` over as written;
 *  GitHub slugs the `&`) and code spans literal (a `&amp;` inside
 *  backticks IS the text "&amp;" on GitHub). The anchor plugin's
 *  getTokensText hook. */
export function headingText(tokens: Token[]): string {
  return tokens
    .map((token) =>
      token.type === "text"
        ? decodeHTML(token.content)
        : token.type === "code_inline"
          ? token.content
          : "",
    )
    .join("");
}

/** GitHub's heading slug: lowercased, every character that is not a
 *  letter, number, mark, space, hyphen, or underscore dropped, spaces to
 *  hyphens (consecutive ones kept, as GitHub keeps them). The text is
 *  trimmed first: headingText carries only text and code tokens, so an
 *  emoji at the end leaves a space GitHub never sees. markdown-it-anchor
 *  appends `-1`, `-2` to repeats, as GitHub does. */
export function githubSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "")
    .replace(/\s/g, "-");
}
