// The spellings of a repository slug the runner's masker must cover before a private target's name
// can reach a public log. The masker matches case-sensitive substrings: the slug covers every URL
// spelling of itself, and the bare name covers the slug; a name under the floor rides the slug alone.

/** The bare name is masked from four characters: a shorter one appears
 *  inside too many innocent words for a substring masker. */
export const MIN_MASKED_NAME = 4;

export function maskForms(slug: string): string[] {
  const name = slug.split("/").pop() ?? slug;
  const forms = name.length >= MIN_MASKED_NAME ? [slug, name] : [slug];
  return [...new Set(forms.flatMap((form) => [form, form.toLowerCase()]))];
}
