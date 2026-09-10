// Rules pinning the bun toolchain: package homes and lockfiles, the
// @types/bun coupling, version-file setup steps, the composite actions' bun
// guard, the local runtime, dependabot's action directories, and files.yml's
// copy of every toolchain pin.

import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  EXCLUDED_DIRS as EXCLUDED_ACTION_DIRS,
  EXCLUDED_DIRS,
} from "../../../.github/scripts/build-branches/branch_tree.ts";
import { parseFilesConfig } from "../../../.github/scripts/sync/writer/files_config.ts";
import { bunLockDirs } from "../../bootstrap.ts";
import {
  actionSetsUpBun,
  actionSteps,
  BUN_SETUP_ACTION,
  usesBunSetup,
  usesSetupBun,
} from "../../generate/toolchain_pins.ts";
import { normalizeJinja } from "../../lib/jinja_subset.ts";
import { canonical, type Mismatch, mustMatch } from "./comparison.ts";
import { DELIVERY_REF } from "./delivery_pins.ts";
import {
  asRecord,
  ciJobs,
  jinjaVars,
  loadManifests,
  packageScripts,
  REPO_ROOT,
  read,
  repoCi,
  walkFiles,
} from "./inputs.ts";
import type { Rule } from "./rule_roster.ts";

/** The action directories carrying `file`, as sorted repo-relative paths:
 *  every package under actions/ sits at the action root (the ci.yml
 *  typecheck glob and the root postinstall loop key on that level). */
function actionDirsCarrying(file: string): string[] {
  return readdirSync(join(REPO_ROOT, "actions"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !EXCLUDED_ACTION_DIRS.has(entry.name))
    .map((entry) => `actions/${entry.name}`)
    .filter((dir) => existsSync(join(REPO_ROOT, dir, file)))
    .sort();
}

/** The ci.yml typecheck job's loop: keyed on tsconfig.json so a new
 *  action joins without an edit. */
export const TYPECHECK_TSCONFIG_LOOP = "for tsconfig in tsconfig.json actions/*/tsconfig.json";

export interface BunDirsInputs {
  /** Directories committing a bun.lock, "." for the root. */
  lockDirs: string[];
  /** Directories dependabot's bun ecosystem entries name, "." for the root. */
  dependabotBunDirs: string[];
  /** package.json's typecheck script. */
  typecheckScript: string;
  /** The ci.yml typecheck job's run blocks, joined. */
  typecheckRuns: string;
  /** Directories carrying a tsconfig.json, "." for the root. */
  tsconfigDirs: string[];
}

/** Every directory committing a bun.lock is under dependabot, in the local
 *  typecheck script, and carries the tsconfig.json the CI loop keys on. */
export function bunDirsMismatches(inputs: BunDirsInputs): Mismatch[] {
  const mismatches: Mismatch[] = [];
  for (const dir of inputs.lockDirs) {
    if (!inputs.dependabotBunDirs.includes(dir)) {
      mismatches.push({
        file: ".github/dependabot.yml",
        expected: `a bun ecosystem entry for ${dir} (it commits bun.lock)`,
        got: "no entry",
      });
    }
  }
  for (const dir of inputs.lockDirs.filter((d) => d !== ".")) {
    if (!inputs.typecheckScript.includes(`cd ${dir}`)) {
      mismatches.push({
        file: "package.json",
        expected: `typecheck to cover ${dir}`,
        got: "not in the typecheck script",
      });
    }
  }
  if (!inputs.typecheckRuns.includes(TYPECHECK_TSCONFIG_LOOP)) {
    mismatches.push({
      file: "ci.yml typecheck",
      expected: `a glob loop ${TYPECHECK_TSCONFIG_LOOP}`,
      got: "no such loop",
    });
  }
  for (const dir of inputs.lockDirs) {
    if (!inputs.tsconfigDirs.includes(dir)) {
      mismatches.push({
        file: `${dir}/tsconfig.json`,
        expected: "present (the ci.yml typecheck glob keys on it)",
        got: "missing",
      });
    }
  }
  return mismatches;
}

/** MAJOR.MINOR of a plain version or a single caret/tilde range - the only
 *  grammars the coupled manifests use. Anything else (compound ranges,
 *  prerelease tags, trailing junk) throws rather than reading a prefix: a
 *  half-parsed range passing vacuously is exactly the silent drift the
 *  rule exists to stop. */
export function majorMinor(version: string, where: string): [number, number] {
  const match = /^[\^~]?(\d+)\.(\d+)(?:\.\d+)?$/.exec(version);
  if (!match) throw new Error(`${where}: cannot read MAJOR.MINOR from '${version}'`);
  return [Number(match[1]), Number(match[2])];
}

/** Mismatches where an installed @types/bun MAJOR.MINOR is AHEAD of the
 *  pinned bun runtime's. One direction on purpose: the two sides have
 *  two updaters that each move only their own (dependabot bumps the types,
 *  refresh-toolchains bumps the runtime pin), so symmetric equality would
 *  make their PRs mutually blocking - each red until the other lands.
 *  Types ahead means typechecking against APIs the pinned runtime does not
 *  have, so that direction holds until the runtime catches up; a runtime
 *  ahead of the types is dependabot's next cycle and passes. */
export function bunTypesAheadMismatches(
  runtimeVersion: string,
  types: { file: string; version: string }[],
): Mismatch[] {
  const [runtimeMajor, runtimeMinor] = majorMinor(runtimeVersion, "bun runtime pin");
  const mismatches: Mismatch[] = [];
  for (const { file, version } of types) {
    const [major, minor] = majorMinor(version, file);
    if (major > runtimeMajor || (major === runtimeMajor && minor > runtimeMinor)) {
      mismatches.push({
        file,
        expected: `@types/bun at MAJOR.MINOR ${runtimeMajor}.${runtimeMinor} or older (templates/bun/module.yml pins the runtime at ${runtimeVersion})`,
        got: `${version} - types ahead of the runtime; bump the toolchain pin first (refresh-toolchains owns it)`,
      });
    }
  }
  return mismatches;
}

/** The resolved @types/bun version a bun.lock INSTALLS: the packages
 *  section's top-level `"@types/bun"` entry, whose first tuple element is
 *  `@types/bun@<version>`. The lock is what typechecking actually runs
 *  against: a caret range in package.json admits a lock resolving a newer
 *  MINOR, so the declared floor alone cannot vouch for the installed version.
 *  mustMatch keeps a lockfile that stops carrying the entry loud; nested
 *  per-package resolutions ("x/@types/bun") are not the version the root
 *  typecheck sees and do not match the anchored key. */
export function lockedTypesBunVersion(lockText: string, where: string): string {
  return mustMatch(
    lockText,
    /^\s*"@types\/bun": \["@types\/bun@([^"]+)",/m,
    where,
    "the resolved @types/bun lock entry",
  )[1];
}

