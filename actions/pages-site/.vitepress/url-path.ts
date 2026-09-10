// A URL path and the file path it names, converted segment by segment: a
// `#` or `?` in a file name is that name's own character, so it travels
// percent-encoded as path data (decodeURI and encodeURI would keep or
// emit it as the URL's fragment or query delimiter instead).

/** A URL path as the file path it names, the way a static server reads a
 *  request: each run of well-formed escapes decodes (a multi-byte
 *  character's escapes together), a run that is not UTF-8 and a stray `%`
 *  stay as written. So `100%a%23b` names `100%a#b`, the spelling VitePress
 *  leaves in a rendered href after decoding the `%25` of `100%25a%23b`. */
export function decodePathSegments(path: string): string {
  return path.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

/** A file path as a URL path. */
export function encodePathSegments(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}
