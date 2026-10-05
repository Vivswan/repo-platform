// A directory's display title, as the sidebar names a folder.

/** Every word capitalized, so a folder name sits beside the Title Case page titles around it.
 *    `api-reference`         -> `Api Reference`
 *    `guide/getting-started` -> `Guide/Getting Started` */
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
