import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { EXCLUDED_DIRS as EXCLUDED_ACTION_DIRS } from "../../../.github/scripts/build-branches/branch_tree.ts";
import { PLATFORM_SLUG } from "../../../actions/shared/platform.ts";
import { bunLockDirs } from "../../bootstrap.ts";
import {
  actionSetsUpBun,
  actionSteps,
  BUN_SETUP_ACTION,
  usesBunSetup,
  usesSetupBun,
} from "../../lib/action_steps.ts";
import { type Mismatch, mustMatch } from "./comparison.ts";
import { actionManifestFiles, DELIVERY_REF } from "./delivery_pins.ts";
import {
  asRecord,
  ciJobs,
  modules,
  packageScripts,
  REPO_ROOT,
  read,
  repoCi,
  walkFiles,
} from "./inputs.ts";
import type { Rule } from "./rule_roster.ts";

/** Every package under actions/ sits at the action root: the ci.yml typecheck glob and the root postinstall loop key on that level. */
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
  lockDirs: string[];
  typecheckScript: string;
  typecheckRuns: string;
  tsconfigDirs: string[];
}

export function bunDirsMismatches(inputs: BunDirsInputs): Mismatch[] {
  const mismatches: Mismatch[] = [];
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

/** Anything beyond a plain version or a single caret/tilde range throws rather than reading a prefix:
 *  a half-parsed range passing vacuously is the silent drift the rule exists to stop. */
export function majorMinor(version: string, where: string): [number, number] {
  const match = /^[\^~]?(\d+)\.(\d+)(?:\.\d+)?$/.exec(version);
  if (!match) throw new Error(`${where}: cannot read MAJOR.MINOR from '${version}'`);
  return [Number(match[1]), Number(match[2])];
}

/** One direction on purpose: dependabot bumps the types and refresh-toolchains bumps the runtime pin,
 *  so symmetric equality would make their PRs mutually blocking.
 *  Types ahead means typechecking against APIs the pinned runtime lacks; a runtime ahead of the types is dependabot's next cycle and passes. */
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
        expected: `@types/bun at MAJOR.MINOR ${runtimeMajor}.${runtimeMinor} or older (files.yml pins the bun runtime at ${runtimeVersion})`,
        got: `${version} - types ahead of the runtime; bump the toolchain pin first (refresh-toolchains owns it)`,
      });
    }
  }
  return mismatches;
}

/** Nested per-package resolutions (`"x/@types/bun"`) are not the version the root typecheck sees, so the key is anchored to the top-level entry. */
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
  "build:check": "bun .github/scripts/build-branches/branch_tree.ts --check",
  "docs:check": "bun scripts/docs_check.ts",
};

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

/** MAJOR.MINOR equality, not a direction: a local run under a runtime the pin does not name proves nothing about CI either way
 *  (semantics moved both ways across 1.3/1.4: spawnSync pipe-EOF waits, pipe-buffer sizes).
 *  The versions are injected so the failing pair is testable without downgrading the real runtime. */
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

export const SETUP_VERSION_FILES: [action: RegExp, input: string][] = [
  [/^-? ?uses: oven-sh\/setup-bun@/, "bun-version-file:"],
  [/^-? ?uses: denoland\/setup-deno@/, "deno-version-file:"],
];

/** Indentation-scoped rather than a text search: a nested mapping or a block scalar body that merely looks like the key
 *  is a value, not an input, and a neighbouring step's input never matches. */
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

export const ACTION_BUN_PIN = "${{ github.action_path }}/.bun-version";

export const RESOLVER_STEP_ID = "action-bun";

export const BUN_SETUP_USES = `${PLATFORM_SLUG}/${BUN_SETUP_ACTION}@${DELIVERY_REF}`;

const stepName = (step: Record<string, unknown>): string =>
  String(step.name ?? step.id ?? step.uses ?? "<unnamed>");

function mentionsBun(step: Record<string, unknown>): boolean {
  return /bun/i.test(JSON.stringify([step.run ?? "", step.env ?? {}]));
}

function touchesBun(step: Record<string, unknown>): boolean {
  return typeof step.uses === "string" || mentionsBun(step);
}

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

function emitsPath(step: Record<string, unknown>): boolean {
  return (
    usesBunSetup(step) ||
    (typeof step.run === "string" && /echo "path=[^\n]*>> "\$GITHUB_OUTPUT"/.test(step.run))
  );
}

export function actionsBunGuardMismatches(file: string, text: string): Mismatch[] {
  const steps = actionSteps(text);
  // A prose line in a run block shaped `bun ...` over-demands the guard; that direction fails closed.
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
  const pinValue = isSharedSetup ? "${{ inputs.pin }}" : ACTION_BUN_PIN;
  const pinLine = `bun-version-file: ${pinValue}`;
  for (const step of setupSteps) {
    const withBlock = step.with;
    const value =
      typeof withBlock === "object" && withBlock !== null
        ? (withBlock as Record<string, unknown>)["bun-version-file"]
        : undefined;
    if (value === pinValue) continue;
    mismatches.push({
      file,
      expected: `every setup-bun step carrying '${pinLine}' in its with: block`,
      got: "a setup-bun step pinned to something other than the action-local dotfile - anything else can resolve the CALLER repository's bun version files",
    });
  }
  return mismatches;
}

/** The single source every .bun-version dotfile is written from (bun run pins). */
export function bunRuntimePin(): string {
  const pin = modules().find((m) => m.name === "bun")?.pin;
  if (pin === undefined) throw new Error("files.yml modules.bun declares no pin - anchor lost");
  return pin.version;
}

export const toolchainRules: Rule[] = [
  {
    // Lockfiles come from the bootstrap's recursive walk, the other homes
    // from one level down: a package nested inside an action fails here.
    name: "bun-dirs",
    run: () => {
      const typecheckJob = asRecord(ciJobs(repoCi(), "ci.yml").typecheck, "typecheck job");
      const scripts = packageScripts();
      return [
        ...bunDirsMismatches({
          lockDirs: bunLockDirs(REPO_ROOT),
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
    // The lock is the compared side on purpose: package.json's caret range is only a floor,
    // so a lock resolving a newer MINOR while the range stays put would typecheck against APIs the pinned runtime lacks.
    name: "bun-types-pin",
    run: () => {
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
      return bunTypesAheadMismatches(bunRuntimePin(), types);
    },
  },
  {
    // The pin dotfiles govern nothing unless the workflows pass the version-file input.
    // actions/ is out of scope but not unpinned: each bun-using composite action reads its own .bun-version
    // (the actions-bun-guard rule pins that; the shared bun-setup action takes the pin as an input instead).
    name: "toolchain-version-files",
    run: () => {
      const mismatches: Mismatch[] = [];
      const files = [
        ...walkFiles(".github/workflows").map((f) => f.path),
        ...walkFiles("files")
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
    // The CALLER checkout's bun may be older than the lockfiles the platform writes and unable to parse them,
    // so each bun-using action pins its own (the shared bun-setup action excepted: it takes the pin as an input).
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
    // A full local `bun run check` once passed clean under 1.3.14 while CI's 1.4.0 went red on the same commit.
    // In CI this rule can never fire (setup-bun installs from bun-version-file); it is a local-gate guard.
    name: "local-bun-runtime",
    run: () => bunRuntimeMismatches(Bun.version, read(".bun-version").trim()),
  },
];
