// The nightly schedule is a block only a public repository takes (files.yml): the fragment lands under `on:` through
// the anchor, so a private repository's ci.yml has no schedule at all and both renders parse as the YAML GitHub reads.
// Nothing in the loader ties the fragment to the `on:` key: an anchor moved elsewhere would render a valid-looking
// file whose schedule GitHub ignores, or a private file that is not YAML.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { renderSourced } from "../../.github/scripts/sync/writer/render_source.ts";
import { fetchUpstream } from "../../.github/scripts/sync/writer/upstream.ts";
import {
  type FileEntry,
  parseFilesConfig,
  type UpstreamRef,
} from "../../actions/plan/files_config.ts";

/** The repository root the manifest and the tree are read from. */
const ROOT = join(import.meta.dir, "../..");

/** The writer's source tree. */
const FILES = join(ROOT, "files");

/** The committed manifest, as the writer parses it. */
const config = parseFilesConfig(readFileSync(join(ROOT, "files.yml"), "utf-8"));

type Sourced = Extract<FileEntry, { source: string | UpstreamRef }>;

/** The managed ci.yml entry, the one whose nightly block is conditioned. */
const skeleton = config.files.find((entry) => entry.path === ".github/workflows/ci.yml") as Sourced;

/** The nightly block as shipped, which the public render must carry verbatim. */
const FRAGMENT = readFileSync(join(FILES, "base/.github/workflows/ci.nightly.yml"), "utf-8");

/** No upstream body: the skeleton fetches nothing. */
const bodies = await fetchUpstream([], "http://upstream", () =>
  Promise.reject(new Error("no ref")),
);

/** The skeleton as the writer renders it for one visibility, with no module selected. */
const render = (isPrivate: boolean) =>
  renderSourced(
    config,
    FILES,
    skeleton,
    { modules: [], private: isPrivate },
    { github_username: "octocat" },
    bodies,
  ) as string;

test("a public repository's ci.yml carries the nightly under on:, a private one has no schedule, and nothing else differs", () => {
  const pub = render(false);
  const priv = render(true);
  const on = (text: string) => (parseYaml(text) as { on: Record<string, unknown> }).on;

  expect(pub).toBe(priv.replace("  workflow_dispatch:\n", `  workflow_dispatch:\n${FRAGMENT}`));
  expect(on(pub)).toEqual({ ...on(priv), schedule: [{ cron: "3 4 * * *" }] });
  expect(Object.keys(on(priv))).toEqual(["push", "pull_request", "workflow_dispatch"]);
});
