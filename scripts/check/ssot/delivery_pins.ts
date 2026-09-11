// Rules pinning what the fleet executes from: upstream action refs and
// every self-reference riding the build branch.

import {
  EXCLUDED_DIRS as EXCLUDED_ACTION_DIRS,
  FLEET_WORKFLOWS,
} from "../../../.github/scripts/build-branches/branch_tree.ts";
import { constStringValue } from "../../lib/ts_extract.ts";
import { type Mismatch, sortedSet } from "./comparison.ts";
import { OWNER, read, walkFiles } from "./inputs.ts";
import type { Rule } from "./rule_roster.ts";

export interface Pin {
  file: string;
  action: string;
  ref: string;
  /** The trailing `# <tag>` comment naming what the ref was pinned from,
   *  or null when the line carries none. */
  version: string | null;
}

/** `uses: <owner>/<action>@<ref>` pins in a file, commented examples
 *  included; `uses: ./...` locals and placeholder-owner lines are skipped
 *  (the fleet-refs-ride-build rule judges those). The action key is
 *  owner/repo (subpaths like codeql-action/init collapse). */
export function extractUsesPins(text: string, file: string): Pin[] {
  const pins: Pin[] = [];
  for (const rawLine of text.split("\n")) {
    // Substitute placeholders with a sentinel that cannot be part of a
    // valid owner/action or ref: a line can carry BOTH a real pin and an
    // unrelated placeholder, so skipping the whole line would drop the pin.
    const line = rawLine.replace(/\{\{[^}]*\}\}/g, "<PLACEHOLDER>");
    const match = line.match(
      /uses:\s*['"]?([A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+)@([^\s'"]+)['"]?(?:[ \t]+#[ \t]*(\S+))?/,
    );
    if (!match) continue;
    if (match[2].includes("<PLACEHOLDER>")) continue;
    const action = match[1].split("/").slice(0, 2).join("/");
    pins.push({ file, action, ref: match[2], version: match[3] ?? null });
  }
  return pins;
}

/** Every composite action manifest under actions/, in either spelling the
 *  runner reads (action.yml or action.yaml), nested ones included
 *  (actions/pages-site/check-links is a manifest of its own), from a
 *  walkFiles listing; symlinks are not manifests, and the directories
 *  publication excludes never reach the fleet. */
export function actionManifests(files: { path: string; symlink: boolean }[]): string[] {
  return files
    .filter(
      (f) =>
        !f.symlink &&
        /(^|\/)action\.ya?ml$/.test(f.path) &&
        !f.path.split("/").some((segment) => EXCLUDED_ACTION_DIRS.has(segment)),
    )
    .map((f) => f.path)
    .sort();
}

/** The checked-out actions/ tree's manifests: the one walk every rule over
 *  action manifests and their forcing tests share, so no two judge
 *  different rosters. */
export function actionManifestFiles(): string[] {
  return actionManifests(walkFiles("actions"));
}

/** Third-party actions pinned to a BRANCH commit rather than a release: the
 *  value is the branch the trailing comment must name. Record the reason
 *  with each entry. dtolnay/rust-toolchain publishes no version tags (its
 *  branches name toolchains), so its pin is a master commit and the
 *  toolchain travels as the step's explicit input. */
export const BRANCH_PINNED: Record<string, string> = {
  "dtolnay/rust-toolchain": "master",
};

const SHA_RE = /^[0-9a-f]{40}$/;
const VERSION_COMMENT_RE = /^v\d+\.\d+\.\d+$/;

/** Every action outside `owner`'s account is pinned by full commit sha with
 *  the tag it came from as a trailing comment (`@<sha> # vX.Y.Z`, the shape
 *  Dependabot bumps), one comment per sha repo-wide. A moving tag or branch
 *  would let upstream change what the fleet runs without a PR here; the
 *  owner's own actions ride their own delivery channels and are judged by
 *  the fleet-refs-ride-build rule instead. */
