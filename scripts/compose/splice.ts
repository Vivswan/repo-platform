// Anchor splicing: the marker grammar, the malformed- and smuggled-marker
// scans, the collapse guard, and the in-place replacement of every anchor
// line with its ordered contributions.

import { joinLines, splitLines } from "../../.github/scripts/shared/lines.ts";
import type { ModuleManifest } from "../module_manifests.ts";
import { type Contribution, DATA_ANCHORS, renderedSeparationErrors } from "./data_anchors.ts";
import { FRAGMENTS_DIR, JINJA_SUFFIX, type SourcedEntry } from "./entries.ts";

/** A compose anchor line: `{# compose:<name> #}` (or `-#}`), one per line;
 *  the ssot sticky-pr-comments rule resolves fragment hosts with it. */
export const ANCHOR_RE = /^\{# compose:([a-z0-9][a-z0-9-]*) (-?)#\}([^\r]*)$/;

const ANCHOR_HINT = Buffer.from("{# compose:");
/** Loose recognizer for text MEANT to be an anchor marker: a jinja comment
 *  opener with an optional trim dash and any same-line whitespace, then the
 *  compose keyword. Both malformed-marker scans match this: the skeleton
 *  scan then demands the strict ANCHOR_RE form, and the contribution scan
 *  rejects every match outright (contributions may not carry markers at
 *  all) - recognizing only the canonical ANCHOR_HINT spelling would let a
 *  variant like '{#- compose:x #}' skip validation and vanish at render.
 *  The colon is one boundary: prose like '{# composes the tree #}' stays a
 *  plain comment. Horizontal whitespace is the other: markers are line
 *  constructs (ANCHOR_RE is line-anchored), and the skeleton scan reads
 *  line by line, so a newline inside the opener must not match here or the
 *  two scans would disagree on the same bytes. */
const ANCHOR_HINT_RE = /\{#-?[ \t]*compose:/;

/** Marker scan over the RAW fragment bodies, before any transformation
 *  moves their bytes: applyToolchainSetup prepends toolchain-setup.jinja
 *  into the target fragments' contributions and the consume generators
 *  fold several fragments into one built-in-generator contribution, so a
 *  scan of the transformed contributions could only name the wrong source.
 *  This one runs on the collected map, where every body still carries its
 *  own path, so the error always names the file to edit. */
export function fragmentMarkerErrors(fragments: Map<string, [ModuleManifest, Buffer][]>): string[] {
  const errors: string[] = [];
  for (const [anchor, list] of sortedByKey(fragments)) {
    for (const [manifest, body] of list) {
      const hint = ANCHOR_HINT_RE.exec(body.toString("latin1"));
      if (hint) {
        errors.push(
          `templates/${manifest.module}/${FRAGMENTS_DIR}/${anchor}${JINJA_SUFFIX}: the ` +
            `fragment contains an anchor marker ('${hint[0]}') - a marker inside a ` +
            "fragment is never scanned or filled (anchors live in skeleton files " +
            "only, each in exactly one); move the marker line to a skeleton file " +
            "or remove it",
        );
      }
    }
  }
  return errors;
}

function matchAnchor(line: Buffer): { name: string; tight: boolean; trailing: string } | null {
  // Bytes, matched as latin1: non-ASCII bytes can never satisfy the pattern.
  const match = ANCHOR_RE.exec(line.toString("latin1"));
  return match ? { name: match[1], tight: match[2] === "-", trailing: match[3] } : null;
}

export function sortedByKey<V>(map: Map<string, V>): [string, V][] {
  return [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The guard replacing a plain anchor line's newline: all gates false
 *  collapses the line, any selected gate re-emits the identical newline.
 *  Null when a gate-null contribution or a lexical trim owns the newline. */
function collapseGuard(
  contributions: Contribution[],
  spliced: Buffer,
  followingTrims: boolean,
): Buffer | null {
  const gates: string[] = [];
  for (const { gate } of contributions) {
    if (gate === null) return null;
    if (!gates.includes(gate)) gates.push(gate);
  }
  if (/-[%#}]\}[ \t\r\n]*$/.test(spliced.toString("latin1"))) return null;
  if (followingTrims) return null;
  const condition = gates.length === 1 ? gates[0] : gates.map((gate) => `(${gate})`).join(" or ");
  return Buffer.from(`{% if ${condition} %}\n{% endif %}`);
}

/** Whether the effective texts following a marker line (anchors already
 *  spliced) reach a trimming opener across nothing but whitespace - the
 *  opener would consume the run, a guarded newline included. */
export function trimsFollowingWhitespace(texts: Buffer[]): boolean {
  for (const text of texts) {
    const chars = text.toString("latin1");
    const at = chars.search(/[^ \t\r\n]/);
    if (at === -1) continue; // all-whitespace text: the run goes on
    return /^\{[{%#]-/.test(chars.slice(at));
  }
  return false;
}

export function sourceName(sourced: SourcedEntry): string {
  return sourced.origin === "base" ? "base" : sourced.module;
}

/** Replace anchor lines in-place; returns error strings. Sorts each
 *  anchor's contributions into MODULE_ORDER emission order itself - the
 *  rendered-separation invariant and the splice depend on it, so it is
 *  enforced here rather than trusted to the caller. Exported so the
 *  tight-anchor splice semantics (newline absorption, the tight+trailing
 *  contradiction) stay covered by unit tests. */
export function spliceContributions(
  files: Map<string, SourcedEntry>,
  contributions: Map<string, Contribution[]>,
): string[] {
  for (const list of contributions.values()) {
    list.sort((a, b) => a.order - b.order);
  }
  const errors: string[] = [];
  // anchor -> its owning skeleton [source, logical] plus the tight flag.
  const anchorOwner = new Map<string, { source: string; logical: string; tight: boolean }>();
  for (const [logical, sourced] of sortedByKey(files)) {
    const { entry } = sourced;
    if (entry.kind === "symlink") continue;
    for (const line of splitLines(entry.data)) {
      if (ANCHOR_HINT_RE.test(line.toString("latin1")) && matchAnchor(line) === null) {
        errors.push(
          `templates/${sourceName(sourced)}/${logical}: malformed anchor line ` +
            `'${line.toString("utf-8").trim()}' - anchors must start the ` +
            "line as '{# compose:<name> #}' (or '{# compose:<name> -#}' for " +
            "a tight junction; no indentation or CRLF; text after the " +
            "closing tag is appended verbatim after the last contribution)",
        );
        continue;
      }
      const anchor = matchAnchor(line);
      if (anchor === null) continue;
      if (anchor.trailing !== "" && anchor.trailing.trim() === "") {
        errors.push(
          `templates/${sourceName(sourced)}/${logical}: anchor '${anchor.name}' ` +
            "carries only whitespace after the closing tag - almost certainly " +
            "an accident (a trailing literal must contain visible text); " +
            "delete the stray whitespace",
        );
      }
      if (anchor.tight && anchor.trailing !== "") {
        errors.push(
          `templates/${sourceName(sourced)}/${logical}: anchor '${anchor.name}' ` +
            "is tight (-#}) but carries a trailing literal - a trailing " +
            "literal is a mid-line junction while tight consumes the line " +
            "ending; use one or the other",
        );
      }
      const other = anchorOwner.get(anchor.name);
      if (other) {
        errors.push(
          `duplicate anchor '${anchor.name}' in templates/${sourceName(sourced)}/${logical} ` +
            `and templates/${other.source}/${other.logical} - each anchor may appear ` +
            "in exactly one skeleton file; rename one anchor (and any " +
            `fragments/${anchor.name}.jinja files that feed it) or remove the duplicate marker`,
        );
      }
      anchorOwner.set(anchor.name, {
        source: sourceName(sourced),
        logical,
        tight: anchor.tight,
      });
    }
  }

  // Contributions are spliced verbatim, so an anchor marker inside one
  // would dodge the skeleton scan above whole: it never registers an owner
  // (contributions to it get the misleading no-anchor error), a malformed
  // marker goes undiagnosed, and a well-formed one survives into the
  // composed tree as a comment rendering to nothing. Anchors live in
  // skeleton files only. In the composed pipeline fragmentMarkerErrors has
  // already named the editable fragment for any smuggled marker (before
  // the transformations copy fragment bytes into contributions with other
  // sources); this scan is the seam's own backstop, so a caller feeding
  // un-scanned contributions - or a generator synthesizing a marker -
  // still fails closed.
  for (const [anchor, list] of sortedByKey(contributions)) {
    for (const { source, text } of list) {
      const hint = ANCHOR_HINT_RE.exec(text.toString("latin1"));
      if (hint) {
        errors.push(
          `${source}: the contribution to anchor '${anchor}' contains an anchor ` +
            `marker ('${hint[0]}') - a marker inside a contribution is never ` +
            "scanned or filled (anchors live in skeleton files only, each in " +
            "exactly one); move the marker line to a skeleton file or remove it",
        );
      }
    }
  }

  for (const [anchor, list] of sortedByKey(contributions)) {
    if (!anchorOwner.has(anchor)) {
      for (const { source } of list) {
        errors.push(
          `${source}: no anchor {# compose:${anchor} #} found in any source ` +
            "file - the contribution has nowhere to splice; add the marker " +
            "line to a skeleton file, or remove the contribution (delete " +
            "the fragment or drop the manifest data feeding it)",
        );
      }
    }
  }
  for (const [anchor, owner] of sortedByKey(anchorOwner)) {
    if ((contributions.get(anchor)?.length ?? 0) > 0) continue;
    const dataHint =
      anchor in DATA_ANCHORS ? `, or declare the manifest data (${DATA_ANCHORS[anchor].data})` : "";
    errors.push(
      `templates/${owner.source}/${owner.logical}: anchor '${anchor}' has no ` +
        `contributions - remove the marker or add ${FRAGMENTS_DIR}/${anchor}${JINJA_SUFFIX} ` +
        `to a module${dataHint}`,
    );
  }
  for (const [anchor, list] of sortedByKey(contributions)) {
    const owner = anchorOwner.get(anchor);
    if (owner) errors.push(...renderedSeparationErrors(anchor, list, owner.tight));
  }
  if (errors.length > 0) return errors;

  // Total: every anchor surviving the validation above has contributions
  // (an empty anchor already returned as an error), so a miss here is a
  // programming error and fails loudly instead of splicing nothing.
  const contributionsOf = (anchor: string): Contribution[] => {
    const list = contributions.get(anchor);
    if (list === undefined) throw new Error(`no contributions collected for anchor '${anchor}'`);
    return list;
  };

  for (const sourced of files.values()) {
    const { entry } = sourced;
    if (entry.kind === "symlink" || !entry.data.includes(ANCHOR_HINT)) continue;
    // First pass: every line's effective replacement, so the guard decision
    // below can look forward across anchor lines at the text that will
    // actually surround the marker line's newline.
    const pieces = splitLines(entry.data).map((line) => {
      const anchor = matchAnchor(line);
      if (anchor === null) return { anchor, list: [], text: line };
      const list = contributionsOf(anchor.name);
      const text = Buffer.concat([...list.map((c) => c.text), Buffer.from(anchor.trailing)]);
      return { anchor, list, text };
    });
    const rebuilt: Buffer[] = [];
    // Carried text absorbs the marker line's newline into the next line: a
    // tight anchor by definition, a guarded plain anchor because the guard
    // block supplies the newline itself.
    let carry: Buffer | null = null;
    const emit = (chunk: Buffer) => {
      rebuilt.push(carry === null ? chunk : Buffer.concat([carry, chunk]));
      carry = null;
    };
    const carryOver = (chunk: Buffer) => {
      carry = carry === null ? chunk : Buffer.concat([carry, chunk]);
    };
    for (let at = 0; at < pieces.length; at++) {
      const { anchor, list, text } = pieces[at];
      if (anchor === null) {
        emit(text);
        continue;
      }
      if (anchor.tight) {
        carryOver(text);
        continue;
      }
      // No newline to guard on the file's last segment; a trailing literal
      // keeps its newline or the literal would fuse onto the next line.
      const guard =
        anchor.trailing === "" && at + 1 < pieces.length
          ? collapseGuard(
              list,
              text,
              trimsFollowingWhitespace(pieces.slice(at + 1).map((piece) => piece.text)),
            )
          : null;
      if (guard === null) emit(text);
      else carryOver(Buffer.concat([text, guard]));
    }
    if (carry !== null) rebuilt.push(carry);
    entry.data = joinLines(rebuilt);
  }
  return errors;
}
