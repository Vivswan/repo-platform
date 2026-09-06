#!/usr/bin/env bun
// Compose the flat template/ tree Copier renders from templates/ sources.
//
// templates/ is the source of truth, one folder per module plus base/:
//
// - templates/base/: passed through with content verbatim. A conditional
//   base file DECLARES its gate in its source filename (CONTRIBUTING.md's
//   `not private`, LICENSE.md's custom-license opt-out); the composer
//   strips the gate from the EMITTED name and records it in the gate data
//   below - the composed tree carries only plain filenames, because a
//   `uses:` ref downloads the whole build branch as a tarball and
//   extraction dies on jinja-expression path segments.
// - templates/<module>/: whole files owned by that module, emitted at
//   their plain paths; the module's gate (its manifest `gate:` override or
//   plain membership) is recorded per file. module.yml is the module's
//   manifest (schema: scripts/lib/module_manifests.ts).
// - Conditional LANDING happens in copier.yml, not in filenames: its
//   generated _exclude region (scripts/generate.ts, from exclude.ts's
//   excludePatterns) carries one jinja-templated pattern per gated landed path,
//   rendering to the literal path exactly when the file's gates do NOT
//   hold - copier then never renders the file at all, on copy and update
//   alike, byte-identical to the retired filename-gate behavior. build()
//   errors when copier.yml's committed region is stale, so a build branch
//   can never ship a tree whose excludes disagree with its content.
// - templates/<module>/fragments/<anchor>.jinja: additive contributions to
//   shared files. A skeleton file carries a marker line starting with
//   `{# compose:<anchor> #}` (text after the closing tag is appended
//   verbatim after the last contribution, for inline `{% endif %}<text>`
//   junctions); the composer replaces the line with every contribution in
//   MODULE_ORDER, each fragment wrapped in its module's gate. Fragments own
//   all whitespace between the tags; the composer adds none. A `-#}`
//   closer makes the anchor TIGHT: the marker line's newline is consumed
//   too, so every contribution must end with a newline inside its own gate
//   and the junction to the next line stays tight whichever gates render
//   false (with a plain `#}` the skeleton newline terminates the block, so
//   an all-conditional line list would leave it dangling when the last
//   gate is off). On a plain anchor whose contributions all carry a
//   recorded gate, the marker line's newline is wrapped in an any-gate
//   guard (splice.ts's collapseGuard): with every gate false the whole line
//   collapses instead of rendering as a stray blank line, and with any
//   gate true the guard re-emits the same newline, byte-identical to an
//   unguarded splice.
// - templates/<module>/fragments/toolchain-setup.jinja is no anchor's
//   fragment: it carries the module's toolchain setup steps, prepended by
//   the composer to the module's own auto-format and copilot-setup-steps
//   contributions so the two spliced copies can never drift apart.
// - Data anchors (data_anchors.ts's DATA_ANCHORS) are filled from manifest data instead
//   of fragment files, so the composed output carries no marker comments and
//   list-shaped content (dependabot ecosystems, the fleet-ci call's
//   codeql-languages input, gitleaks lockfiles) cannot drift from the
//   manifests. The sharing rule: a
//   manifest value declared by several modules is grouped BY VALUE, emitted
//   ONCE, and gated on the or-chain of the contributing modules in
//   MODULE_ORDER - never per-module duplicates, never precedence guards.
//   A fragment file for a data anchor is an error, with one exception:
//   agents-toolchain consumes its fragments as generator input.
//
// Every anchor needs at least one contribution (fragment or generated) and
// every contribution needs its anchor. Collisions are errors, never silent
// merges: the same logical path provided by two folders (or a module file
// colliding with base) must be resolved by hoisting the file to base/ with
// an explicit gate or by adding an anchor.
//
// All I/O is bytes (source files are copied verbatim, never re-encoded) and
// symlinks are copied as symlinks. Output is deterministic: sorted walks plus
// the fixed MODULE_ORDER (CI builds twice and diffs to prove it).
//
// Ownership contract (the manifest's source of truth): every file the
// template lands carries a DECLARED ownership class - templates/base/
// ownership.yml covers the base tree and each module.yml's `ownership:`
// list covers its module's files (schema: scripts/ownership/declarations.ts).
// Composition errors on a landed file with no declaration, a declaration
// whose path never lands, same-path declarations that disagree across
// sources, starter declarations out of step with copier.yml's
// _skip_if_exists (both directions, dead skip patterns included), and
// source text that contradicts its declared class - managed headers and
// split marker lines are validated DECORATION, never classification
// input. Split declarations carry their GRAMMAR (managed-region: a
// BEGIN/END-bounded sync-owned region with repo-owned content allowed on
// both sides); the manifest entries
// expose the grammar to the sync's split-file rebuild. The entry LINES are
// emitted by the shared entryLine (actions/shared/manifest.ts) - the same
// module whose parser the stamp hook, the sync legs, and validate-template
// read the manifest back through, so the wire layout cannot fork.
//
// Usage:
//   bun scripts/compose/compose.ts   # regenerate the local template/ artifact

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { loadManifests, MODULE_ORDER, type ModuleManifest } from "../lib/module_manifests.ts";
import { loadBaseOwnership } from "../ownership/declarations.ts";
import { readExcludeList, skipIfExistsPatterns } from "../ownership/landed_paths.ts";
import {
  agentsToolchainErrors,
  applyToolchainSetup,
  type Contribution,
  DATA_ANCHORS,
  type GateOf,
  GeneratorValidationError,
} from "./data_anchors.ts";
import {
  collectFiles,
  collectFragments,
  die,
  type Entry,
  FRAGMENTS_DIR,
  JINJA_SUFFIX,
  MANIFEST_NAME,
  OWNERSHIP_NAME,
  REPO_ROOT,
  type SourcedEntry,
} from "./entries.ts";
import {
  excludePatterns,
  gateExpression,
  plainTemplatePath,
  templatePathErrors,
} from "./exclude.ts";
import {
  type DeclarationSources,
  MANIFEST_TEMPLATE_PATH,
  type ManifestEntry,
  manifestEntries,
  manifestTemplate,
} from "./manifest.ts";
import { fragmentMarkerErrors, sortedByKey, sourceName, spliceContributions } from "./splice.ts";