export function pinShapeMismatches(
  pins: Pin[],
  owner: string,
  branchPinned: Record<string, string>,
): Mismatch[] {
  const mismatches: Mismatch[] = [];
  const thirdParty = pins.filter(
    (pin) => pin.action.split("/")[0].toLowerCase() !== owner.toLowerCase(),
  );
  const shape = (action: string) =>
    action in branchPinned
      ? `${action}@<full 40-hex commit sha> # ${branchPinned[action]}`
      : `${action}@<full 40-hex commit sha> # v<major>.<minor>.<patch>`;
  for (const pin of thirdParty) {
    const versionOk =
      pin.action in branchPinned
        ? pin.version === branchPinned[pin.action]
        : pin.version !== null && VERSION_COMMENT_RE.test(pin.version);
    if (SHA_RE.test(pin.ref) && versionOk) continue;
    mismatches.push({
      file: pin.file,
      expected: shape(pin.action),
      got: `@${pin.ref}${pin.version === null ? "" : ` # ${pin.version}`}`,
    });
  }
  const commentsBySha = new Map<string, Set<string>>();
  for (const pin of thirdParty) {
    if (!SHA_RE.test(pin.ref) || pin.version === null) continue;
    const key = `${pin.action}@${pin.ref}`;
    commentsBySha.set(key, new Set([...(commentsBySha.get(key) ?? []), pin.version]));
  }
  for (const [key, versions] of [...commentsBySha.entries()].sort()) {
    if (versions.size === 1) continue;
    mismatches.push({
      file: key,
      expected: "one version comment per pinned sha",
      got: [...versions].sort().join(", "),
    });
  }
  for (const action of Object.keys(branchPinned).sort()) {
    if (!thirdParty.some((pin) => pin.action === action)) {
      mismatches.push({
        file: action,
        expected: "an action still pinned somewhere (branch-pinned allowlist)",
        got: "no uses: pins found (stale allowlist entry - remove it)",
      });
    }
  }
  return mismatches;
}

/** One ref per action repo-wide: two sites pinning different refs of the
 *  same action would run two versions of it across the fleet. */
export function pinMismatches(pins: Pin[]): Mismatch[] {
  const byAction = new Map<string, Pin[]>();
  for (const pin of pins) {
    byAction.set(pin.action, [...(byAction.get(pin.action) ?? []), pin]);
  }
  const mismatches: Mismatch[] = [];
  for (const [action, actionPins] of [...byAction.entries()].sort()) {
    const refs = [...new Set(actionPins.map((p) => p.ref))].sort();
    if (refs.length === 1) continue;
    const sites = refs
      .map(
        (ref) =>
          `${ref} (${sortedSet(actionPins.filter((p) => p.ref === ref).map((p) => p.file))})`,
      )
      .join("; ");
    mismatches.push({ file: action, expected: "a single pinned ref", got: sites });
  }
  return mismatches;
}

/** The green-gated branch every self-pin the writer copies executes from.
 *  A twin of publish.ts's BRANCH constant (the one delivery channel
 *  post-green.yml publishes), pinned against it by the fleet-refs-ride-build
 *  rule, so a delivery-branch rename updates both. Starters are written
 *  once: a rename reaches fresh writes only, never a pin an already-written
 *  starter carries. */
export const DELIVERY_REF = "build";

export interface SelfPin {
  file: string;
  /** The pin's stem after the owner: repo-platform/<path>. */
  stem: string;
  ref: string;
}

/** Self-delivery pins in the writer's sources: the owner slot is the
 *  `github_username` placeholder in either case (the writer substitutes
 *  this owner, GitHub resolves owners case-insensitively), so the slot is
 *  matched by placeholder name, never by enumerating spellings. */
