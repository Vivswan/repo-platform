// Rules comparing this repository's own files with their template twins
// line for line: prefix-mode dogfood pairs, managed regions, the typography
// allowlist, the symlink trio, and the skills' twin tables.

import { existsSync, lstatSync, readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { cleanManagedRegion } from "../../../actions/shared/grammar.ts";
import { normalizeJinja } from "../../lib/jinja_subset.ts";
import {
  applyDivergences,
  firstDiff,
  type Mismatch,
  semanticLines,
  setMismatch,
} from "./comparison.ts";
import { jinjaVars, REPO_ROOT, read, trackedFiles } from "./inputs.ts";
import type { Rule } from "./rule_roster.ts";

function lineDiffMismatch(
  file: string,
  source: string,
  expected: string[],
  got: string[],
): Mismatch[] {
  const index = firstDiff(expected, got);
  if (index === -1) return [];
  return [
    {
      file,
      expected: `${JSON.stringify(expected[index] ?? "<end of file>")} (line ${index + 1} vs ${source})`,
      got: JSON.stringify(got[index] ?? "<end of file>"),
    },
  ];
}

/** The fleet license template every LICENSE.md copy in this repository
 *  renders from; the dogfood-parity rule compares each copy against it. */
export const LICENSE_TEMPLATE =
  "templates/base/{% if 'custom-license' not in modules %}LICENSE.md{% endif %}.jinja";

/** The trees whose LICENSE.md is a source or an oracle, never a copy: the
 *  template, the sync writer's placeholder source (files/), and the copier
 *  renders (tests/golden-renders, owned by renders:check; the fidelity
 *  test's frozen renders, compared by tests/ci/files_fidelity.test.ts). */
export const LICENSE_SOURCE_TREES = [
  "templates/",
  "files/",
  "tests/golden-renders/",
  "tests/ci/files_fidelity/renders/",
];

/** Every tracked LICENSE.md that copies this repository's license (the root
 *  file, each skill folder's copy, any copy added later). */
export function licenseCopies(tracked: string[]): string[] {
  const copies = tracked
    .filter(
      (rel) =>
        (rel === "LICENSE.md" || rel.endsWith("/LICENSE.md")) &&
        !LICENSE_SOURCE_TREES.some((tree) => rel.startsWith(tree)),
    )
    .sort();
  if (!copies.includes("LICENSE.md")) {
    throw new Error("git ls-files: no tracked root LICENSE.md - anchor lost");
  }
  return copies;
}

export interface DogfoodPair {
  repo: string;
  tpl: string;
  /** prefix: the copy must START with the rendered template (the managed
   *  region; a repo-owned tail may follow). semantic: comment- and
   *  blank-stripped lines must match, modulo RECORDED_DIVERGENCES. */
  mode: "prefix" | "semantic";
  context?: Record<string, boolean>;
}

/** One dogfood pair's judgment, given the rendered template and the copy. */
export function dogfoodPairMismatches(
  pair: DogfoodPair,
  expected: string,
  got: string,
): Mismatch[] {
  if (pair.mode === "prefix") {
    if (got.startsWith(expected)) return [];
    return lineDiffMismatch(pair.repo, pair.tpl, expected.split("\n"), got.split("\n"));
  }
  const excused = applyDivergences(pair.repo, semanticLines(expected), semanticLines(got));
  return [
    ...excused.mismatches,
    ...lineDiffMismatch(pair.repo, pair.tpl, excused.expected, excused.actual),
  ];
}

/** The skills' twin ownership tables: skills install standalone, so each
 *  ships its own; Class and Files are one roster, the third column is each
 *  skill's own. */
export const SKILL_OWNERSHIP_TABLES = [
  "skills/repo-platform-new-project/references/file-ownership.md",
  "skills/repo-platform-sync-pr/references/file-ownership.md",
] as const;

/** The ownership table's header row, the anchor the roster is read from. */
export const OWNERSHIP_TABLE_HEADER = "| Class | Files |";

/** The ownership table's Class and Files cells, header and separator
 *  included: the contiguous rows from OWNERSHIP_TABLE_HEADER on. Any other
 *  table in the file is not the roster, so a missing header is a lost anchor. */
export function ownershipTableRoster(file: string, markdown: string): string[] {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.startsWith(OWNERSHIP_TABLE_HEADER));
  if (start === -1) {
    throw new Error(`${file}: no ${OWNERSHIP_TABLE_HEADER} table header - anchor lost`);
  }
  const rows: string[] = [];
  for (const line of lines.slice(start)) {
    if (!line.startsWith("|")) break;
    rows.push(line);
  }
  return rows.map((line) =>
    line
      .split("|")
      .slice(1, 3)
      .map((cell) => cell.trim())
      .join(" | "),
  );
}

/** The first roster row where the second table's Class and Files cells
 *  differ from the first's (a row present in one only included). */
export function ownershipTableMismatches(
  tables: readonly { file: string; markdown: string }[],
): Mismatch[] {
  const [reference, ...others] = tables;
  const expected = ownershipTableRoster(reference.file, reference.markdown);
  return others.flatMap((other) =>
    lineDiffMismatch(
      other.file,
      reference.file,
      expected,
      ownershipTableRoster(other.file, other.markdown),
    ),
  );
}

