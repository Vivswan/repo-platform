// The version menu is VitePress's own nav flyout. Every tier is a separate build under its own base, so an item is an
// absolute URL with a target: VPLink prefixes this build's base onto any root-relative href, and the client router
// hands any targeted link to the browser (tier-routes.ts guards the in-content links the same way).

import type { ThemeConfig } from "vitepress-carbon";

export type VersionLink = { label: string; link: string };

/** `current` is the tier being read (DOCS_SITE_CURRENT): it names the menu; its entry is marked in the flyout only,
 *  since carbon's narrow-screen list ignores activeMatch.
 *  One served version alone (an untagged root beside latest/, the same content twice) shows no menu. */
export function versionNav(
  versions: VersionLink[],
  current: string,
  origin: string,
): NonNullable<ThemeConfig["nav"]> {
  if (versions.length < 2) return [];
  return [
    {
      text: current,
      items: versions.map(({ label, link }) => ({
        text: label,
        link: origin + link,
        target: "_self",
        // Every page of this build belongs to the tier being read, so its entry is active on all of them.
        ...(label === current ? { activeMatch: "^/" } : {}),
      })),
    },
  ];
}
