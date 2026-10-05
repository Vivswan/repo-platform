// Seats the search launcher's panel on each root landing page where docs/modules/site.md ("Docs conventions") says.
//
// The rule judges the ROUTE because VitePress renders a landing under both spellings, and the tag it adds carries no
// text, so the indexer's pass is unchanged by it.
//   the page build           -> the post-rewrite index.md
//   the local-search indexer -> the source README.md

import type { MarkdownRenderer } from "vitepress";
import { isLocaleDir } from "./conventions.ts";
import { routeOf } from "./derive.ts";

const LOCALE_ROOT_ROUTE_RE = /^\/(?:([^/]+)\/)?$/;

export function isLandingPath(relativePath: string, rewrites: Record<string, string>): boolean {
  const match = LOCALE_ROOT_ROUTE_RE.exec(routeOf(relativePath, rewrites));
  return match !== null && (match[1] === undefined || isLocaleDir(match[1]));
}

/** The tag index.ts registers; an unregistered tag renders empty. */
export const LAUNCHER_TAG = "<FleetLauncher></FleetLauncher>\n";

/** `rewrites` is the same README-to-index map config.mts hands VitePress (derive.ts's deriveRewrites). */
export function landingLauncherRule(md: MarkdownRenderer, rewrites: Record<string, string>): void {
  md.core.ruler.push("landing_launcher", (state) => {
    const relativePath = (state.env as { relativePath?: unknown }).relativePath;
    if (typeof relativePath !== "string" || !isLandingPath(relativePath, rewrites)) return;
    const tokens = state.tokens;
    const block = new state.Token("html_block", "", 0);
    block.content = LAUNCHER_TAG;
    block.block = true;
    const section = tokens.findIndex(
      (token) => token.type === "heading_open" && token.tag === "h2" && token.level === 0,
    );
    tokens.splice(section === -1 ? tokens.length : section, 0, block);
  });
}