/** The rules this module contributes to the checker's run (check_ssot.ts). */
export const twinCopyRules: Rule[] = [
  {
    // Most dogfooded copies are GENERATED from their templates by
    // scripts/generate/render_dogfood.ts, byte-checked by `bun run
    // dogfood:check`, and byte-compared against a REAL copier render by
    // ci.yml's dogfood-oracle smoke row, so they need no comparison here.
    // This rule keeps only the pairs generation cannot own: the prefix files,
    // whose repo-specific tails live below the template's marker.
    name: "dogfood-parity",
    run: () => {
      const vars = jinjaVars();
      const pairs: DogfoodPair[] = [
        {
          // The template's render is the managed region (BEGIN through END
          // markers); everything a repo appends after the END marker is its
          // own, hence prefix semantics.
          repo: ".github/SECURITY.md",
          tpl: "templates/base/.github/SECURITY.md.jinja",
          mode: "prefix",
        },
        {
          // Same region semantics as SECURITY.md: repo-specific contributing
          // docs live below the END marker.
          repo: "CONTRIBUTING.md",
          tpl: "templates/base/{% if not private %}CONTRIBUTING.md{% endif %}.jinja",
          mode: "prefix",
        },
        // Same region semantics for every tracked copy of the license.
        ...licenseCopies(trackedFiles()).map(
          (repo): DogfoodPair => ({ repo, tpl: LICENSE_TEMPLATE, mode: "prefix" }),
        ),
      ];
      return pairs.flatMap((pair) =>
        dogfoodPairMismatches(
          pair,
          normalizeJinja(read(pair.tpl), vars, pair.context),
          read(pair.repo),
        ),
      );
    },
  },
  {
    // The repo copy's managed region must byte-match the rendered template's
    // (region semantics make this checkable: the repo's own attributes live
    // outside the BEGIN/END markers, so the regions must be identical).
    // Slicing failure on either side reports as a mismatch too, which
    // covers lost or duplicated markers.
    name: "gitattributes-region",
    run: () => {
      const markers = {
        begin: "# BEGIN REPO-PLATFORM MANAGED",
        end: "# END REPO-PLATFORM MANAGED",
      };
      const expected = cleanManagedRegion(
        normalizeJinja(read("templates/base/.gitattributes.jinja"), jinjaVars()),
        markers,
      );
      if (expected === null)
        throw new Error(".gitattributes.jinja: no clean managed region - anchor lost");
      const got = cleanManagedRegion(read(".gitattributes"), markers);
      if (got === null) {
        return [
          {
            file: ".gitattributes",
            expected: "one clean BEGIN/END REPO-PLATFORM MANAGED region",
            got: "markers missing, duplicated, or out of order",
          },
        ];
      }
      if (got.region === expected.region) return [];
      return lineDiffMismatch(
        ".gitattributes",
        "templates/base/.gitattributes.jinja",
        expected.region.split("\n"),
        got.region.split("\n"),
      );
    },
  },
  {
    name: "typography-allow",
    run: () => {
      const entries = semanticLines(
        read("templates/release-please/fragments/typography-allow.jinja"),
      );
      if (entries.length === 0)
        throw new Error("typography-allow.jinja fragment has no entries - anchor lost");
      const got = new Set(semanticLines(read(".typography-allow")));
      return entries
        .filter((entry) => !got.has(entry))
        .map((entry) => ({
          file: ".typography-allow",
          expected: `entry ${JSON.stringify(entry)} (downstream repos get it from the release-please fragment)`,
          got: "missing",
        }));
    },
  },
  {
    name: "symlink-trio",
    run: () => {
      const mismatches: Mismatch[] = [];
      const aliases = (base: string, target: string): string[] => {
        const found: string[] = [];
        const dirs = ["", ".github"];
        for (const dir of dirs) {
          const abs = join(REPO_ROOT, base, dir);
          if (!existsSync(abs)) continue;
          for (const name of readdirSync(abs).sort()) {
            const rel = dir ? `${dir}/${name}` : name;
            const path = join(abs, name);
            if (!lstatSync(path).isSymbolicLink()) continue;
            if (readlinkSync(path).split("/").pop() === target) found.push(rel);
          }
        }
        return found;
      };
      const rootTrio = aliases("", "AGENTS.md");
      const templateTrio = aliases("templates/base", "AGENTS.md.jinja");
      if (rootTrio.length === 0 || templateTrio.length === 0) {
        throw new Error("no AGENTS.md symlink aliases found - anchor lost");
      }
      mismatches.push(...setMismatch("templates/base/ symlink aliases", rootTrio, templateTrio));

      const repoAttrs = new Set(semanticLines(read(".gitattributes")));
      const tplAttrs = new Set(semanticLines(read("templates/base/.gitattributes.jinja")));
      for (const alias of rootTrio) {
        for (const [line, file] of [
          [`${alias} -text`, ".gitattributes"],
          [`templates/base/${alias} -text`, ".gitattributes"],
        ]) {
          if (!repoAttrs.has(line)) {
            mismatches.push({ file, expected: `line ${JSON.stringify(line)}`, got: "missing" });
          }
        }
        if (!tplAttrs.has(`${alias} -text`)) {
          mismatches.push({
            file: "templates/base/.gitattributes.jinja",
            expected: `line ${JSON.stringify(`${alias} -text`)}`,
            got: "missing",
          });
        }
      }
      return mismatches;
    },
  },
  {
    // The skills' twin file-ownership tables share their Class and Files
    // columns row for row; a path added or reclassified in one table
    // without the other is the drift the old "keep in sync" comment
    // could only ask for.
    name: "skill-ownership-tables",
    run: () =>
      ownershipTableMismatches(
        SKILL_OWNERSHIP_TABLES.map((file) => ({ file, markdown: read(file) })),
      ),
  },
];
