// Heading ids as GitHub assigns them, so a `#fragment` written for the
// README on GitHub (`new-repo.md#3-add-checks-to-checksyml`) reaches the
// same heading on the site. VitePress's own slugify turns punctuation into
// hyphens and prefixes a leading digit with `_`, so those links 404 while
// its dead-link check, which ignores fragments, passes them.

import { decodeHTML } from "entities";
import { slug } from "github-slugger";
import type { Token } from "markdown-it";

/** Text decoded ONCE, a code span literal, any other token nothing.
 *  VitePress's text_join joins an entity back as its markup and an escaped `\&` as `&amp;`, so one decode is the text GitHub slugs.
 *    `## Use &amp;amp;`     -> `use-amp` on both
 *    `&amp;` inside backticks -> the text "&amp;", as on GitHub */
function tokenText(token: Token): string {
  if (token.type === "text") {
    return decodeHTML(token.content);
  }

  if (token.type === "code_inline") {
    return token.content;
  }

  return "";
}

/** The anchor plugin's getTokensText hook. */
export function headingText(tokens: Token[]): string {
  return tokens.map(tokenText).join("");
}

/** github-slugger is the reference implementation of GitHub's rule, so a heading ending in an emoji slugs to a trailing hyphen on both.
 *  Repeats need no handling here: markdown-it-anchor appends `-1`, `-2` as GitHub does. */
export function githubSlug(text: string): string {
  return slug(text);
}
