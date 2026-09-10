// copier.yml's generated question regions (modules choices, conditional
// excludes, has_toolchain, tracking-label validators); bodies are full
// lines in the target file's own indentation.

import { managedLabelNames } from "../../.github/scripts/fleet/render_managed_settings.ts";
import { compose } from "../compose/compose.ts";
import { excludePatterns } from "../compose/exclude.ts";
import type { ModuleManifest } from "../lib/module_manifests.ts";

/** copier.yml `modules` question: the choices block. */
export function moduleChoices(manifests: ModuleManifest[]): string[] {
  return ["  choices:", ...manifests.map((m) => `    ${m.module} - ${m.description}: ${m.module}`)];
}

/** copier.yml `_exclude`: the conditional-landing patterns (semantics in
 *  compose/exclude.ts's excludePatterns). Derived through the full
 *  composition - the gates live in module manifests and base filenames -
 *  so the region cannot disagree with the tree the build branch ships;
 *  compose/compose.ts's build() re-checks the committed region at every
 *  branch assembly. JSON.stringify emits each pattern as a YAML
 *  double-quoted scalar (JSON strings are a YAML subset), so quoting and
 *  backslash escapes cannot drift from the pattern text. */
export function excludeRegion(): string[] {
  return excludePatterns(compose().entries).map((pattern) => `  - ${JSON.stringify(pattern)}`);
}

/** copier.yml `has_toolchain`: or-chain over the toolchain manifests. */
export function hasToolchainDefault(manifests: ModuleManifest[]): string[] {
  const chain = manifests
    .filter((m) => m.toolchain !== undefined)
    .map((m) => `'${m.module}' in modules`)
    .join(" or ");
  if (chain === "") {
    throw new Error(
      "no manifest declares a toolchain, so copier.yml's has_toolchain " +
        "default would be empty - declare toolchain: {codeql_language: ...} " +
        "in at least one module.yml",
    );
  }
  return [`  default: "{{ ${chain} }}"`];
}

export type TrackingManifest = ModuleManifest & {
  tracking_label: NonNullable<ModuleManifest["tracking_label"]>;
};

/** The tracking-stream manifests (fuzzer, nightly, ...), in MODULE_ORDER;
 *  a new stream module joins every consumer below by declaring
 *  tracking_label in its manifest. */
export function trackingStreams(manifests: ModuleManifest[]): TrackingManifest[] {
  const streams = manifests.filter((m): m is TrackingManifest => m.tracking_label !== undefined);
  if (streams.length === 0) {
    throw new Error(
      "no manifest declares tracking_label, so copier.yml's tracking-label " +
        "validator regions would be empty - declare tracking_label in at " +
        "least one module.yml",
    );
  }
  return streams;
}

/** Every managed label name, lowercased (GitHub deduplicates label names
 *  case-insensitively) and deduped, in declaration order, from the settings
 *  baseline generator (render_managed_settings.ts), the roster's single home.
 *  The tracking streams' labels are excluded there: they render from the very
 *  answers the validators check. A tracking-label answer equal to a managed
 *  name would corrupt the roster's owner: settings applies would fight over
 *  the label's color/description, and a green night would close whatever
 *  issues carry it, the release-blocker stream included. */
export function reservedLabelNames(
  manifests: ModuleManifest[],
  roster: string[] = managedLabelNames(manifests),
): string[] {
  const names = roster.map((name) => name.toLowerCase());
  for (const name of names) {
    if (/['"\\]/.test(name)) {
      throw new Error(
        `reserved label ${JSON.stringify(name)} contains ', ", or \\ - it lands ` +
          "inside Jinja quotes within copier.yml's YAML double-quoted validators",
      );
    }
  }
  return [...new Set(names)];
}

/** One tracking-label question's generated validator line: the plain-label
 *  shape (\Z, not $, so a trailing newline in a piped-in answer cannot
 *  sneak past Python's regex semantics), the reserved-roster rejection,
 *  and distinctness from every EARLIER stream's answer (copier asks the
 *  questions in MODULE_ORDER, so a later answer is not comparable yet).
 *  All comparisons are lowercased: GitHub label names are
 *  case-insensitive. */
export function trackingLabelValidator(
  streams: TrackingManifest[],
  index: number,
  reserved: string[],
): string[] {
  const stream = streams[index];
  const answer = stream.tracking_label.answer;
  if (reserved.includes(stream.tracking_label.default.toLowerCase())) {
    throw new Error(
      `templates/${stream.module}/module.yml tracking_label default ` +
        `'${stream.tracking_label.default}' is a label the template already ` +
        "manages - the question's own default would fail its validator",
    );
  }
  const roster = reserved.map((name) => `'${name}'`).join(", ");
  const clauses = [
    `{% if not (${answer} | regex_search('^[A-Za-z0-9._][A-Za-z0-9._: -]{0,49}\\\\Z')) %}` +
      `${answer} must be a plain label: letters, digits, ._:- and spaces, ` +
      "not starting with a dash, at most 50 characters",
    `{% elif ${answer} | lower in [${roster}] %}` +
      `${answer} must not reuse a label the template already manages ` +
      "(GitHub label names are case-insensitive): a green night would close " +
      "whatever issues carry it and every settings apply would fight over it",
    ...streams.slice(0, index).map((prior) => {
      const other = prior.tracking_label.answer;
      return (
        `{% elif '${prior.module}' in modules and ${answer} | lower == ${other} | lower %}` +
        `${answer} must differ from ${other} (GitHub label names are ` +
        "case-insensitive): each stream needs its own tracking label or a " +
        "green night in one closes the other's open issue"
      );
    }),
  ];
  return [`  validator: "${clauses.join("")}{% endif %}"`];
}