/** package.json scripts pinned to their EXACT command because the command
 *  itself scopes scratch per run (the TMPDIR launcher, branch_tree's
 *  self-cleaning --check); a drift to a bare `bun test` would stay green. */
export const SCRATCH_SCOPED_SCRIPTS: Record<string, string> = {
  test: "bun scripts/run_tests.ts",
  "compose:check": "bun .github/scripts/build-branches/branch_tree.ts --check",
  "docs:check": "bun scripts/docs_check.ts",
};

/** Mismatch per pinned script whose live command differs (a missing script
 *  counts as a difference). */
export function scratchScopedScriptMismatches(
  scripts: Record<string, string>,
  pins: Record<string, string>,
): Mismatch[] {
  return Object.entries(pins).flatMap(([name, command]) =>
    scripts[name] === command
      ? []
      : [
          {
            file: "package.json",
            expected: `${name} script '${command}' (the command scopes its scratch per run)`,
            got: scripts[name] === undefined ? "no such script" : `'${scripts[name]}'`,
          },
        ],
  );
}

/** Mismatch when the LOCAL bun runtime's MAJOR.MINOR differs from the
 *  pinned one - injectable versions so the failing pair is testable
 *  without downgrading the real runtime. Exactly one direction exists:
 *  a local gate run under a runtime the pin does not name proves nothing
 *  about CI's behavior in either direction (semantics moved BOTH ways
 *  across 1.3/1.4 - spawnSync pipe-EOF waits, pipe-buffer sizes). */
