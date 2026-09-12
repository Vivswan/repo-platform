import { existsSync } from "node:fs";
import { join } from "node:path";
import { FLEET_WORKFLOWS } from "../../../.github/scripts/build-branches/branch_tree.ts";
import { PLATFORM_NAME, PLATFORM_OWNER } from "../../../actions/shared/platform.ts";
import { actionManifestPaths } from "../../lib/action_steps.ts";
import { constStringValue } from "../../lib/ts_extract.ts";
import { escapeRegExp, type Mismatch, sortedSet } from "./comparison.ts";
import { REPO_ROOT, read, walkFiles } from "./inputs.ts";
import type { Rule } from "./rule_roster.ts";

export interface Pin {
  file: string;
  action: string;
  ref: string;
  /** The trailing `# <tag>` comment naming what the ref was pinned from,
   *  or null when the line carries none. */
  version: string | null;
}

/** Commented example lines count too, and placeholder-owner pins are skipped: the fleet-refs-ride-build rule judges those. */
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

/** The checked-out actions/ tree's manifests: the one walk every rule over
 *  action manifests, the pin generator, and their forcing tests share, so
 *  no two judge different rosters. */
export function actionManifestFiles(): string[] {
  return actionManifestPaths(join(REPO_ROOT, "actions"));
}

/** Third-party actions pinned to a BRANCH commit rather than a release: the
 *  value is the branch the trailing comment must name. Record the reason
 *  with each entry (an action that publishes no version tags). */
export const BRANCH_PINNED: Record<string, string> = {};

const SHA_RE = /^[0-9a-f]{40}$/;
const VERSION_COMMENT_RE = /^v\d+\.\d+\.\d+$/;

/** A moving tag or branch would let upstream change what the fleet runs without a PR here; `@<sha> # vX.Y.Z` is the shape Dependabot bumps.
 *  The owner's own actions are exempt: the platform's self-pins under files/ are judged by the fleet-refs-ride-build rule,
 *  and the settings apply's pin by the settings-apply-input rule. */
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

/** A twin of publish.ts's BRANCH, pinned against it by the fleet-refs-ride-build rule so a delivery-branch rename updates both.
 *  Starters are written once, so a rename reaches fresh writes only, never a pin an already-written starter carries. */
export const DELIVERY_REF = "build";

export interface SelfPin {
  file: string;
  /** The pin's stem after the owner: <name>/<path>. */
  stem: string;
  ref: string;
}

/** A self pin is a `uses:` naming this repository; the owner slot is the `github_username` placeholder in either case
 *  in the writer's sources and PLATFORM_OWNER itself in this repository's own workflows, manifests, and doc examples.
 *  Only the `uses:` keyword marks a pin: prose spells the shape with an ellipsis (`<owner>/<name>/...@<ref>`). */
export function sourceSelfPins(text: string, file: string): SelfPin[] {
  const ownerSlot = String.raw`(?:\{\{\s*github_username(?:_lower)?\s*\}\}|${escapeRegExp(PLATFORM_OWNER)})`;
  const token = new RegExp(
    String.raw`uses:\s*['"]?${ownerSlot}/(${escapeRegExp(PLATFORM_NAME)}/[A-Za-z0-9_./-]+)@([^\s"'\x60]*)`,
    "gi",
  );
  return [...text.matchAll(token)].map((match) => ({ file, stem: match[1], ref: match[2] }));
}

/** An empty scan means the extraction grammar rotted, not a clean fleet: the sources always carry self-references. */
function anchoredSelfPins(pins: SelfPin[]): SelfPin[] {
  if (pins.length === 0) {
    throw new Error(
      `no ${PLATFORM_NAME} self-reference found in the scanned content - anchor lost ` +
        "(the writer's sources always pin their own actions and reusables)",
    );
  }
  return pins;
}

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

/** `@main` is the ungated live tip and any other ref forks the delivery story. */
export function deliveryRefMismatches(pins: SelfPin[], deliveryRef: string): Mismatch[] {
  return anchoredSelfPins(pins)
    .filter((pin) => pin.ref !== deliveryRef)
    .map((pin) => ({
      file: pin.file,
      expected: `${pin.stem}@${deliveryRef} (fleet-written content executes only the green-gated delivery branch)`,
      got: `@${pin.ref}`,
    }));
}

/** A reusable-workflow `uses:` fetches the FILE at the ref, so a pin on a workflow the build branch does not ship 404s every caller run
 *  even with the right ref; branch_tree.ts ships exactly FLEET_WORKFLOWS.
 *  Actions have no roster: copyActions ships the whole actions/ tree, so the delivery-pin-stems rule's existence check is their whole guard. */
export function fleetWorkflowPinMismatches(
  pins: SelfPin[],
  shipped: readonly string[],
): Mismatch[] {
  const prefix = `${PLATFORM_NAME}/.github/workflows/`;
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

/** A `uses:` fetches the stem's path at the ref, so a pin on a moved or deleted action directory or workflow file 404s
 *  every caller run with the ref itself right; the checkout is the tree every delivery ref is assembled from.
 *  GitHub's resolution: a `.github/workflows/` stem is the file itself, any other stem is a directory read by either manifest spelling. */
export function stemMismatches(pins: SelfPin[], exists: (rel: string) => boolean): Mismatch[] {
  return anchoredSelfPins(pins).flatMap((pin) => {
    const path = pin.stem.slice(`${PLATFORM_NAME}/`.length);
    const wanted = path.startsWith(".github/workflows/")
      ? [path]
      : [`${path}/action.yml`, `${path}/action.yaml`];
    if (wanted.some(exists)) return [];
    return [
      {
        file: pin.file,
        expected: `${wanted.join(" or ")} in the checkout (a uses: fetches it at the ref, so a missing stem 404s every caller)`,
        got: `${pin.stem}@${pin.ref} (no such path)`,
      },
    ];
  });
}

function pinSites(): string[] {
  return [
    ...walkFiles(".github/workflows").map((f) => f.path),
    ...walkFiles("files")
      .filter((f) => !f.symlink)
      .map((f) => f.path),
    ...actionManifestFiles(),
  ];
}

/** The pin sites plus the docs and skills, whose examples spell the shape a reader copies. */
function selfPinSites(): string[] {
  return [
    ...pinSites(),
    ...["docs", "skills"].flatMap((dir) =>
      walkFiles(dir)
        .filter((f) => !f.symlink)
        .map((f) => f.path),
    ),
  ];
}

export const deliveryPinRules: Rule[] = [
  {
    name: "action-pins",
    run: () => {
      const pins = pinSites().flatMap((rel) => extractUsesPins(read(rel), rel));
      if (pins.length === 0)
        throw new Error("no `uses: owner/action@ref` pins found anywhere - anchor lost");
      return [...pinMismatches(pins), ...pinShapeMismatches(pins, PLATFORM_OWNER, BRANCH_PINNED)];
    },
  },
  {
    // One blanket scan over files/ (exactly what the fleet receives), never per-file pins, so a planted @main reds with its file and ref.
    // publish.ts's BRANCH is read off the AST: importing the publisher would run its git wiring.
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
  {
    name: "delivery-pin-stems",
    run: () =>
      stemMismatches(
        selfPinSites().flatMap((rel) => sourceSelfPins(read(rel), rel)),
        (rel) => existsSync(join(REPO_ROOT, rel)),
      ),
  },
];
