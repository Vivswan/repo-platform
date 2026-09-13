// The two facts GitHub's `uses:` resolution and pinact leave to this checkout to hold:
//   a self pin's stem is fetched at the ref per caller, so a moved or deleted action 404s every fleet run at once;
//   pinact verifies only a full `# vX.Y.Z` comment against its commit, so `# v7` passes it unverified, sha included.

import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { DELIVERY_REF, PLATFORM_NAME } from "../../actions/shared/platform";
import { REPO_ROOT } from "../shared/action_step";
import {
  extractUsesPins,
  ownsPlatform,
  type Pin,
  type SelfPin,
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

/** The sources the fleet executes: the writer's tree, this repository's workflows, and the action manifests. */
const PIN_SITES = [
  ...walk("files"),
  ...walk(".github/workflows"),
  ...walk("actions").filter((rel) => /\/action\.ya?ml$/.test(rel)),
];
/** Plus the docs and skills, whose examples spell the shape a reader copies. */
const SELF_PIN_SITES = [...PIN_SITES, ...walk("docs"), ...walk("skills")];

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

/** GitHub's resolution: a `.github/workflows/` stem is the file itself and must be callable; any other stem is a directory read by either manifest spelling. */
export function unresolvedSelfPins(
  pins: SelfPin[],
  exists: (rel: string) => boolean,
  callable: readonly string[],
): SelfPin[] {
  const workflows = ".github/workflows/";
  return pins.filter((pin) => {
    // The stem's first segment is the platform name in whatever case the pin spelled it; the path after it is what GitHub fetches.
    const path = pin.stem.slice(`${PLATFORM_NAME}/`.length);
    if (path.startsWith(workflows)) {
      return !callable.includes(path.slice(workflows.length)) || !exists(path);
    }
    return ![`${path}/action.yml`, `${path}/action.yaml`].some(exists);
  });
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

describe("self pins resolve at the delivery ref", () => {
  const workflows = walk(".github/workflows").map((path) => ({ path, text: read(path) }));
  const callable = callableWorkflowNames(workflows);
  const exists = (rel: string) => existsSync(join(REPO_ROOT, rel));

  test("the callable roster takes every workflow_call spelling, only directly under .github/workflows", () => {
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
  });

  test("a missing action directory, a non-callable workflow, and a workflow file that is not there each fail to resolve; a callable one resolves in any case", () => {
    const pins = sourceSelfPins(
      [
        "      - uses: Vivswan/repo-platform/actions/plan@stable",
        "      - uses: {{github_username}}/repo-platform/actions/does-not-exist@stable",
        "    uses: {{ github_username_lower }}/repo-platform/.github/workflows/ci.yml@stable",
        "    uses: Vivswan/repo-platform/.github/workflows/reusable-ghost.yml@stable",
        "    uses: Vivswan/repo-platform/.github/workflows/fleet-ci.yml@stable",
        "    uses: Vivswan/Repo-Platform/.github/workflows/fleet-ci.yml@stable",
      ].join("\n"),
      "f",
    );
    expect(unresolvedSelfPins(pins, exists, callable).map((pin) => pin.stem)).toEqual([
      "repo-platform/actions/does-not-exist",
      "repo-platform/.github/workflows/ci.yml",
      "repo-platform/.github/workflows/reusable-ghost.yml",
    ]);
  });

  test("a mistyped owner is a self pin on a repository that does not exist, not a third-party pin", () => {
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
