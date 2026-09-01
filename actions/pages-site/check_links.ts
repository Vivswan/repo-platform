// Nightly external-link check over the assembled site (docs/docs-site.md,
// "Link rot"): linkinator crawls the built output from a local static
// server, and only EXTERNAL breakage is reported - internal links were
// already fatal at build time. Non-fatal by contract: the deploy has
// already shipped when this runs, so findings become a tracking issue
// (the fuzz-issue action's contract-v1 report directory), never a red
// deploy. A checker crash still fails loudly: "could not look" must never
// read as "no rot".
//
// Env: SITE_DIR (the assembled _site), REPORT_DIR (where the contract-v1
// report directory is written). Output: broken=<count>.

import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LinkChecker } from "linkinator";

function requireEnv(name: string): string {
  const value = process.env[name] ?? "";
  if (value === "") throw new Error(`${name} is required and empty`);
  return value;
}

function setOutput(name: string, value: string): void {
  const out = process.env.GITHUB_OUTPUT ?? "";
  if (out === "") {
    console.log(`(output) ${name}=${value}`);
    return;
  }
  appendFileSync(out, `${name}=${value}\n`);
}

/** Every HTML page in the assembled site, as server-root-relative paths.
 *  Each one seeds the crawl directly: a crawl from the root alone only
 *  reaches pages the root LINKS to, and version tiers are navigated
 *  through a <select>, not anchors, so they would never be checked. */
export function walkHtml(dir: string, prefix = ""): string[] {
  const pages: string[] = [];
  for (const name of readdirSync(join(dir, prefix)).sort()) {
    const rel = prefix === "" ? name : `${prefix}/${name}`;
    if (statSync(join(dir, rel)).isDirectory()) {
      pages.push(...walkHtml(dir, rel));
    } else if (name.endsWith(".html")) {
      pages.push(rel);
    }
  }
  return pages;
}

interface Broken {
  url: string;
  status: number;
  parents: string[];
}

/** Deduplicate broken results by URL, collecting each URL's linking pages. */
export function collectBroken(
  links: { url: string; state: string; status?: number; parent?: string }[],
): Broken[] {
  const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(?=[/?#]|$)/;
  const byUrl = new Map<string, Broken>();
  for (const link of links) {
    if (link.state !== "BROKEN") continue;
    if (!/^https?:\/\//.test(link.url) || local.test(link.url)) continue;
    const entry = byUrl.get(link.url) ?? { url: link.url, status: link.status ?? 0, parents: [] };
    const parent = (link.parent ?? "").replace(local, "");
    if (parent !== "" && !entry.parents.includes(parent)) entry.parents.push(parent);
    byUrl.set(link.url, entry);
  }
  return [...byUrl.values()];
}

/** The contract-v1 failure report (first line a `# title` heading, body
 *  carrying the findings) the fuzz-issue action builds the issue from. */
export function reportBody(broken: Broken[]): string {
  const lines = [
    `# ${broken.length} broken external link${broken.length === 1 ? "" : "s"}`,
    "",
    "The nightly link check found external links in the deployed site that no longer resolve.",
    "The site still deployed; fix or remove the links in the source markdown.",
    "",
  ];
  for (const { url, status, parents } of broken) {
    lines.push(`- ${url} (status ${status || "unreachable"})`);
    for (const parent of parents.slice(0, 5)) lines.push(`  - linked from ${parent}`);
  }
  lines.push("");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const siteDir = requireEnv("SITE_DIR");
  const reportDir = requireEnv("REPORT_DIR");
  const pages = walkHtml(siteDir);
  if (pages.length === 0) {
    throw new Error(`${siteDir} contains no HTML pages - nothing was checked (wrong directory?)`);
  }
  const checker = new LinkChecker();
  // The theme generates a per-page "Edit this page" link into the repo's
  // edit UI; anonymous crawls cannot judge those (auth redirects, plain
  // 404 on private repos), and they are theme output, not authored
  // content, so they are excluded rather than reported as rot forever.
  const editPrefix =
    process.env.GITHUB_REPOSITORY !== undefined && process.env.GITHUB_REPOSITORY !== ""
      ? `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${process.env.GITHUB_REPOSITORY}/edit/`
      : "";
  const result = await checker.check({
    path: pages,
    serverRoot: siteDir,
    concurrency: 25,
    timeout: 30_000,
    retry: true,
    linksToSkip: async (link) => editPrefix !== "" && link.startsWith(editPrefix),
  });
  // The control for a zero-broken reading: a crawl that judged no links at
  // all looked at nothing and must never read as healthy.
  const judged = result.links.filter((link) => link.state !== "SKIPPED");
  if (judged.length === 0) {
    throw new Error("the crawl judged zero links - that is failed-to-look, never link-free");
  }
  const broken = collectBroken(result.links);
  rmSync(reportDir, { recursive: true, force: true });
  setOutput("broken", String(broken.length));
  if (broken.length === 0) {
    console.log(
      `external links healthy (${judged.length} links judged across ${pages.length} pages)`,
    );
    return;
  }
  const failureDir = join(reportDir, "external-links");
  mkdirSync(failureDir, { recursive: true });
  writeFileSync(join(failureDir, "report.md"), reportBody(broken));
  console.log(`::warning::${broken.length} broken external link(s) - report at ${failureDir}`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