export function sourceSelfPins(text: string, file: string): SelfPin[] {
  const token =
    /(?<![A-Za-z0-9-])\{\{\s*github_username(?:_lower)?\s*\}\}\/(repo-platform\/[A-Za-z0-9_./-]+)@([^\s"']*)/g;
  return [...text.matchAll(token)].map((match) => ({ file, stem: match[1], ref: match[2] }));
}

/** DELIVERY_REF against the branch publish.ts actually advances: the
 *  pins below are only right while both name the same branch, so a
 *  rename of either alone mismatches, naming the twin to update. */
export function deliveryRefTwinMismatches(published: string, deliveryRef: string): Mismatch[] {
  if (published === deliveryRef) return [];
  return [
    {
      file: "scripts/check/ssot/delivery_pins.ts DELIVERY_REF",
      expected: `'${published}' (publish.ts's BRANCH - the branch the fleet's pins execute from)`,
      got: `'${deliveryRef}'`,
    },
  ];
}

/** The categorical delivery-channel law over the writer's sources: every
 *  `<owner>/repo-platform/<path>@<ref>` token - composite action and
 *  reusable workflow alike - must ride the green-gated delivery branch.
 *  `@main` is the ungated live tip, and any other ref forks the delivery
 *  story, so a single off-channel pin mismatches, named with its file and
 *  offending ref. Throws when no pin is found at all: the sources always
 *  carry self-references, so an empty scan means the extraction grammar
 *  rotted, not a clean fleet. */
export function deliveryRefMismatches(pins: SelfPin[], deliveryRef: string): Mismatch[] {
  if (pins.length === 0) {
    throw new Error(
      "no repo-platform self-reference found in the scanned content - anchor lost " +
        "(the writer's sources always pin their own actions and reusables)",
    );
  }
  return pins
    .filter((pin) => pin.ref !== deliveryRef)
    .map((pin) => ({
      file: pin.file,
      expected: `${pin.stem}@${deliveryRef} (fleet-written content executes only the green-gated delivery branch)`,
      got: `@${pin.ref}`,
    }));
}

/** The shipping side of the delivery-channel law: a reusable-workflow `uses:`
 *  fetches the FILE at the named ref, so a pin on a workflow the build
 *  branch does not ship 404s every caller run even though the ref is
 *  right; every `repo-platform/.github/workflows/<name>` pin must name a
 *  FLEET_WORKFLOWS entry (branch_tree.ts ships exactly that roster). Actions
 *  need no twin check: copyActions ships the whole actions/ tree, so an
 *  action pin can only 404 by naming a directory that does not exist, which
 *  the build-tree assembly catches. */
export function fleetWorkflowPinMismatches(
  pins: SelfPin[],
  shipped: readonly string[],
): Mismatch[] {
  const prefix = "repo-platform/.github/workflows/";
  return pins
    .filter(
      (pin) => pin.stem.startsWith(prefix) && !shipped.includes(pin.stem.slice(prefix.length)),
    )
    .map((pin) => ({
      file: pin.file,
      expected: `a reusable workflow on branch_tree.ts's FLEET_WORKFLOWS roster [${shipped.join(", ")}] (the build branch ships only the roster, so any other pin 404s at call time)`,
      got: pin.stem,
    }));
}

/** The rules this module contributes to the checker's run (check_ssot.ts). */
export const deliveryPinRules: Rule[] = [
  {
    name: "action-pins",
    run: () => {
      const files = [
        ...walkFiles(".github/workflows").map((f) => f.path),
        // The sync writer's sources, workflow block files included: what
        // the fleet runs after a sync.
        ...walkFiles("files")
          .filter((f) => !f.symlink)
          .map((f) => f.path),
        ...actionManifestFiles(),
      ];
      const pins = files.flatMap((rel) => extractUsesPins(read(rel), rel));
      if (pins.length === 0)
        throw new Error("no `uses: owner/action@ref` pins found anywhere - anchor lost");
      return [...pinMismatches(pins), ...pinShapeMismatches(pins, OWNER, BRANCH_PINNED)];
    },
  },
  {
    // The categorical delivery-channel law: EVERY self-reference in the
    // writer's sources (composite action or reusable workflow) rides the
    // green-gated build branch. One blanket scan, never per-file pins, so
    // a planted @main reds with the file and ref; the scope (files/) is
    // structural, exactly what the fleet receives and executes, while this
    // repo's own workflows live outside it. DELIVERY_REF is pinned against
    // publish.ts's BRANCH by AST (importing the publisher would run its git
    // wiring).
    name: "fleet-refs-ride-build",
    run: () => {
      const published = constStringValue(
        read(".github/scripts/build-branches/publish.ts"),
        "BRANCH",
        { where: "publish.ts", what: "the delivery branch" },
      );
      const pins = walkFiles("files")
        .filter((f) => !f.symlink)
        .flatMap((f) => sourceSelfPins(read(f.path), f.path));
      return [
        ...deliveryRefTwinMismatches(published, DELIVERY_REF),
        ...deliveryRefMismatches(pins, DELIVERY_REF),
        ...fleetWorkflowPinMismatches(pins, FLEET_WORKFLOWS),
      ];
    },
  },
];
