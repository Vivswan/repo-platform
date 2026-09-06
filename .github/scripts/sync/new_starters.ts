// The new-starter hold: a starter the template introduces (in the new render's manifest, no
// entry of any class in the old one) at a path the target's HEAD already carries. copier keeps
// the file silently, so the PR is held with the callers and the rendered starter to compare.

import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MANIFEST_NAME, parseManifestFiles } from "../../../actions/shared/manifest.ts";
import { fail } from "../shared/gha.ts";
import { listRenderPaths } from "./retired_paths.ts";

/** A clean render's manifest, or the sync fails: renders are template output, so a missing or
 * unreadable manifest is a broken build, never target damage. */
export function renderManifest(renderDir: string): Record<string, { class: string }> {
  let text: string;
  try {
    text = readFileSync(join(renderDir, MANIFEST_NAME), "utf-8");
  } catch {
    fail(
      `${renderDir} renders no ${MANIFEST_NAME}; new starters cannot be told from existing ones`,
    );
  }
  const parsed = parseManifestFiles(text);
  if (parsed.problem !== null) fail(`${renderDir}/${MANIFEST_NAME} ${parsed.problem}`);
  return parsed.files;
}

/** Starter paths of the new render's manifest with no entry in the old
 * render's manifest, sorted. */
export function newStarterPaths(
  oldManifest: Record<string, { class: string }>,
  newManifest: Record<string, { class: string }>,
): string[] {
  return Object.entries(newManifest)
    .filter(([path, entry]) => entry.class === "starter" && !Object.hasOwn(oldManifest, path))
    .map(([path]) => path)
    .sort();
}

/** The render's regular files whose text names `path` (a literal substring: callers spell
 * `./.github/workflows/x.yml`), so the files whose expectations the kept copy must meet. A read
 * failure propagates rather than reading as "no caller". */
export function renderReferences(renderDir: string, path: string): string[] {
  return [...listRenderPaths(renderDir)]
    .filter((rel) => rel !== path && rel !== MANIFEST_NAME)
    .filter((rel) => lstatSync(join(renderDir, rel)).isFile())
    .filter((rel) => readFileSync(join(renderDir, rel), "latin1").includes(path))
    .sort();
}

/** The template's starter, bounded for the PR body: whole leading lines
 * within `budget` bytes; a cut is marked. */
const STARTER_EXCERPT_BYTES = 4000;
export function starterExcerpt(text: string, budget = STARTER_EXCERPT_BYTES): string {
  const lines = text.replace(/\n$/, "").split("\n");
  const kept: string[] = [];
  let size = 0;
  for (const line of lines) {
    size += Buffer.byteLength(line, "utf-8") + 1;
    if (size > budget) {
      kept.push("(truncated; the clean render at the new ref has the rest)");
      break;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

export interface NewStarterHold {
  path: string;
  /** Render files naming the path (the template's callers). */
  referencedBy: string[];
  /** The template's starter as rendered for this repository. */
  template: string;
}

/** The PR-body report: empty when no new starter is already present. */
export function newStartersReport(holds: readonly NewStarterHold[]): string {
  if (holds.length === 0) return "";
  const items = holds.map(({ path, referencedBy, template }) => {
    const callers =
      referencedBy.length === 0
        ? "no template file names it by path"
        : `named by ${referencedBy.map((rel) => `\`${rel}\``).join(", ")}`;
    const excerpt = starterExcerpt(template)
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n");
    return (
      `- \`${path}\`: kept as this repository's own file (${callers}). ` +
      "The template's starter at this path, for comparison:\n\n" +
      `  \`\`\`\`text\n${excerpt}\n  \`\`\`\``
    );
  });
  return (
    "> [!WARNING]\n" +
    "> NEW STARTER at a path this repository already owns. The template now\n" +
    "> generates these files once (`_skip_if_exists`), and copier kept the\n" +
    "> repository's copy without a conflict - so the template's callers may\n" +
    "> expect an interface the kept file lacks. Check each file against the\n" +
    "> template's starter (inputs, triggers, keys), then merge.\n\n" +
    `${items.join("\n\n")}\n`
  );
}

/** The holds for a target: every new starter path present at its HEAD. */
export function newStarterHolds(
  renderOld: string,
  renderNew: string,
  presentAtHead: (path: string) => boolean,
): NewStarterHold[] {
  return newStarterPaths(renderManifest(renderOld), renderManifest(renderNew))
    .filter(presentAtHead)
    .map((path) => ({
      path,
      referencedBy: renderReferences(renderNew, path),
      template: readFileSync(join(renderNew, path), "utf-8"),
    }));
}
