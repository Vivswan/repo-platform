// The three facts GitHub's `uses:` resolution, pinact, and Dependabot leave to this checkout to hold:
//   a self pin's stem is fetched at the ref per caller, so a moved or deleted action 404s every fleet run at once;
//   pinact verifies only a full `# vX.Y.Z` comment against its commit, so `# v7` passes it unverified, sha included;
//   Dependabot reaches the root and actions/** alone, so one sha per action repo-wide holds only if the files/** pins are held to theirs.

import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  DELIVERY_REF,
  MANAGED_HEADER_PATTERN,
  PLATFORM_NAME,
  PLATFORM_OWNER,
} from "../../actions/shared/platform";
import { actionManifestPaths } from "../../scripts/lib/action_steps";
import { REPO_ROOT } from "../shared/action_step";
import {
  extractUsesPins,
  ownsPlatform,
  type Pin,
  type SelfPin,
  selfPaths,
  sourceSelfPins,
} from "../shared/uses_pins";

function walk(rel: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(join(REPO_ROOT, rel)).sort()) {
    if (name === "node_modules") continue;
    const child = `${rel}/${name}`;
    const stat = lstatSync(join(REPO_ROOT, child));
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) found.push(...walk(child));
    else found.push(child);
  }
  return found;
}

const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf-8");

const MANIFESTS = actionManifestPaths(join(REPO_ROOT, "actions"));
/** The sources the fleet executes: the writer's tree, this repository's workflows, and the action manifests. */
const PIN_SITES = [...walk("files"), ...walk(".github/workflows"), ...MANIFESTS];
/** Plus the docs and skills, whose examples spell the shape a reader copies. */
const SELF_PIN_SITES = [...PIN_SITES, ...walk("docs"), ...walk("skills")];

const callable = callableWorkflowNames(
  walk(".github/workflows").map((path) => ({ path, text: read(path) })),
);
const exists = (rel: string) => existsSync(join(REPO_ROOT, rel));

/** True when pinact settles the line itself: a full version it verifies, or no version comment at all (its code 005). False is
 *  the gap: a comment pinact reads as a version but leaves unverified, sha included. The branches follow pinact's classifier order. */
export function pinactJudgesComment(comment: string): boolean {
  const version = comment.replace(/^tag=/, "");
  if (!/^v?\d/.test(version)) return true;
  if (/\b[0-9a-f]{40}\b/.test(version)) return false;
  return /^v?\d+\.\d+\.\d+\S*$/.test(version);
}

export function unverifiablePins(pins: Pin[]): Pin[] {
  return pins.filter((pin) => pin.version !== null && !pinactJudgesComment(pin.version));
}

/** The third-party pins whose action is pinned at more than one ref, as `action: ref (files)` lines, one per ref.
 *  GitHub reads `owner/repo` case-insensitively, so the grouping does too. A self pin rides the delivery ref under every
 *  spelling (judged below), so it is left out here. */
export function splitPins(pins: Pin[]): string[] {
  const self = `${PLATFORM_OWNER}/${PLATFORM_NAME}`.toLowerCase();
  const byAction = new Map<string, Map<string, string[]>>();
  for (const pin of pins) {
    const action = pin.action.toLowerCase();
    if (action === self) continue;
    const refs = byAction.get(action) ?? new Map<string, string[]>();
    refs.set(pin.ref, [...(refs.get(pin.ref) ?? []), pin.file]);
    byAction.set(action, refs);
  }
  return [...byAction]
    .filter(([, refs]) => refs.size > 1)
    .flatMap(([action, refs]) =>
      [...refs].map(([ref, files]) => `${action}: ${ref} (${[...new Set(files)].join(", ")})`),
    );
}

/** The workflows a `uses:` can call: the files DIRECTLY under .github/workflows whose triggers include workflow_call. */
export function callableWorkflowNames(files: { path: string; text: string }[]): string[] {
  const dir = ".github/workflows/";
  return files
    .filter((f) => f.path.startsWith(dir) && /^[^/]+\.ya?ml$/.test(f.path.slice(dir.length)))
    .filter((f) => {
      const doc: unknown = parseYaml(f.text);
      const on = doc && typeof doc === "object" ? (doc as Record<string, unknown>).on : undefined;
      if (typeof on === "string") return on === "workflow_call";
      if (Array.isArray(on)) return on.includes("workflow_call");
      return on !== null && typeof on === "object" && "workflow_call" in on;
    })
    .map((f) => f.path.slice(dir.length))
    .sort();
}

/** GitHub's resolution of a path inside this repository: a `.github/workflows/` path is the file itself and must be
 *  callable; any other path is a directory read by either manifest spelling. */
export function resolves(
  path: string,
  exists: (rel: string) => boolean,
  callable: readonly string[],
): boolean {
  const workflows = ".github/workflows/";
  if (path.startsWith(workflows))
    return callable.includes(path.slice(workflows.length)) && exists(path);
  return [`${path}/action.yml`, `${path}/action.yaml`].some(exists);
}

