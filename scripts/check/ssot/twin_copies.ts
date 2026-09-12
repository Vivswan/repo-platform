// The sync never targets this repository (its files are the sources), yet it carries root copies of what
// it ships, so the content each copy holds is judged against the writer's own render of its source for
// this repository's registration.
//
//   managed  -> the whole file
//   split    -> the region between its markers; the halves outside are this repository's own
//   link     -> the link's target
//   starter  -> repo-owned everywhere, judged nowhere
//   render   -> the settings document, the settings:check generator's (scripts/generate/settings_document.ts)

import { readlinkSync } from "node:fs";
import { join } from "node:path";
import { lstatOrNull } from "../../../.github/scripts/shared/fs_probe.ts";
import { loadFilesConfig } from "../../../.github/scripts/sync/writer/files_config.ts";
import { regionMarkers } from "../../../.github/scripts/sync/writer/manifest.ts";
import {
  placeholderValues,
  type RepositorySlug,
  readRegistration,
} from "../../../.github/scripts/sync/writer/registration.ts";
import { renderSourced } from "../../../.github/scripts/sync/writer/render_source.ts";
import { resolveModules } from "../../../.github/scripts/sync/writer/select.ts";
import { parseSettingsDoc } from "../../../.github/scripts/sync/writer/settings_document.ts";
import { declaredPrivate } from "../../../.github/scripts/sync/writer/settings_layers.ts";
import { insideTarget, probe } from "../../../.github/scripts/sync/writer/target_files.ts";
import {
  type FileEntry,
  type RenderedEntry,
  selectEntries,
} from "../../../actions/plan/files_config.ts";
import { cleanManagedRegion } from "../../../actions/shared/grammar.ts";
import {
  PLATFORM_NAME,
  PLATFORM_OWNER,
  REGISTRATION_PATH,
} from "../../../actions/shared/platform.ts";
import { firstDiff, type Mismatch } from "./comparison.ts";
import { REPO_ROOT } from "./inputs.ts";
import type { Rule } from "./rule_roster.ts";

/** Paths files.yml writes for this repository whose root file is the operator's own, not a twin: the fleet
 *  shape cannot serve the platform itself there. Each is checked to still be selected, so a retired entry
 *  takes its line here with it. */
export const OWN_COPIES: Record<string, string> = {
  ".github/workflows/ci.yml":
    "gates this working tree by local path; the fleet skeleton rides the published build (docs/all-green.md)",
  ".github/dependabot.yml":
    "one github-actions entry over every action package directory, grouped so the action-pins rule sees one PR; the fleet shape spells one directory",
  ".yamllint": "ignores files/, whose placeholder tokens are not YAML before substitution",
  "AGENTS.md": "the platform's own guidance; the fleet region states a fleet member's conventions",
};

export interface TwinFacts {
  root: string;
  slug: RepositorySlug;
  /** Paths whose root file is the operator's own (OWN_COPIES for the live repository). */
  own: Record<string, string>;
}

/** The overlay's declared visibility, the fact the settings render selects its layer by; the generator
 *  and this rule have no GitHub to ask, so an undeclared one is an anchor lost. */
function declaredVisibility(root: string, entry: RenderedEntry): boolean {
  const overlay = probe(root, entry.overlay);
  if (overlay.kind !== "file") throw new Error(`${entry.overlay}: no regular file - anchor lost`);
  const visibility = declaredPrivate(
    parseSettingsDoc(overlay.bytes.toString("utf-8"), entry.overlay),
  );
  if (visibility === null) {
    throw new Error(`${entry.overlay}: repository.private is not declared - anchor lost`);
  }
  return visibility;
}

/** Bytes are compared, text is only reported: a decode folds every invalid sequence onto one replacement
 *  character, so two different byte strings could otherwise read as equal. */
function lineMismatch(file: string, source: string, expected: Buffer, got: Buffer): Mismatch[] {
  if (expected.equals(got)) return [];
  const want = expected.toString("utf-8").split("\n");
  const have = got.toString("utf-8").split("\n");
  const at = firstDiff(want, have);
  if (at === -1) {
    return [
      {
        file,
        expected: `${source} as the writer renders it for this repository, byte for byte`,
        got: "the same text in different bytes (an invalid UTF-8 sequence where the render has U+FFFD)",
      },
    ];
  }
  const line = (lines: string[]) =>
    at < lines.length ? JSON.stringify(lines[at]) : "the end of the text";
  return [
    {
      file,
      expected: `${source} as the writer renders it for this repository (line ${at + 1}: ${line(want)})`,
      got: `line ${at + 1}: ${line(have)}`,
    },
  ];
}

