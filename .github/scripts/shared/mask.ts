// The spellings of a repository slug the runner's masker must cover before
// a private target's name can reach a public log.

/** The bare name is masked from four characters: a shorter one appears
 *  inside too many innocent words for a substring masker. */
export const MIN_MASKED_NAME = 4;

/** Every spelling of `slug` a log line could carry, deduplicated. */
export function maskForms(slug: string): string[] {
  const name = slug.split("/").pop() ?? slug;
  const forms = [
    slug,
    `https://github.com/${slug}`,
    `https://github.com/${slug}.git`,
    `git@github.com:${slug}.git`,
  ];
  if (name.length >= MIN_MASKED_NAME) forms.push(name);
  return [...new Set(forms.flatMap((form) => [form, form.toLowerCase()]))];
}