/** The stem's first segment is the platform name in whatever case the pin spelled it; the path after it is what GitHub fetches. */
export function unresolvedSelfPins(
  pins: SelfPin[],
  exists: (rel: string) => boolean,
  callable: readonly string[],
): SelfPin[] {
  return pins.filter(
    (pin) => !resolves(pin.stem.slice(`${PLATFORM_NAME}/`.length), exists, callable),
  );
}

const SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";

describe("version comments pinact leaves unverified", () => {
  const pin = (version: string | null): Pin => ({
    file: "a.yml",
    action: "actions/checkout",
    ref: SHA,
    version,
  });

  test("every comment pinact judges itself passes", () => {
    const judged = [
      "v7.0.1",
      "7.0.1",
      "v7.0.1-rc",
      "v9.0.0.0",
      "tag=v7.0.1",
      "main",
      "tag=main",
      `main-${SHA}`,
      "V7.0.1",
      null,
    ];
    expect(unverifiablePins(judged.map(pin))).toEqual([]);
  });

  test.each([
    "v999",
    "v7",
    "v7.0",
    "999",
    "7",
    "v999-beta",
    "2024-01",
    "tag=v999-beta",
    `v7.0.1-${SHA}`,
  ])(
    "a `# %s` comment is the gap: pinact reads it as a version but verifies only the full shape",
    (version) => {
      expect(unverifiablePins([pin(version)])).toEqual([pin(version)]);
    },
  );

  test("no pin site carries one", () => {
    const pins = PIN_SITES.flatMap((rel) => extractUsesPins(read(rel), rel));
    expect(pins.length).toBeGreaterThan(0);
    expect(
      unverifiablePins(pins).map((pin) => `${pin.file}: ${pin.action}@${pin.ref} # ${pin.version}`),
    ).toEqual([]);
  });
});

describe("one sha per action across the root and the shipped sources", () => {
  const pin = (file: string, action: string, ref: string): Pin => ({
    file,
    action,
    ref,
    version: null,
  });

  // The control: a shipped pin behind the root's is reported under its action with both files, whatever the owner's case;
  // the self pin's refs are not compared.
  test("a split action is reported per ref; agreeing and self pins are not", () => {
    const root = pin(".github/workflows/ci.yml", "actions/checkout", SHA);
    const shipped = pin("files/base/.github/workflows/ci.yml", "Actions/Checkout", "0".repeat(40));
    const agreeing = pin("files/bun/x.yml", "oven-sh/setup-bun", "1".repeat(40));
    const self = pin("files/base/ci.yml", `${PLATFORM_OWNER}/${PLATFORM_NAME}`, DELIVERY_REF);
    const selfMoved = pin("docs/x.md", `${PLATFORM_OWNER}/${PLATFORM_NAME}`, "main");
    expect(splitPins([root, shipped, agreeing, root, self, selfMoved])).toEqual([
      `actions/checkout: ${SHA} (.github/workflows/ci.yml)`,
      `actions/checkout: ${"0".repeat(40)} (files/base/.github/workflows/ci.yml)`,
    ]);
  });

  test("every pin site names one ref per action", () => {
    const pins = PIN_SITES.flatMap((rel) => extractUsesPins(read(rel), rel));
    expect(pins.length).toBeGreaterThan(0);
    expect(splitPins(pins)).toEqual([]);
  });
});

describe("self pins resolve at the delivery ref", () => {
  // The controls that arm the sweep below: GitHub's resolution rule (a `.github/workflows/` stem must be callable and
  // present; any other stem needs action.yml or action.yaml), the roster's workflow_call spellings, and the owner
  // spellings a self pin may carry (a mistyped owner is a self pin on a repository that does not exist, not a third party).
  test("a missing action directory, a non-callable workflow, a missing workflow file, and a mistyped owner each fail; every workflow_call spelling and owner spelling resolves", () => {
    const at = (name: string, text: string) => ({ path: `.github/workflows/${name}`, text });
    expect(
      callableWorkflowNames([
        at("mapping.yml", "on:\n  workflow_call:\n    inputs: {}\n"),
        at("string.yaml", "on: workflow_call\n"),
        at("list.yml", "on: [push, workflow_call]\n"),
        at("push.yml", "on: push\n"),
        at("nested/call.yml", "on: workflow_call\n"),
      ]),
    ).toEqual(["list.yml", "mapping.yml", "string.yaml"]);
    const pins = sourceSelfPins(
      [
        "      - uses: Vivswan/repo-platform/actions/plan@stable",
        "      - uses: {{github_username}}/repo-platform/actions/does-not-exist@stable",
        "    uses: {{ github_username_lower }}/repo-platform/.github/workflows/ci.yml@stable",
        "    uses: Vivswan/repo-platform/.github/workflows/reusable-ghost.yml@stable",
        "    uses: Vivswan/repo-platform/.github/workflows/fleet.yml@stable",
        "    uses: Vivswan/Repo-Platform/.github/workflows/fleet.yml@stable",
      ].join("\n"),
      "f",
    );
    expect(unresolvedSelfPins(pins, exists, callable).map((pin) => pin.stem)).toEqual([
      "repo-platform/actions/does-not-exist",
      "repo-platform/.github/workflows/ci.yml",
      "repo-platform/.github/workflows/reusable-ghost.yml",
    ]);
    const owners = sourceSelfPins(
      [
        "      - uses: Vivswan/repo-platform/actions/plan@stable",
        "      - uses: vivswan/repo-platform/actions/plan@stable",
        "      - uses: {{ github_username_lower }}/repo-platform/actions/plan@stable",
        "      - uses: Vivswna/repo-platform/actions/plan@stable",
        "      - uses: {{other_owner}}/repo-platform/actions/plan@stable",
        "      - uses: actions/checkout@v7",
      ].join("\n"),
      "f",
    ).map((pin) => [pin.owner, ownsPlatform(pin.owner)]);
    expect(owners).toEqual([
      ["Vivswan", true],
      ["vivswan", true],
      ["{{ github_username_lower }}", true],
      ["Vivswna", false],
      ["{{other_owner}}", false],
    ]);
  });

  test("every self pin in the sources, workflows, manifests, docs, and skills names this owner, resolves in this checkout, and rides the delivery ref", () => {
    const pins = SELF_PIN_SITES.flatMap((rel) => sourceSelfPins(read(rel), rel));
    expect(pins.length).toBeGreaterThan(0);
    const describe = (pin: SelfPin) => `${pin.file}: ${pin.stem}@${pin.ref}`;
    expect(unresolvedSelfPins(pins, exists, callable).map(describe)).toEqual([]);
    expect(pins.filter((pin) => pin.ref !== DELIVERY_REF).map(describe)).toEqual([]);
    expect(pins.filter((pin) => !ownsPlatform(pin.owner)).map(describe)).toEqual([]);
  });
});

