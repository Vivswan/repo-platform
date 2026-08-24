// The `_src_path` rewrite shared by the push sync (normalize_src.ts,
// canonical gh: source) and the local rehearsal (rehearse.ts, a local
// build). The recorded value is target-controlled and never trusted -
// repos generated from a local checkout record a filesystem path - so it
// is rewritten before any copier command runs. Pure on purpose: the
// callers decide what may print (the recorded value is target-derived,
// withheld for hide-details targets).

/** Rewrite the _src_path line to `canonical`. Returns the previously
 * recorded value and the rewritten text, or null when the file carries no
 * _src_path line. */
export function rewriteSrcPath(
  text: string,
  canonical: string,
): { recorded: string; rewritten: string } | null {
  const match = text.match(/^_src_path:.*$/m);
  if (match === null) return null;
  return {
    recorded: match[0].replace(/^_src_path:\s*/, ""),
    rewritten: text.replace(/^_src_path:.*$/m, `_src_path: ${canonical}`),
  };
}
