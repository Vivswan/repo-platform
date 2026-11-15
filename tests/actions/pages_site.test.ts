// The address a deploy builds for is GitHub's own report of where it serves the site (configure-pages' base_url). The
// rule stays for a build with no Pages API to ask, so the two must agree wherever the rule is right.

import { describe, expect, test } from "bun:test";
import { pagesSite, pagesSiteAt } from "../../actions/shared/pages_site.ts";

describe("pagesSiteAt", () => {
  // configure-pages strips the trailing slash the Pages API's html_url carries, and every reader of the base path
  // joins onto a trailing slash (`/repo/` + `assets/`): a slashless base would glue `/repoassets/` with no failure.
  test.each([
    { url: "https://owner.github.io/repo", origin: "https://owner.github.io", basePath: "/repo/" },
    { url: "https://owner.github.io/repo/", origin: "https://owner.github.io", basePath: "/repo/" },
    { url: "https://owner.github.io", origin: "https://owner.github.io", basePath: "/" },
    { url: "https://docs.example.com", origin: "https://docs.example.com", basePath: "/" },
    { url: "https://Docs.Example.com/", origin: "https://docs.example.com", basePath: "/" },
    { url: "http://docs.example.com", origin: "http://docs.example.com", basePath: "/" },
  ])("$url is served at $origin under $basePath", ({ url, origin, basePath }) => {
    expect(pagesSiteAt(url)).toEqual({ origin, basePath });
  });

  // The docs PR check builds by the rule and the deploy by the report: where a repository has no custom domain the
  // two must name one address, or a link the check passed would be laid out elsewhere on deploy.
  test.each([
    { repository: "Owner/Example-Repo", reported: "https://owner.github.io/Example-Repo" },
    { repository: "Owner/Owner.github.io", reported: "https://owner.github.io" },
  ])("the rule for $repository is the address GitHub reports for it, $reported", (row) => {
    expect(pagesSite(row.repository)).toEqual(pagesSiteAt(row.reported));
  });
});
