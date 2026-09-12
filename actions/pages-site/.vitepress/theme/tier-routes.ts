// Every tier of a versioned site (latest/, each tag, the root) is its own
// VitePress build under its own base, and the client router serves every
// same-origin html link from THIS build's page map (vitepress's
// dist/client/app/router.js, the window click listener; pathToFile in
// utils.js keys the map by the path with THIS base's length sliced off).
// A link into another tier therefore rendered the SPA's 404, or, when the
// two bases are the same length (latest/ and v2.0.0/), this tier's own page
// at the other tier's URL, which the router then rewrote back: a reload in
// place. The guard hands those routes to the browser instead.

/** `tierRoots` are the versions' roots (themeConfig.docsSiteVersions links): the root tier's base prefixes every one
 *  of them, so the base prefix alone cannot tell its own pages from another version's. */
function leavesTier(path: string, base: string, tierRoots: readonly string[]): boolean {
  if (!path.startsWith(base)) return true;
  return tierRoots.some((root) => root !== base && path.startsWith(root));
}

export interface Browser {
  /** The path the document was served for (location.pathname). */
  here: () => string;
  /** A full page load of `to`. */
  leave: (to: string) => void;
}

/** `to` is the router's normalized path with its search and hash. A route to the document's own path never leaves:
 *  the router resolves that one on boot, and the document may be the root tier's 404.html, which the server sends
 *  for a missing path in ANY tier. */
export function tierRouteGuard(
  base: string,
  tierRoots: readonly string[],
  browser: Browser,
): (to: string) => false | undefined {
  return (to) => {
    const { pathname } = new URL(to, "http://tier.invalid");
    if (pathname === browser.here() || !leavesTier(pathname, base, tierRoots)) return undefined;
    browser.leave(to);
    return false;
  };
}