function copyMismatches(
  facts: TwinFacts,
  entry: FileEntry,
  rendered: string | { missing: string[] },
): Mismatch[] {
  const { root } = facts;
  const file = entry.path;
  if (entry.class === "link") {
    // insideTarget, as the writer probes: a linked ancestor would make the link's target another tree's.
    const abs = insideTarget(root, file);
    const stat = lstatOrNull(abs);
    const target = stat?.isSymbolicLink() ? readlinkSync(abs, "buffer") : null;
    if (target?.equals(Buffer.from(entry.target, "utf-8"))) return [];
    const got =
      stat === null
        ? "nothing there"
        : target === null
          ? "a regular file, not a link"
          : `a link to ${target.toString("utf-8")}`;
    return [{ file, expected: `a symbolic link to ${entry.target}`, got }];
  }
  if (entry.class === "starter" || "render" in entry) return [];
  const source = `files/${entry.source}`;
  if (typeof rendered !== "string") {
    const tokens = rendered.missing.map((name) => `{{${name}}}`).join(", ");
    return [
      {
        file,
        expected: `a value for ${tokens} in ${REGISTRATION_PATH} (${source} uses it)`,
        got: "none",
      },
    ];
  }
  const found = probe(root, file);
  if (found.kind !== "file") {
    return [
      {
        file,
        expected: `a regular file holding ${source} as rendered`,
        got: found.kind === "absent" ? "nothing there" : `a symbolic link to ${found.target}`,
      },
    ];
  }
  const want = Buffer.from(rendered, "utf-8");
  if (entry.class === "managed") return lineMismatch(file, source, want, found.bytes);
  // latin1 slices bytes the way the writer does, so the repository-owned halves never shift the region.
  const markers = regionMarkers(entry.region);
  const slice = cleanManagedRegion(found.bytes.toString("latin1"), markers);
  if (slice === null) {
    return [
      {
        file,
        expected: `one clean managed region between ${markers.begin} and ${markers.end}`,
        got: "markers missing, duplicated, out of order, or buried mid-line",
      },
    ];
  }
  return lineMismatch(file, source, want, Buffer.from(slice.region, "latin1"));
}

export function twinCopyMismatches(facts: TwinFacts): Mismatch[] {
  const { root, own } = facts;
  const config = loadFilesConfig(join(root, "files.yml"), join(root, "files"));
  const registration = readRegistration(root);
  const { selected, dropped } = resolveModules(config, registration.modules);
  if (dropped.length > 0) {
    throw new Error(
      `${REGISTRATION_PATH} selects module(s) files.yml does not know: ${dropped.join(", ")}`,
    );
  }
  const rendered = config.files.find((entry): entry is RenderedEntry => "render" in entry);
  if (rendered === undefined)
    throw new Error("files.yml has no render: settings entry - anchor lost");
  const values = placeholderValues(registration, facts.slug, config.defaults);
  const entries = selectEntries(config, {
    modules: selected,
    private: declaredVisibility(root, rendered),
  });
  const mismatches: Mismatch[] = [];
  const ownSeen = new Set<string>();
  for (const entry of entries) {
    // hasOwn, not `in`: an entry path named like an inherited property (constructor) is a twin too.
    if (Object.hasOwn(own, entry.path)) {
      if (entry.class !== "starter") ownSeen.add(entry.path);
      continue;
    }
    const text =
      entry.class === "link" || entry.class === "starter" || "render" in entry
        ? ""
        : renderSourced(config, join(root, "files"), entry, selected, values);
    mismatches.push(...copyMismatches(facts, entry, text));
  }
  for (const path of Object.keys(own)) {
    if (!ownSeen.has(path)) {
      mismatches.push({
        file: "scripts/check/ssot/twin_copies.ts OWN_COPIES",
        expected: `'${path}' written for this repository by a managed, split, or link entry`,
        got: "no such entry - the line here is stale; remove it in the same change",
      });
    }
  }
  return mismatches;
}

export const twinCopyRules: Rule[] = [
  {
    name: "root-twin-parity",
    run: () =>
      twinCopyMismatches({
        root: REPO_ROOT,
        slug: { owner: PLATFORM_OWNER, name: PLATFORM_NAME },
        own: OWN_COPIES,
      }),
  },
];