export function bunRuntimeMismatches(runtimeVersion: string, pinnedVersion: string): Mismatch[] {
  const [runtimeMajor, runtimeMinor] = majorMinor(runtimeVersion, "the local bun runtime");
  const [pinnedMajor, pinnedMinor] = majorMinor(pinnedVersion, ".bun-version");
  if (runtimeMajor === pinnedMajor && runtimeMinor === pinnedMinor) return [];
  return [
    {
      file: ".bun-version",
      expected: `a local bun runtime at MAJOR.MINOR ${pinnedMajor}.${pinnedMinor} (the pinned toolchain)`,
      got: `local bun ${runtimeMajor}.${runtimeMinor} does not match the pinned ${pinnedMajor}.${pinnedMinor} - bun upgrade / install the pin; local greens under a different runtime are unreliable`,
    },
  ];
}

/** The pinned-toolchain setup actions and the version-file input each must
 *  carry (matched against a trimmed `uses:` line, commented or not). */
export const SETUP_VERSION_FILES: [action: RegExp, input: string][] = [
  [/^-? ?uses: oven-sh\/setup-bun@/, "bun-version-file:"],
  [/^-? ?uses: actions\/setup-node@/, "node-version-file:"],
  [/^-? ?uses: denoland\/setup-deno@/, "deno-version-file:"],
];

/** Whether the workflow step whose `uses:` line sits at `usesAt` carries
 *  `key` as a DIRECT child of its OWN with: block. Structural,
 *  indentation-scoped: the step's keys live two columns inside the `- ` item
 *  start, the scan stops where the step ends, and the key only counts at the
 *  with: block's direct-child level (the first child fixes it), so a nested
 *  mapping or a block scalar body that merely LOOKS like the key is a value,
 *  not an input, and a comment, a neighbouring step's input, or a look-alike
 *  elsewhere never matches. */
export function stepCarriesWithKey(lines: string[], usesAt: number, key: string): boolean {
  const usesLine = lines[usesAt];
  const usesIndent = usesLine.length - usesLine.trimStart().length;
  // `- uses:` starts the item; a bare `uses:` sits under `- name:` two
  // columns in. Either way the step's sibling keys share one column.
  const keyIndent = usesLine.trimStart().startsWith("- ") ? usesIndent + 2 : usesIndent;
  let inWith = false;
  let withChildIndent: number | null = null;
  for (let i = usesAt + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (indent < keyIndent) return false;
    if (indent === keyIndent) {
      if (line.trimStart().startsWith("- ")) return false;
      inWith = line.trim() === "with:";
      withChildIndent = null;
      continue;
    }
    if (!inWith) continue;
    // The first line inside with: is necessarily a direct child (block
    // scalar bodies and nested values always sit deeper than their key).
    if (withChildIndent === null) withChildIndent = indent;
    if (indent !== withChildIndent) continue;
    if (line.trim().startsWith(key)) return true;
  }
  return false;
}

/** Every action manifest under actions/, nested actions included - one
 *  walk shared by the actions-bun-guard rule and its forcing test, so
 *  the two can never judge different rosters; branch_tree.ts's
 *  EXCLUDED_DIRS bounds it to the tree publication ships. */
export function actionManifestFiles(): string[] {
  return walkFiles("actions")
    .map((f) => f.path)
    .filter(
      (path) =>
        path.endsWith("/action.yml") &&
        !path.split("/").some((segment) => EXCLUDED_DIRS.has(segment)),
    );
}

/** The runner scratch root a setup-bun pin may sit under instead of the
 *  action path. */
export const FETCHED_TREE_PIN_ANCHOR = "${{ runner.temp }}/";

/** A clean path under the runner scratch root: every segment drawn from
 *  [A-Za-z0-9._-], not a dot or dot-dot, and not ending in a period (a
 *  traversal would reach the caller's checkout, a `$` would expand in the
 *  shell; Windows strips trailing periods and spaces and reads a backslash
 *  as a separator, so the whitelist is what closes the class, not a list
 *  of spellings). */
function cleanScratchPath(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith(FETCHED_TREE_PIN_ANCHOR)) return false;
  return value
    .slice(FETCHED_TREE_PIN_ANCHOR.length)
    .split("/")
    .every((s) => /^[A-Za-z0-9._-]+$/.test(s) && s !== "." && s !== ".." && !s.endsWith("."));
}

/** A setup-bun pin under the runner scratch root, accepted only as a clean
 *  path to a .bun-version dotfile there. */
export function fetchedTreePin(value: unknown): boolean {
  return cleanScratchPath(value) && value.endsWith("/.bun-version");
}

