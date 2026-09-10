import { describe, expect, test } from "bun:test";
import { tierRouteGuard } from "../../../actions/pages-site/.vitepress/theme/tier-routes.ts";

interface Tier {
  base: string;
  roots: string[];
}

/** A project-pages docs site with two tags: the root tier's base prefixes
 *  every other tier's. */
const ROOT: Tier = { base: "/repo/", roots: ["/repo/latest/", "/repo/v2.0.0/", "/repo/v1.0.0/"] };
const LATEST: Tier = { base: "/repo/latest/", roots: ROOT.roots };
/** A versioned site before its first tag: the root is built from HEAD and
 *  latest/ is the one version served. */
const NO_TAGS: Tier = { base: "/repo/", roots: ["/repo/latest/"] };
/** A custom-domain site, served at the origin's root. */
const DOMAIN_ROOT: Tier = { base: "/", roots: ["/latest/", "/v2.0.0/"] };
/** The docs mount of a site that also has a website at the repo root. */
const MOUNTED_LATEST: Tier = {
  base: "/repo/docs/latest/",
  roots: ["/repo/docs/latest/", "/repo/docs/v1.0.0/"],
};
/** An unversioned mount: the theme is fed no version list at all. */
const UNVERSIONED: Tier = { base: "/repo/", roots: [] };

interface Case {
  tier: Tier;
  /** The router's normalized route. */
  to: string;
  /** The document's own path; a page of the tier unless the case is a boot. */
  here?: string;
  outcome: "routed" | "left";
}

const CASES: [string, Case][] = [
  ["the root tier's own landing", { tier: ROOT, to: "/repo/", outcome: "routed" }],
  [
    "a page of the root tier",
    { tier: ROOT, to: "/repo/guide/setup.html?q=1#install", outcome: "routed" },
  ],
  ["a locale of the root tier", { tier: ROOT, to: "/repo/zh-cn/", outcome: "routed" }],
  ["latest from the root tier", { tier: ROOT, to: "/repo/latest/", outcome: "left" }],
  [
    "a deep link into a tag from the root tier",
    { tier: ROOT, to: "/repo/v2.0.0/guide/#top", outcome: "left" },
  ],
  [
    "boot of the root tier's 404 document, served for a missing latest page",
    {
      tier: ROOT,
      to: "/repo/latest/missing.html",
      here: "/repo/latest/missing.html",
      outcome: "routed",
    },
  ],
  [
    "boot of the root tier's 404 document, served for a directory of a served tag",
    { tier: ROOT, to: "/repo/v1.0.0/gone/", here: "/repo/v1.0.0/gone/", outcome: "routed" },
  ],
  [
    "latest from the latest tier (the version being read)",
    { tier: LATEST, to: "/repo/latest/", outcome: "routed" },
  ],
  ["a page of the latest tier", { tier: LATEST, to: "/repo/latest/setup.html", outcome: "routed" }],
  ["a locale of the latest tier", { tier: LATEST, to: "/repo/latest/zh-cn/", outcome: "routed" }],
  ["the root tier from the latest tier", { tier: LATEST, to: "/repo/", outcome: "left" }],
  [
    "a tag from the latest tier (a base of the same length: the router served this tier's page)",
    { tier: LATEST, to: "/repo/v1.0.0/", outcome: "left" },
  ],
  [
    "a sibling repository's site on the same origin",
    { tier: LATEST, to: "/other-repo/", outcome: "left" },
  ],
  ["latest from an untagged root tier", { tier: NO_TAGS, to: "/repo/latest/", outcome: "left" }],
  ["a page of a custom-domain root tier", { tier: DOMAIN_ROOT, to: "/guide/", outcome: "routed" }],
  ["latest from a custom-domain root tier", { tier: DOMAIN_ROOT, to: "/latest/", outcome: "left" }],
  [
    "a page of a mounted latest tier",
    { tier: MOUNTED_LATEST, to: "/repo/docs/latest/api.html", outcome: "routed" },
  ],
  [
    "the docs root from a mounted latest tier",
    { tier: MOUNTED_LATEST, to: "/repo/docs/", outcome: "left" },
  ],
  [
    "the website from a mounted latest tier",
    { tier: MOUNTED_LATEST, to: "/repo/", outcome: "left" },
  ],
  [
    "a page of an unversioned site",
    { tier: UNVERSIONED, to: "/repo/guide.html", outcome: "routed" },
  ],
  ["the origin root from an unversioned site", { tier: UNVERSIONED, to: "/", outcome: "left" }],
];

describe("tierRouteGuard", () => {
  test.each(CASES)("%s", (_name, { tier, to, here, outcome }) => {
    const left: string[] = [];
    const guard = tierRouteGuard(tier.base, tier.roots, {
      here: () => here ?? `${tier.base}current.html`,
      leave: (href) => left.push(href),
    });
    const verdict = guard(to);
    expect({ verdict, left }).toEqual(
      outcome === "routed" ? { verdict: undefined, left: [] } : { verdict: false, left: [to] },
    );
  });
});
