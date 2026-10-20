#!/usr/bin/env bun
// The outputs are action.yml's. The three regexes are lychee's: the excludes match a URL as spelled, and the remap is
// a pattern, a space, and a replacement carrying `$N` captures.

import { setFailed, setOutput } from "@actions/core";
import { messageOf, requireEnv } from "../shared/action_runtime.ts";
import { ownLinksPattern, pagesSite } from "../shared/pages_site.ts";

export interface SiteUrls {
  "base-path": string;
  origin: string;
  "own-links": string;
  "edit-links": string;
  "tree-links": string;
}

/** `tree-links` is case-sensitive on purpose: a branch in another case is another ref, and a link spelled otherwise
 *  stays a network check. The path capture `$2` drops trailing slashes, the query, and the fragment, since GitHub
 *  serves them and a file path does not. */
export function siteUrls(input: {
  repository: string;
  serverUrl: string;
  workspace: string;
  defaultBranch: string;
}): SiteUrls {
  const site = pagesSite(input.repository);
  const repoUrl = `${input.serverUrl}/${input.repository}/`;
  return {
    "base-path": site.basePath,
    "origin": site.origin,
    "own-links": ownLinksPattern(site),
    "edit-links": `^${RegExp.escape(`${repoUrl}edit/`)}`,
    "tree-links":
      `^${RegExp.escape(repoUrl)}(blob|tree)/${RegExp.escape(input.defaultBranch)}/([^?#]*?)/*([?#].*)?$ ` +
      `${Bun.pathToFileURL(input.workspace).href}/$2`,
  };
}

if (import.meta.main) {
  try {
    const urls = siteUrls({
      repository: requireEnv("GITHUB_REPOSITORY"),
      serverUrl: requireEnv("GITHUB_SERVER_URL").replace(/\/+$/, ""),
      workspace: requireEnv("GITHUB_WORKSPACE"),
      defaultBranch: requireEnv("DEFAULT_BRANCH"),
    });
    for (const [name, value] of Object.entries(urls)) setOutput(name, value);
  } catch (cause) {
    setFailed(messageOf(cause));
  }
}