/** Whether `condition` is a pure `&&`-conjunction carrying `atom` as one of
 *  its terms; any `||`, negation, or parenthesis anywhere means the setup
 *  may run without that term, so the answer is no. */
function conjunctionRequires(condition: string, atom: string): boolean {
  if (/\|\||[()]|!(?!=)/.test(condition)) return false;
  return condition
    .split("&&")
    .map((term) => term.trim())
    .includes(atom);
}

/** Inherited shell variables that could skip or rewrite a bash step's lines
 *  before they run; a clearing step must carry each one emptied. */
export const NEUTRALIZED_SHELL_ENV = ["BASH_ENV", "SHELLOPTS"];

/** The paths a bash step removes beyond a caller's reach: the shell knobs
 *  above emptied, and ONE non-blank non-comment line `/bin/rm -rf "<clean
 *  scratch path>" ...` (no rm from PATH, no operand the shell could expand
 *  or a caller could point elsewhere); else nothing. One rm for every path
 *  is what fails closed: it attempts each removal and exits nonzero when
 *  any failed, whatever the shell's options, where a line per path stops
 *  at the first failure or masks it behind the last. */
function pathsClearedBy(step: Record<string, unknown>): string[] {
  const stepEnv =
    typeof step.env === "object" && step.env !== null ? (step.env as Record<string, unknown>) : {};
  const neutralized = NEUTRALIZED_SHELL_ENV.every((name) => stepEnv[name] === "");
  if (step.shell !== "bash" || !neutralized || typeof step.run !== "string") return [];
  const lines = step.run.split("\n").filter((line) => line.trim() !== "" && !/^\s*#/.test(line));
  if (lines.length !== 1) return [];
  // Operands are space-separated: bash joins adjacent quoted strings into
  // one word.
  const removed = /^\s*\/bin\/rm -rf (?:-- )?("[^"]+"(?: "[^"]+")*)\s*$/.exec(lines[0]);
  if (removed === null) return [];
  const operands = removed[1].match(/"([^"]+)"/g)?.map((quoted) => quoted.slice(1, -1)) ?? [];
  return operands.every(cleanScratchPath) ? operands : [];
}

/** Clearing evidence for a runner-scratch pin: a step before `index` that
 *  removes a path the pin sits under (any prefix of a clean pin is clean)
 *  and whose success the setup step's own condition requires. */
export function pinRootCleared(
  pin: string,
  steps: Record<string, unknown>[],
  index: number,
): boolean {
  const setupIf = String(steps[index]?.if ?? "");
  return steps
    .slice(0, index)
    .some(
      (step) =>
        conjunctionRequires(setupIf, `steps.${String(step.id)}.outcome == 'success'`) &&
        pathsClearedBy(step).some((root) => pin.startsWith(`${root}/`)),
    );
}

/** The action-local pin a composite action's bun setup reads: the generated
 *  .bun-version beside its action.yml. */
export const ACTION_BUN_PIN = "${{ github.action_path }}/.bun-version";

/** The step id every later step binds ACTION_BUN to. */
export const RESOLVER_STEP_ID = "action-bun";

/** The one spelling of the shared bun-setup step's `uses:`: this repository's
 *  published action at the delivery ref. */
export const BUN_SETUP_USES = `Vivswan/repo-platform/${BUN_SETUP_ACTION}@${DELIVERY_REF}`;

const stepName = (step: Record<string, unknown>): string =>
  String(step.name ?? step.id ?? step.uses ?? "<unnamed>");

/** Whether a step mentions bun in its run or env. */
function mentionsBun(step: Record<string, unknown>): boolean {
  return /bun/i.test(JSON.stringify([step.run ?? "", step.env ?? {}]));
}

/** Whether a step uses any action or mentions bun. */
function touchesBun(step: Record<string, unknown>): boolean {
  return typeof step.uses === "string" || mentionsBun(step);
}

/** Why `steps` lack exactly one bun setup (the `action-bun` step: the shared
 *  action with the action-local pin) ahead of every other action-using or
 *  bun-touching step, or null. Every step naming the shared action counts. */
