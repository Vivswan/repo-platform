import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
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

/** Commented example lines count too, and placeholder-owner pins are skipped: the fleet-refs-ride-stable rule judges those. */
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
export const BRANCH_PINNED: Record<string, string> = {
  // Vivswan/skills publishes no release tags; ci.yml runs its validate-skills action on this repository's own catalog.
  "Vivswan/skills": "main",
};

const SHA_RE = /^[0-9a-f]{40}$/;
const VERSION_COMMENT_RE = /^v\d+\.\d+\.\d+$/;

/** A moving tag or branch would let upstream change what the fleet runs without a PR here; `@<sha> # vX.Y.Z` is the shape Dependabot bumps.
 *  Only the platform's own refs are exempt: they ride the green-gated delivery tag (the fleet-refs-ride-stable rule judges the
 *  ones under files/). The owner's other repositories are upstream code like any third party's, the settings apply's pin included. */
export function pinShapeMismatches(
  pins: Pin[],
  owner: string,
  branchPinned: Record<string, string>,
): Mismatch[] {
  const mismatches: Mismatch[] = [];
  const self = `${owner}/${PLATFORM_NAME}`.toLowerCase();
  const thirdParty = pins.filter((pin) => pin.action.toLowerCase() !== self);
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

/** A twin of move_stable.ts's TAG, pinned against it by the fleet-refs-ride-stable rule so a delivery-tag rename updates both.
 *  Starters are written once, so a rename reaches fresh writes only, never a pin an already-written starter carries. */
export const DELIVERY_REF = "stable";

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

/** `moved` is the full ref the mover pushes (refs/tags/<name>); the pins carry the bare name. */
export function deliveryRefTwinMismatches(moved: string, deliveryRef: string): Mismatch[] {
  if (moved === `refs/tags/${deliveryRef}`) return [];
  return [
    {
      file: "scripts/check/ssot/delivery_pins.ts DELIVERY_REF",
      expected: `the tag of move_stable.ts's TAG '${moved}' (the ref the fleet's pins execute from)`,
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
      expected: `${pin.stem}@${deliveryRef} (fleet-written content executes only the green-gated delivery tag)`,
      got: `@${pin.ref}`,
    }));
}

export interface WorkflowFile {
  path: string;
  text: string;
}

const WORKFLOWS_DIR = ".github/workflows/";

export function workflowFiles(): WorkflowFile[] {
  return walkFiles(".github/workflows")
    .filter((f) => !f.symlink)
    .map((f) => ({ path: f.path, text: read(f.path) }));
}

/** The workflows a `uses:` can call at the delivery commit: the files DIRECTLY under .github/workflows (GitHub runs no
 *  nested path) whose triggers include workflow_call. A pin on any other name fails at call time, whatever the ref. */
export function callableWorkflowNames(workflows: readonly WorkflowFile[]): string[] {
  return workflows
    .filter(
      (f) =>
        f.path.startsWith(WORKFLOWS_DIR) &&
        /^[^/]+\.ya?ml$/.test(f.path.slice(WORKFLOWS_DIR.length)),
    )
    .filter((f) => {
      const doc: unknown = parseYaml(f.text);
      const on = doc && typeof doc === "object" ? (doc as Record<string, unknown>).on : undefined;
      if (typeof on === "string") return on === "workflow_call";
      if (Array.isArray(on)) return on.includes("workflow_call");
      return on !== null && typeof on === "object" && "workflow_call" in on;
    })
    .map((f) => f.path.slice(WORKFLOWS_DIR.length))
    .sort();
}

/** Actions have no roster: the delivery-pin-stems rule's existence check is their whole guard. */
export function fleetWorkflowPinMismatches(
  pins: SelfPin[],
  callable: readonly string[],
): Mismatch[] {
  const prefix = `${PLATFORM_NAME}/.github/workflows/`;
  return pins
    .filter(
      (pin) => pin.stem.startsWith(prefix) && !callable.includes(pin.stem.slice(prefix.length)),
    )
    .map((pin) => ({
      file: pin.file,
      expected: `a workflow_call workflow under .github/workflows [${callable.join(", ")}] (a uses: fetches the file at the delivery ref, so any other pin fails at call time)`,
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
    // move_stable.ts's TAG is read off the AST: importing the mover would run its git wiring.
    name: "fleet-refs-ride-stable",
    run: () => {
      const moved = constStringValue(read(".github/scripts/post-green/move_stable.ts"), "TAG", {
        where: "move_stable.ts",
        what: "the delivery tag",
      });
      const pins = walkFiles("files")
        .filter((f) => !f.symlink)
        .flatMap((f) => sourceSelfPins(read(f.path), f.path));
      return [
        ...deliveryRefTwinMismatches(moved, DELIVERY_REF),
        ...deliveryRefMismatches(pins, DELIVERY_REF),
        ...fleetWorkflowPinMismatches(pins, callableWorkflowNames(workflowFiles())),
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