// GitHub resolves `$/` against the file's own repository at its running commit, `./` against the caller's workspace, and
// `...@stable` at the tag when the job runs, and `$/` takes no `@ref`. Every form is green in this repository's own CI, so
// the form is held here: `$/` between platform files; the tag pin in a starter, which runs where `$/` would name the fleet
// repository (docs/platform/build-provenance.md). A managed root copy is judged under files/.
describe("platform files reference each other by `$/`; the starters pin the delivery ref", () => {
  const WORKSPACE_PATH = /uses:\s*['"]?(\.\/(?:actions|\.github\/workflows)\/[^\s'"]+)/g;
  const platformSites = [...walk(".github/workflows"), ...MANIFESTS].filter(
    (rel) => !MANAGED_HEADER_PATTERN.test(read(rel)),
  );
  const judge = (rel: string, text: string) => ({
    byTag: sourceSelfPins(text, rel).map((pin) => `${pin.stem}@${pin.ref}`),
    byWorkspacePath: [...text.matchAll(WORKSPACE_PATH)].map((match) => match[1]),
    unresolved: selfPaths(text, rel)
      .filter((self) => !resolves(self.path, exists, callable))
      .map((self) => self.path),
  });

  // The control: a tag pin, a workspace path under either platform root, a `$/` path carrying an @ref, and a `$/` path to
  // no action or to a workflow nothing can call are each reported; the caller's own action and a resolving `$/` path are not.
  test("a tag pin, a workspace path under a platform root, a `$/` path with an @ref, and a `$/` path to nothing are each refused; the caller's own action and a resolving path pass", () => {
    const text = [
      "      - uses: Vivswan/repo-platform/actions/plan@stable",
      "      - uses: ./actions/plan",
      "    uses: ./.github/workflows/reusable-codeql.yml",
      "      - uses: ./.github/actions/site-build",
      "      - uses: $/actions/plan",
      "      - uses: $/actions/plan@stable",
      "      - uses: $/actions/does-not-exist",
      "    uses: $/.github/workflows/reusable-codeql.yml",
      "    uses: $/.github/workflows/ci.yml",
    ].join("\n");
    expect(judge("f", text)).toEqual({
      byTag: ["repo-platform/actions/plan@stable"],
      byWorkspacePath: ["./actions/plan", "./.github/workflows/reusable-codeql.yml"],
      unresolved: ["actions/plan@stable", "actions/does-not-exist", ".github/workflows/ci.yml"],
    });
  });

  test("every platform workflow and manifest names a platform file by `$/` alone, each path resolving", () => {
    const paths = platformSites.flatMap((rel) => selfPaths(read(rel), rel));
    expect(paths.length).toBeGreaterThan(30);
    const judged = Object.fromEntries(platformSites.map((rel) => [rel, judge(rel, read(rel))]));
    expect(judged).toEqual(
      Object.fromEntries(
        platformSites.map((rel) => [rel, { byTag: [], byWorkspacePath: [], unresolved: [] }]),
      ),
    );
  });

  test("no starter names a platform file by `$/`", () => {
    const starters = walk("files");
    expect(starters.length).toBeGreaterThan(0);
    expect(
      starters.flatMap((rel) => selfPaths(read(rel), rel).map((self) => `${rel}: $/${self.path}`)),
    ).toEqual([]);
  });
});