export function bunSetupShapeProblem(steps: Record<string, unknown>[]): string | null {
  const shared = steps.filter(usesBunSetup);
  if (shared.length > 1) return `${shared.length} shared bun-setup steps`;
  const resolvers = steps.filter((step) => step.id === RESOLVER_STEP_ID);
  if (resolvers.length !== 1) return `${resolvers.length} steps with id '${RESOLVER_STEP_ID}'`;
  if (shared.length === 0)
    return `the '${RESOLVER_STEP_ID}' step is not the shared bun-setup action`;
  const problems: string[] = [];
  if (shared[0] !== resolvers[0]) {
    problems.push(`the shared bun-setup step has id '${String(shared[0].id)}'`);
  }
  if (shared[0].uses !== BUN_SETUP_USES) problems.push(`uses '${String(shared[0].uses)}'`);
  const pin = (shared[0].with as Record<string, unknown> | undefined)?.pin;
  if (pin !== ACTION_BUN_PIN) problems.push(`pin '${String(pin)}'`);
  const first = steps.findIndex(touchesBun);
  if (first !== steps.indexOf(shared[0])) {
    problems.push(`step '${stepName(steps[first])}' uses an action or touches bun before it`);
  }
  return problems.length === 0 ? null : problems.join(", ");
}

/** Whether a step sets a `path` output: the shared bun-setup action, or a
 *  run step echoing `path=...` into GITHUB_OUTPUT. */
