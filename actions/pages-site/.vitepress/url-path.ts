// A URL path and the file path it names, converted segment by segment: a
// `#` or `?` in a file name is that name's own character, so it travels
// percent-encoded as path data (decodeURI and encodeURI would keep or
// emit it as the URL's fragment or query delimiter instead).

/** Runs of escapes decode together so a multi-byte character survives; a run that is not UTF-8 and a stray `%`
 *  stay as written, the way a static server reads a request.
 *    `100%a%23b` -> `100%a#b`, the spelling VitePress leaves in a rendered href after decoding the `%25` of `100%25a%23b` */
export function decodePathSegments(path: string): string {
  return path.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

export function encodePathSegments(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}
