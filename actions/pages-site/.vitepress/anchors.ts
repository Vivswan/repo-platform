// Heading ids as GitHub assigns them, so a `#fragment` written for the
// README on GitHub (`new-repo.md#3-add-checks-to-checksyml`) reaches the
// same heading on the site. VitePress's own slugify turns punctuation into
// hyphens and prefixes a leading digit with `_`, so those links 404 while
// its dead-link check, which ignores fragments, passes them.

import { decodeHTML } from "entities";
import { slug } from "github-slugger";
import type { Token } from "markdown-it";

/** The heading text GitHub slugs, from the heading's inline tokens: text
 *  decoded ONCE and code spans literal (a `&amp;` inside backticks IS the
 *  text "&amp;" on GitHub). VitePress's text_join (restoreEntities) joins
 *  an entity back as its markup and an escaped `\&` as `&amp;`, so a text
 *  token spells `&amp;` exactly as the author wrote it and one decode is
 *  the text GitHub slugs: `## Use &amp;amp;` is `use-amp` on both. The
 *  anchor plugin's getTokensText hook. */
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

/** GitHub's heading slug, from github-slugger (the reference
 *  implementation of GitHub's own rule): lowercased, punctuation and
 *  symbols dropped, spaces to hyphens, nothing trimmed, so a heading ending
 *  in an emoji slugs to a trailing hyphen on both. markdown-it-anchor
 *  appends `-1`, `-2` to repeats, as GitHub does. */
export function githubSlug(text: string): string {
  return slug(text);
}
