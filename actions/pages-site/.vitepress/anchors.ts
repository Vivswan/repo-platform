// Heading ids as GitHub assigns them, so a `#fragment` written for the
// README on GitHub (`new-repo.md#3-add-checks-to-checksyml`) reaches the
// same heading on the site. VitePress's own slugify turns punctuation into
// hyphens and prefixes a leading digit with `_`, so those links 404 while
// its dead-link check, which ignores fragments, passes them.

import { decodeHTML } from "entities";

/** GitHub's heading slug over the heading's rendered text: entities
 *  decoded (VitePress hands the anchor plugin `&amp;` as written; GitHub
 *  slugs the `&`), lowercased, every character that is not a letter,
 *  number, mark, space, hyphen, or underscore dropped, spaces to hyphens
 *  (consecutive ones kept, as GitHub keeps them). The text is trimmed
 *  first: the anchor plugin hands over the heading's text and code tokens
 *  alone, so an emoji at the end leaves a space GitHub never sees.
 *  markdown-it-anchor appends `-1`, `-2` to repeats, as GitHub does. */
export function githubSlug(text: string): string {
  return decodeHTML(text)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "")
    .replace(/\s/g, "-");
}