const SRC = join(REPO_ROOT, "templates");
const OUT = join(REPO_ROOT, "template");

/** Compose the tree: emitted path -> Entry, plus the ownership manifest
 *  entries the tree was generated from (excludePatterns derives copier.yml's
 *  _exclude region from the same entries). Exits 1 on errors. */
export function compose(): { output: Map<string, Entry>; entries: ManifestEntry[] } {
  const base = join(SRC, "base");
  if (!existsSync(base) || !lstatSync(base).isDirectory() || readdirSync(base).length === 0) {
    die(
      "error: templates/base is missing or empty; refusing to compose " +
        "(a broken checkout must not wipe template/). Restore templates/base/ " +
        "with git checkout before rerunning.",
    );
  }
  // loadManifests enforces the MODULE_ORDER <-> templates/ bijection (no
  // duplicates, no unknown folders, no missing folders) for every consumer.
  let manifests: ModuleManifest[];
  try {
    manifests = loadManifests();
  } catch (error) {
    die(`error: ${error instanceof Error ? error.message : String(error)}`);
  }

  const errors: string[] = [];
  const files = new Map<string, SourcedEntry>();
  // Fragment contributions carry their module's whole manifest, so every
  // later consumer reads validated data instead of re-fetching by name.
  const fragments = new Map<string, [ModuleManifest, Buffer][]>();
  const gates = new Map<string, string>();

  for (const [logical, entry] of collectFiles(base)) {
    errors.push(...templatePathErrors(logical).map((error) => `templates/base/${error}`));
    files.set(logical, { origin: "base", entry });
  }
  try {
    lstatSync(join(base, FRAGMENTS_DIR));
    errors.push(
      `templates/base/${FRAGMENTS_DIR}: base cannot contribute fragments ` +
        "(it owns the skeletons); fragments belong to module folders",
    );
  } catch {
    // No fragments/ entry under base - the expected state.
  }

  for (const manifest of manifests) {
    const { module } = manifest;
    const folder = join(SRC, module);
    if (existsSync(join(folder, OWNERSHIP_NAME))) {
      errors.push(
        `templates/${module}/${OWNERSHIP_NAME}: module ownership is declared in the ` +
          `${MANIFEST_NAME} manifest's ownership list (${OWNERSHIP_NAME} is the base ` +
          "tree's declaration home); move the entries and delete this file",
      );
    }
    const gate = gateExpression(module, manifest);
    gates.set(module, gate);
    const moduleFiles = collectFiles(folder);
    for (const [logical, entry] of moduleFiles) {
      if (logical.includes("{%")) {
        errors.push(
          `templates/${module}/${logical}: module files must not carry ` +
            `filename gates; the composer records the '${module}' gate as ` +
            "data for the generated _exclude region (custom gates go in module.yml)",
        );
        continue;
      }
      errors.push(...templatePathErrors(logical).map((error) => `templates/${module}/${error}`));
      const existing = files.get(logical);
      if (existing) {
        errors.push(
          `collision: templates/${sourceName(existing)}/${logical} and ` +
            `templates/${module}/${logical} both provide ${logical}. Additive ` +
            "content must go through an anchor ({# compose:<name> #} plus " +
            `${FRAGMENTS_DIR}/<name>${JINJA_SUFFIX}); otherwise hoist the file ` +
            "to templates/base/ with an explicit {% if %} filename.",
        );
        continue;
      }
      files.set(logical, { origin: "module", module, gate, entry });
    }
    for (const [anchor, body] of collectFragments(folder)) {
      const contributions = fragments.get(anchor) ?? [];
      contributions.push([manifest, body]);
      fragments.set(anchor, contributions);
    }
  }

  // Route every fragment and data generator into per-anchor contributions.
  const contributions = new Map<string, Contribution[]>();
  const addContribution = (anchor: string, contribution: Contribution) => {
    const list = contributions.get(anchor) ?? [];
    list.push(contribution);
    contributions.set(anchor, list);
  };
  const gateOf: GateOf = (module) => {
    const gate = gates.get(module);
    if (gate === undefined) {
      throw new Error(`no gate for module '${module}' - it is not in MODULE_ORDER`);
    }
    return gate;
  };
  const wrapFragment = (anchor: string, module: string, body: Buffer): Contribution => ({
    order: MODULE_ORDER.indexOf(module),
    source: `templates/${module}/${FRAGMENTS_DIR}/${anchor}${JINJA_SUFFIX}`,
    gate: gateOf(module),
    text: Buffer.concat([
      Buffer.from(`{% if ${gateOf(module)} %}`),
      body,
      Buffer.from("{% endif %}"),
    ]),
  });

  errors.push(...fragmentMarkerErrors(fragments));
  errors.push(...applyToolchainSetup(fragments));

  const agentsToolchainModules = new Set(
    (fragments.get("agents-toolchain") ?? []).map(([manifest]) => manifest.module),
  );
  errors.push(...agentsToolchainErrors(manifests, agentsToolchainModules));

  for (const [anchor, spec] of Object.entries(DATA_ANCHORS)) {
    const fromFiles = fragments.get(anchor) ?? [];
    fragments.delete(anchor);
    const consumed: [string, Buffer][] = [];
    for (const [manifest, body] of fromFiles) {
      const { module } = manifest;
      const path = `templates/${module}/${FRAGMENTS_DIR}/${anchor}${JINJA_SUFFIX}`;
      if (spec.kind === "reject") {
        errors.push(
          `${path}: the composer generates this module's '${anchor}' ` +
            `contribution from the module manifests (${spec.data}); delete ` +
            `the fragment and declare the data in templates/${module}/${MANIFEST_NAME}`,
        );
      } else if (spec.kind === "consume") {
        if (body.length === 0 || body[body.length - 1] !== 0x0a) {
          errors.push(
            `${path}: the fragment must end with a newline (the '${anchor}' ` +
              "generator closes each contribution with '{% endif -%}' on the " +
              "following line)",
          );
        } else {
          consumed.push([module, body]);
        }
      }
    }
    try {
      const generated =
        spec.kind === "consume"
          ? spec.generate({ manifests, gateOf, fragments: consumed })
          : spec.generate({ manifests, gateOf });
      for (const contribution of generated) addContribution(anchor, contribution);
    } catch (error) {
      if (error instanceof GeneratorValidationError) {
        errors.push(`anchor '${anchor}': ${error.message}`);
      } else {
        throw new Error(`anchor '${anchor}': unexpected generator failure`, { cause: error });
      }
    }
  }
  for (const [anchor, list] of fragments) {
    for (const [manifest, body] of list) {
      addContribution(anchor, wrapFragment(anchor, manifest.module, body));
    }
  }
  errors.push(...spliceContributions(files, contributions));
  // The ownership manifest is generated from the same spliced file map the
  // tree is emitted from and the DECLARED classes (base ownership.yml plus
  // the module.yml ownership lists), so it can never disagree with what
  // actually lands. Emitted as one more template file - copier renders and
  // syncs it like any managed file.
  // One nullable result, not two half-set variables: the manifest either
  // generated whole (template bytes plus the entries it was built from) or
  // an error was recorded and the exit below fires.
  let manifest: { data: Buffer; entries: ManifestEntry[] } | null = null;
  try {
    const skipPatterns = skipIfExistsPatterns(readFileSync(join(REPO_ROOT, "copier.yml"), "utf-8"));
    const declarations: DeclarationSources = {
      base: loadBaseOwnership(SRC),
      modules: new Map(manifests.map((m) => [m.module, m.ownership ?? []])),
    };
    const generated = manifestEntries(files, skipPatterns, declarations);
    errors.push(...generated.errors);
    if (generated.errors.length === 0) {
      manifest = { data: manifestTemplate(generated.entries), entries: generated.entries };
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  if (errors.length > 0) {
    for (const error of errors) console.error(`error: ${error}`);
    process.exit(1);
  }

  const output = new Map<string, Entry>();
  if (manifest === null) {
    // Unreachable: a null manifest always comes with a recorded error.
    throw new Error("manifest generation produced neither content nor errors");
  }
  output.set(MANIFEST_TEMPLATE_PATH, { kind: "file", data: manifest.data });
  const emittedErrors: string[] = [];
  for (const [logical, sourced] of files) {
    // Plain names only: filename gates are declaration, stripped here and
    // realized by copier.yml's generated _exclude region instead.
    const emitted = plainTemplatePath(logical);
    if (output.has(emitted)) {
      // Distinct logical paths can still emit the same name (e.g. a
      // hand-gated base filename plus another source's plain copy).
      emittedErrors.push(
        `collision: two sources emit template/${emitted} (one of them via ` +
          "an explicit filename gate in base/) - delete the module copy or " +
          "the hand-gated base file",
      );
      continue;
    }
    output.set(emitted, sourced.entry);
  }
  if (emittedErrors.length > 0) {
    for (const error of emittedErrors) console.error(`error: ${error}`);
    process.exit(1);
  }
  return { output, entries: manifest.entries };
}

/** compose() plus the copier.yml gate: the committed _exclude region must
 *  equal the patterns derived from this tree's entries, or the assembled
 *  branch would ship plain-named conditional files that copier lands
 *  unconditionally. Regenerated by `bun run generate`; drift-gated there
 *  too, but a branch build must fail on its own checkout's staleness. */
export function build(): Map<string, Entry> {
  const { output, entries } = compose();
  const expected = excludePatterns(entries);
  let committed: string[];
  try {
    committed = readExcludeList(readFileSync(join(REPO_ROOT, "copier.yml"), "utf-8"));
  } catch (error) {
    die(`error: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (JSON.stringify(committed) !== JSON.stringify(expected)) {
    // Two distinct causes, two distinct remedies: entries the generator
    // never emits are HAND-ADDED (outside or inside the markers - the
    // generated region owns the whole _exclude list), while missing or
    // reordered generated entries mean the region is stale.
    const extras = committed.filter((pattern) => !expected.includes(pattern));
    const missing = expected.filter((pattern) => !committed.includes(pattern));
    if (missing.length === 0 && extras.length > 0) {
      die(
        `error: copier.yml's _exclude carries ${extras.length} hand-added ` +
          `entr${extras.length === 1 ? "y" : "ies"} the generator does not emit ` +
          `(first: ${JSON.stringify(extras[0])}) - the generated region owns the ` +
          "whole list (conditional landing derives from the module manifests " +
          "and base filename gates); remove the hand-added entries",
      );
    }
    if (missing.length === 0 && extras.length === 0) {
      // Same set, different list: duplicated or reordered entries, e.g. a
      // generated entry hand-copied OUTSIDE the markers - which a
      // regeneration would preserve, so the generic advice below would
      // not heal it.
      die(
        "error: copier.yml's _exclude duplicates or reorders the generated " +
          "entries (a copy outside the region markers survives regeneration) - " +
          "remove everything outside the generated region and rerun `bun run generate`",
      );
    }
    die(
      "error: copier.yml's _exclude region does not match the patterns " +
        "derived from the composed tree's gates - run `bun run generate` " +
        "and commit the result (conditional files would otherwise land " +
        "unconditionally in every render)",
    );
  }
  return output;
}

/** Write the composed map into `out`, replacing it entirely. */
export function writeOutput(composed: Map<string, Entry>, out: string): void {
  if (existsSync(out)) rmSync(out, { recursive: true });
  for (const [path, entry] of sortedByKey(composed)) {
    const dest = join(out, path);
    mkdirSync(dirname(dest), { recursive: true });
    if (entry.kind === "symlink") {
      // Targets keep the .jinja suffix VERBATIM (the source convention:
      // links point at their templated twin), so no link on the build
      // branch is ever dangling - the runner's `uses:` tarball staging
      // dies on a dangling symlink anywhere in the downloaded tree.
      // Rendered repositories get the suffix-stripped target from the
      // post-render stamp hook (stamp_manifest.ts normalizes the
      // manifest-listed links), since copier renders link targets as
      // strings without stripping the suffix.
      symlinkSync(entry.target, dest);
    } else {
      writeFileSync(dest, entry.data);
    }
  }
}

function main(): number {
  const args = process.argv.slice(2);
  if (args.length > 0) {
    console.error(`error: unrecognized argument(s): ${args.join(" ")}`);
    return 2;
  }
  const composed = build();
  writeOutput(composed, OUT);
  console.log(`composed ${composed.size} file(s) into template/`);
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
