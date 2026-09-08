// A directory's display title, shared by the sidebar derivation and the
// launcher's directory groups so both name a folder the same way. Browser-
// safe: the launcher's client bundle imports it.

/** `api-reference` -> `Api Reference`: dashes and underscores become spaces
 *  and every word starts with a capital, so a folder name sits beside the
 *  Title Case page titles around it. A nested path keeps its slashes, each
 *  segment titled (`guide/getting-started` -> `Guide/Getting Started`). */
export function dirTitle(dir: string): string {
  return dir
    .split("/")
    .map((segment) =>
      segment
        .split(/[-_]/)
        .filter((word) => word !== "")
        .map((word) => word[0].toUpperCase() + word.slice(1))
        .join(" "),
    )
    .join("/");
}