function emitsPath(step: Record<string, unknown>): boolean {
  return (
    usesBunSetup(step) ||
    (typeof step.run === "string" && /echo "path=[^\n]*>> "\$GITHUB_OUTPUT"/.test(step.run))
  );
}

/** How one action.yml violates the pinned-bun contract: one bun setup
 *  (bunSetupShapeProblem), no dangling `steps.<id>.outputs.path`, every
 *  setup-bun step reading its pin, no step running `bun` by name. */
export function actionsBunGuardMismatches(file: string, text: string): Mismatch[] {
  const steps = actionSteps(text);
  // A run line starting with "bun " counts, block scalars included; a
  // prose line shaped that way would over-demand the guard, which fails
  // closed.
  const bareBunLines = steps.flatMap((step) =>
    typeof step.run === "string"
      ? step.run
          .split("\n")
          .filter((line) => line.trimStart().startsWith("bun "))
          .map((line) => ({ step: stepName(step), line: line.trim() }))
      : [],
  );
  const setupSteps = steps.filter(usesSetupBun);
  const pathRefs = [
    ...new Set([...text.matchAll(/steps\.([A-Za-z0-9_-]+)\.outputs\.path/g)].map((m) => m[1])),
  ];
  if (
    bareBunLines.length === 0 &&
    setupSteps.length === 0 &&
    !steps.some(usesBunSetup) &&
    !steps.some(mentionsBun) &&
    !steps.some((step) => step.id === RESOLVER_STEP_ID) &&
    !pathRefs.includes(RESOLVER_STEP_ID)
  ) {
    return [];
  }
  const mismatches: Mismatch[] = [];
  const isSharedSetup = file === `${BUN_SETUP_ACTION}/action.yml`;
  const shape = isSharedSetup ? null : bunSetupShapeProblem(steps);
  if (shape !== null) {
    mismatches.push({
      file,
      expected:
        `exactly one bun setup step with id '${RESOLVER_STEP_ID}' ('uses: ${BUN_SETUP_USES}' with ` +
        `'pin: ${ACTION_BUN_PIN}'), ahead of any other step that uses an action or touches bun`,
      got: `${shape} - the setup is what pins the bun to this action's own .bun-version, never the CALLER repository's`,
    });
  }
  for (const id of pathRefs) {
    const target = steps.find((step) => step.id === id);
    if (target !== undefined && emitsPath(target)) continue;
    const reason =
      target === undefined ? `no step with id '${id}'` : `step '${id}' sets no path output`;
    mismatches.push({
      file,
      expected: `steps.${id}.outputs.path naming a step of this action that sets a path output (the bun setup, or a run step writing path= to GITHUB_OUTPUT)`,
      got: `${reason} - the reference is empty at run time and the step it binds runs nothing`,
    });
  }
  for (const { step, line } of bareBunLines) {
    mismatches.push({
      file,
      expected: `step '${step}' running bun by the recorded absolute path ("$ACTION_BUN" ..., bound in env to steps.${RESOLVER_STEP_ID}.outputs.path), never \`bun\` by name`,
      got: line,
    });
  }
  // The one other pin anchor: a tree the action fetched under the runner's
  // scratch root is no more the caller's than the action path is.
  const pinValue = isSharedSetup ? "${{ inputs.pin }}" : ACTION_BUN_PIN;
  const pinLine = `bun-version-file: ${pinValue}`;
  for (const step of setupSteps) {
    const withBlock = step.with;
    const value =
      typeof withBlock === "object" && withBlock !== null
        ? (withBlock as Record<string, unknown>)["bun-version-file"]
        : undefined;
    if (value === pinValue) continue;
    if (fetchedTreePin(value)) {
      // The scratch path is predictable, so a caller could plant the pin
      // before the action runs; only an earlier step of THIS action
      // clearing the pin's root makes the path the action's own.
      if (pinRootCleared(value as string, steps, steps.indexOf(step))) continue;
      mismatches.push({
        file,
        expected:
          `a step before the setup-bun pinned at '${value}' that clears that pin's runner-scratch root ` +
          "(a bash step with BASH_ENV and SHELLOPTS emptied whose whole run block is one /bin/rm -rf " +
          "of clean paths under that root, and whose success this setup's condition requires)",
        got: "no such step - a caller could plant that pin before the action runs",
      });
      continue;
    }
    mismatches.push({
      file,
      expected: `every setup-bun step carrying '${pinLine}' (or a clean .bun-version path under '${FETCHED_TREE_PIN_ANCHOR}', a tree the action fetched itself) in its with: block`,
      got: "a setup-bun step pinned neither to the action-local dotfile nor to a clean path under the runner scratch root - anything else can resolve the CALLER repository's bun version files",
    });
  }
  return mismatches;
}

/** files.yml's `modules.<m>.pin` against the manifests' toolchain pins,
 *  both directions: the manifest is the source until the cutover and the
 *  refresh bumps both, so a pin present, absent, or different on one side
 *  is a stale copy the fleet would read. */
export function filesPinMismatches(
  manifestPins: { module: string; file: string; version: string }[],
  filesModules: Record<string, Record<string, unknown>>,
): Mismatch[] {
  const mismatches: Mismatch[] = [];
  for (const pin of manifestPins) {
    const declared = filesModules[pin.module]?.pin;
    const expected = { file: pin.file, version: pin.version };
    if (canonical(declared) !== canonical(expected)) {
      mismatches.push({
        file: `files.yml modules.${pin.module}.pin`,
        expected: `${canonical(expected)} (templates/${pin.module}/module.yml's toolchain.pin)`,
        got: declared === undefined ? "no pin" : canonical(declared),
      });
    }
  }
  const pinned = new Set(manifestPins.map((pin) => pin.module));
  for (const [module, data] of Object.entries(filesModules)) {
    if (data.pin !== undefined && !pinned.has(module)) {
      mismatches.push({
        file: `files.yml modules.${module}.pin`,
        expected: `no pin (templates/${module}/module.yml declares no toolchain.pin)`,
        got: canonical(data.pin),
      });
    }
  }
  return mismatches;
}

/** The rules this module contributes to the checker's run (check_ssot.ts). */
export const toolchainRules: Rule[] = [
  {
    name: "files-pins",
    run: () =>
      filesPinMismatches(
        loadManifests().flatMap((m) =>
          m.toolchain?.pin ? [{ module: m.module, ...m.toolchain.pin }] : [],
        ),
        parseFilesConfig(read("files.yml")).modules,
      ),
  },
  {
    // Lockfiles come from the bootstrap's recursive walk, the other homes
    // from one level down: a package nested inside an action fails here.
    name: "bun-dirs",
    run: () => {
      const dependabot = asRecord(parseYaml(read(".github/dependabot.yml")), "dependabot.yml");
      const typecheckJob = asRecord(ciJobs(repoCi(), "ci.yml").typecheck, "typecheck job");
      const scripts = packageScripts();
      return [
        ...bunDirsMismatches({
          lockDirs: bunLockDirs(REPO_ROOT),
          dependabotBunDirs: (dependabot.updates as Record<string, unknown>[])
            .filter((entry) => entry["package-ecosystem"] === "bun")
            .map((entry) => String(entry.directory).replace(/^\//, "") || "."),
          typecheckScript: scripts.typecheck ?? "",
          typecheckRuns: (typecheckJob.steps as Record<string, unknown>[])
            .map((step) => String(step.run ?? ""))
            .join("\n"),
          tsconfigDirs: [
            ...(existsSync(join(REPO_ROOT, "tsconfig.json")) ? ["."] : []),
            ...actionDirsCarrying("tsconfig.json"),
          ],
        }),
        ...scratchScopedScriptMismatches(scripts, SCRATCH_SCOPED_SCRIPTS),
      ];
    },
  },
  {
    // The INSTALLED @types/bun (each lockfile's resolved entry, root plus the
    // actions/ packages declaring it, the bun-dirs directories) against the
    // manifests' bun runtime pin, ahead-direction only
    // (bunTypesAheadMismatches says why). The lock is the compared side on
    // purpose: package.json's caret range is only a floor, so a lock resolving
    // a newer MINOR while the range stays put would typecheck against APIs the
    // pinned runtime lacks and previously passed here. The runtime side reads
    // the manifest itself, the single source the .bun-version dotfiles come from.
    name: "bun-types-pin",
    run: () => {
      const bun = loadManifests().find((m) => m.module === "bun");
      if (bun?.toolchain?.pin === undefined) {
        throw new Error("templates/bun/module.yml declares no toolchain.pin - anchor lost");
      }
      const types: { file: string; version: string }[] = [];
      for (const dir of [".", ...actionDirsCarrying("package.json")]) {
        const pkgRel = dir === "." ? "package.json" : `${dir}/package.json`;
        const pkg = asRecord(JSON.parse(read(pkgRel)), pkgRel);
        const declares = ["dependencies", "devDependencies"].some(
          (key) => (pkg[key] as Record<string, unknown> | undefined)?.["@types/bun"] !== undefined,
        );
        if (!declares) continue;
        const lockRel = dir === "." ? "bun.lock" : `${dir}/bun.lock`;
        if (!existsSync(join(REPO_ROOT, lockRel))) {
          throw new Error(`${pkgRel} declares @types/bun but ${lockRel} is missing - anchor lost`);
        }
        types.push({ file: lockRel, version: lockedTypesBunVersion(read(lockRel), lockRel) });
      }
      if (types.length === 0) {
        throw new Error("no package.json declares @types/bun - anchor lost");
      }
      return bunTypesAheadMismatches(bun.toolchain.pin.version, types);
    },
  },
  {
    // Every pinned-toolchain setup step must read its version dotfile: the
    // manifest pin and the generated dotfile only govern anything while the
    // workflows actually pass the version-file input. Real steps are matched
    // structurally (the key inside that step's own with: block); commented
    // starter examples are checked as comment text and can never satisfy the
    // per-action anchors. actions/ is out of scope but not unpinned: each
    // composite action reads its own generated .bun-version (the actions-bun-guard
    // rule pins that, action_path-anchored so the CALLER's dotfiles never pick the version).
    name: "toolchain-version-files",
    run: () => {
      const mismatches: Mismatch[] = [];
      const files = [
        ...walkFiles(".github/workflows").map((f) => f.path),
        ...walkFiles("templates")
          .filter((f) => !f.symlink)
          .map((f) => f.path),
      ];
      const seen = new Set<string>();
      for (const rel of files) {
        const lines = read(rel).split("\n");
        for (const [index, line] of lines.entries()) {
          for (const [action, input] of SETUP_VERSION_FILES) {
            const trimmed = line.trim();
            if (trimmed.startsWith("#")) {
              // Commented starter example: the commented step must carry
              // its commented input nearby (text match suffices there).
              if (
                action.test(trimmed.replace(/^#\s*/, "")) &&
                !lines
                  .slice(index + 1, index + 6)
                  .some((next) => next.trim().startsWith("#") && next.includes(input))
              ) {
                mismatches.push({
                  file: `${rel}:${index + 1}`,
                  expected: `a commented '${input} ...' input beside the commented example step`,
                  got: "an example step floating on the action's default version",
                });
              }
              continue;
            }
            if (!action.test(trimmed)) continue;
            seen.add(input);
            if (!stepCarriesWithKey(lines, index, input)) {
              mismatches.push({
                file: `${rel}:${index + 1}`,
                expected: `a '${input} ...' input in the setup step's own with: block`,
                got: "a setup step floating on the action's default version",
              });
            }
          }
        }
      }
      for (const [, input] of SETUP_VERSION_FILES) {
        if (!seen.has(input)) {
          throw new Error(
            `no uncommented setup step for the ${input} toolchain found anywhere - anchor lost`,
          );
        }
      }
      return mismatches;
    },
  },
  {
    name: "dependabot-actions-block",
    run: () => {
      // The repo entry covers "/" plus its composite actions/ dirs (which
      // downstream repos do not have), so compare the shared shape with the
      // directory coverage held out, and pin each side's coverage of "/".
      // groups IS compared: one-PR-per-cycle grouping is shared policy.
      const rootActionsEntry = (rel: string, text: string, wantDirs: (d: unknown) => boolean) => {
        const doc = asRecord(parseYaml(text), rel);
        const entries = (doc.updates as Record<string, unknown>[]).filter(
          (entry) => entry["package-ecosystem"] === "github-actions",
        );
        if (entries.length !== 1)
          throw new Error(`${rel}: expected exactly one github-actions dependabot entry`);
        const { directory, directories, ...shape } = entries[0];
        if (!wantDirs(directory ?? directories))
          throw new Error(`${rel}: github-actions entry does not cover "/"`);
        return shape;
      };
      const expected = rootActionsEntry(
        "templates/base/.github/dependabot.yml.jinja",
        normalizeJinja(read("templates/base/.github/dependabot.yml.jinja"), jinjaVars()),
        (d) => d === "/",
      );
      const got = rootActionsEntry(
        ".github/dependabot.yml",
        read(".github/dependabot.yml"),
        (d) => d === "/" || (Array.isArray(d) && d.includes("/")),
      );
      if (canonical(expected) === canonical(got)) return [];
      return [
        { file: ".github/dependabot.yml", expected: canonical(expected), got: canonical(got) },
      ];
    },
  },
  {
    // Every composite-action package must sit in the github-actions
    // block's directories list, or its upstream pins quietly stop
    // receiving dependabot bumps. Nothing else guards the list: the
    // dogfood comparison above deliberately holds directories out
    // (downstream repos have no actions/ dirs).
    name: "dependabot-action-dirs",
    run: () => {
      const mismatches: Mismatch[] = [];
      // Only action.yml-bearing directories carry upstream `uses:` pins to
      // bump; actions/shared/ is the dependency-free library zone with
      // nothing for dependabot to see.
      const dirs = readdirSync(join(REPO_ROOT, "actions")).filter(
        (name) =>
          lstatSync(join(REPO_ROOT, "actions", name)).isDirectory() &&
          existsSync(join(REPO_ROOT, "actions", name, "action.yml")),
      );
      const doc = asRecord(parseYaml(read(".github/dependabot.yml")), "dependabot.yml");
      const updates = (doc.updates as Record<string, unknown>[] | undefined) ?? [];
      const block = updates.find((entry) => entry["package-ecosystem"] === "github-actions");
      if (!block) throw new Error("dependabot.yml: no github-actions block - anchor lost");
      const covered = new Set(((block.directories as unknown[] | undefined) ?? []).map(String));
      for (const dir of dirs) {
        if (!covered.has(`/actions/${dir}`)) {
          mismatches.push({
            file: ".github/dependabot.yml",
            expected: `"/actions/${dir}" in the github-actions directories list`,
            got: "missing - the package's upstream pins receive no dependabot bumps",
          });
        }
      }
      return mismatches;
    },
  },
  {
    // Every bun-touching composite action carries exactly one bun setup
    // reading its own generated .bun-version, never the CALLER checkout's
    // (whose older bun cannot parse the lockfiles repo-platform's writes).
    name: "actions-bun-guard",
    run: () => {
      const files = actionManifestFiles();
      const guarded = files.filter((file) => actionSetsUpBun(read(file)));
      if (guarded.length === 0) {
        throw new Error("no actions/**/action.yml sets up bun - anchor lost");
      }
      return files.flatMap((file) => actionsBunGuardMismatches(file, read(file)));
    },
  },
  {
    // The LOCAL bun runtime must be the pinned MAJOR.MINOR (.bun-version,
    // the dogfooded templates/bun pin): a full local `bun run check` under
    // a different runtime is unreliable evidence - it once passed clean
    // under 1.3.14 while CI's 1.4.0 went red on the same commit. In CI
    // this rule can never fire (setup-bun installs from bun-version-file),
    // so it exists exclusively as a local-gate guard.
    name: "local-bun-runtime",
    run: () => bunRuntimeMismatches(Bun.version, read(".bun-version").trim()),
  },
];
