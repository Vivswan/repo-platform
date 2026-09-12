import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Mismatch } from "../../../scripts/check/ssot/comparison.ts";
import { actionManifestFiles } from "../../../scripts/check/ssot/delivery_pins.ts";
import {
  ACTION_BUN_PIN,
  actionsBunGuardMismatches,
  BUN_SETUP_USES,
  type BunDirsInputs,
  bunDirsMismatches,
  bunRuntimeMismatches,
  bunTypesAheadMismatches,
  lockedTypesBunVersion,
  majorMinor,
  SCRATCH_SCOPED_SCRIPTS,
  SETUP_VERSION_FILES,
  scratchScopedScriptMismatches,
  stepCarriesWithKey,
  TYPECHECK_TSCONFIG_LOOP,
} from "../../../scripts/check/ssot/toolchain.ts";
import { actionSetsUpBun } from "../../../scripts/lib/action_steps.ts";

describe("stepCarriesWithKey", () => {
  const key = "bun-version-file:";
  const lines = (text: string) => text.split("\n");

  test("finds the key inside the step's own with: block (item and named shapes)", () => {
    const item = lines(
      [
        "      - uses: oven-sh/setup-bun@v2",
        "        with:",
        "          bun-version-file: .bun-version",
      ].join("\n"),
    );
    expect(stepCarriesWithKey(item, 0, key)).toBe(true);
    const named = lines(
      [
        "      - name: Set up bun",
        "        uses: oven-sh/setup-bun@v2",
        "        with:",
        "          bun-version-file: .bun-version",
      ].join("\n"),
    );
    expect(stepCarriesWithKey(named, 1, key)).toBe(true);
  });

  test("the NEXT step's input never satisfies the check", () => {
    const twoSteps = lines(
      [
        "      - uses: oven-sh/setup-bun@v2",
        "      - uses: actions/cache@v6",
        "        with:",
        "          bun-version-file: .bun-version",
      ].join("\n"),
    );
    expect(stepCarriesWithKey(twoSteps, 0, key)).toBe(false);
  });

  test("a comment mentioning the key never satisfies the check", () => {
    const commented = lines(
      [
        "      - uses: oven-sh/setup-bun@v2",
        "        # bun-version-file: .bun-version",
        "      - run: bun install",
      ].join("\n"),
    );
    expect(stepCarriesWithKey(commented, 0, key)).toBe(false);
  });

  test("the key must sit under with:, not as a stray step key", () => {
    const noWith = lines(
      ["      - uses: oven-sh/setup-bun@v2", "        bun-version-file: .bun-version"].join("\n"),
    );
    expect(stepCarriesWithKey(noWith, 0, key)).toBe(false);
  });

  test("a direct child at the with: block's exact level matches", () => {
    const direct = lines(
      [
        "      - uses: oven-sh/setup-bun@v2",
        "        with:",
        "          no-cache: true",
        "          bun-version-file: .bun-version",
      ].join("\n"),
    );
    expect(stepCarriesWithKey(direct, 0, key)).toBe(true);
  });

  test("a key-shaped line inside a block scalar body never matches", () => {
    const scalar = lines(
      [
        "      - uses: denoland/setup-deno@v2",
        "        with:",
        "          cache-dependency-path: |",
        "            deno-version-file: .dvmrc",
      ].join("\n"),
    );
    expect(stepCarriesWithKey(scalar, 0, "deno-version-file:")).toBe(false);
  });

  test("a key nested deeper than the direct-child level never matches", () => {
    const nested = lines(
      [
        "      - uses: denoland/setup-deno@v2",
        "        with:",
        "          something:",
        "            deno-version-file: .dvmrc",
      ].join("\n"),
    );
    expect(stepCarriesWithKey(nested, 0, "deno-version-file:")).toBe(false);
  });

  test("a with: block ended by a later step key stops matching", () => {
    const after = lines(
      [
        "      - uses: oven-sh/setup-bun@v2",
        "        with:",
        "          no-cache: true",
        "        env:",
        "          bun-version-file: .bun-version",
      ].join("\n"),
    );
    expect(stepCarriesWithKey(after, 0, key)).toBe(false);
  });

  test("SETUP_VERSION_FILES matches uses lines commented or not, item or named", () => {
    const [bun] = SETUP_VERSION_FILES[0];
    expect(bun.test("- uses: oven-sh/setup-bun@v2")).toBe(true);
    expect(bun.test("uses: oven-sh/setup-bun@v2")).toBe(true);
    expect(bun.test("# - uses: oven-sh/setup-bun@v2".replace(/^#\s*/, ""))).toBe(true);
    expect(bun.test("echo oven-sh/setup-bun@v2")).toBe(false);
  });
});

describe("actionsBunGuardMismatches", () => {
  const FILE = "actions/x/action.yml";
  const SETUP_STEP = `    - name: Set up the action's bun
      id: action-bun
      uses: ${BUN_SETUP_USES}
      with:
        pin: \${{ github.action_path }}/.bun-version
`;
  const RUN_STEP = `    - name: Run
      shell: bash
      env:
        ACTION_BUN: \${{ steps.action-bun.outputs.path }}
      run: '"$ACTION_BUN" "\${{ github.action_path }}/x.ts"'
`;
  const canonical = `runs:
  using: composite
  steps:
${SETUP_STEP}
${RUN_STEP}`;

  test("the shared bun-setup step plus a step running the recorded bun passes", () => {
    expect(actionsBunGuardMismatches(FILE, canonical)).toEqual([]);
  });

  // The rule's fixed-message mismatches, built from the same constants the
  // rule reads, so the expectations below can never demand different bytes
  // from the judgment.
  const shapeMismatch = (got: string) => ({
    file: FILE,
    expected:
      `exactly one bun setup step with id 'action-bun' ('uses: ${BUN_SETUP_USES}' with ` +
      `'pin: ${ACTION_BUN_PIN}'), ahead of any other step that uses an action or touches bun`,
    got: `${got} - the setup is what pins the bun to this action's own .bun-version, never the CALLER repository's`,
  });
  const danglingMismatch = (id: string, got = `no step with id '${id}'`) => ({
    file: FILE,
    expected: `steps.${id}.outputs.path naming a step of this action that sets a path output (the bun setup, or a run step writing path= to GITHUB_OUTPUT)`,
    got: `${got} - the reference is empty at run time and the step it binds runs nothing`,
  });
  const perStepMismatch = {
    file: FILE,
    expected: `every setup-bun step carrying 'bun-version-file: ${ACTION_BUN_PIN}' in its with: block`,
    got: "a setup-bun step pinned to something other than the action-local dotfile - anything else can resolve the CALLER repository's bun version files",
  };
  const bareBunMismatch = (line: string, step = "Run") => ({
    file: FILE,
    expected: `step '${step}' running bun by the recorded absolute path ("$ACTION_BUN" ..., bound in env to steps.action-bun.outputs.path), never \`bun\` by name`,
    got: line,
  });

  test.each<{ reason: string; text: string; expected: ReturnType<typeof shapeMismatch>[] }>([
    {
      reason: "no setup at all while a step binds the recorded path",
      text: canonical.replace(`${SETUP_STEP}\n`, ""),
      expected: [shapeMismatch("0 steps with id 'action-bun'"), danglingMismatch("action-bun")],
    },
    {
      reason: "a second copy of the step",
      text: canonical.replace(SETUP_STEP, `${SETUP_STEP}${SETUP_STEP}`),
      expected: [shapeMismatch("2 shared bun-setup steps")],
    },
    {
      reason: "an inline resolver (the pre-adoption shape)",
      text: canonical.replace(
        SETUP_STEP,
        `    - uses: oven-sh/setup-bun@v2\n      with:\n        bun-version-file: \${{ github.action_path }}/.bun-version\n    - id: action-bun\n      shell: bash\n      run: echo "path=$(command -v bun)" >> "$GITHUB_OUTPUT"\n`,
      ),
      expected: [shapeMismatch("the 'action-bun' step is not the shared bun-setup action")],
    },
    {
      reason: "a second shared step under another id, the recorded path bound to it",
      text: canonical
        .replace(SETUP_STEP, `${SETUP_STEP}${SETUP_STEP.replace("id: action-bun", "id: other")}`)
        .replace("steps.action-bun.outputs.path", "steps.other.outputs.path"),
      expected: [shapeMismatch("2 shared bun-setup steps")],
    },
    {
      reason: "the shared step at @main under another id, the recorded path bound to it",
      text: canonical
        .replace("id: action-bun", "id: other")
        .replace("@build", "@main")
        .replace("steps.action-bun.outputs.path", "steps.other.outputs.path"),
      expected: [shapeMismatch(`0 steps with id 'action-bun'`)],
    },
    {
      reason:
        "the recorded path bound to a run step that assigns path locally but never writes it to GITHUB_OUTPUT",
      text: canonical.replace(
        RUN_STEP,
        `    - id: local\n      shell: bash\n      run: |\n        path="$(command -v bun)"\n        echo "ready=true" >> "$GITHUB_OUTPUT"\n${RUN_STEP.replace("steps.action-bun.outputs.path", "steps.local.outputs.path")}`,
      ),
      expected: [danglingMismatch("local", "step 'local' sets no path output")],
    },
    {
      reason: "the step at another ref",
      text: canonical.replace("@build", "@main"),
      expected: [shapeMismatch(`uses '${BUN_SETUP_USES.replace("@build", "@main")}'`)],
    },
    {
      reason: "the step by a relative path",
      text: canonical.replace(BUN_SETUP_USES, "./actions/bun-setup"),
      expected: [shapeMismatch("uses './actions/bun-setup'")],
    },
    {
      reason: "the step handed the CALLER's pin",
      text: canonical.replace("pin: ${{ github.action_path }}/.bun-version", "pin: .bun-version"),
      expected: [shapeMismatch("pin '.bun-version'")],
    },
    {
      reason: "the step handed no pin",
      text: canonical.replace(
        "      with:\n        pin: ${{ github.action_path }}/.bun-version\n",
        "",
      ),
      expected: [shapeMismatch("pin 'undefined'")],
    },
    {
      reason: "a step using an action ahead of it",
      text: canonical.replace(SETUP_STEP, `    - uses: actions/checkout@v7\n${SETUP_STEP}`),
      expected: [
        shapeMismatch("step 'actions/checkout@v7' uses an action or touches bun before it"),
      ],
    },
    {
      reason: "a step touching bun ahead of it",
      text: canonical.replace(
        SETUP_STEP,
        `    - name: Warm\n      shell: bash\n      env:\n        BUN: bun\n      run: '"$BUN" x.ts'\n${SETUP_STEP}`,
      ),
      expected: [shapeMismatch("step 'Warm' uses an action or touches bun before it")],
    },
    {
      reason: "a dangling steps.<id>.outputs.path reference",
      text: canonical.replace("steps.action-bun.outputs.path", "steps.gone.outputs.path"),
      expected: [danglingMismatch("gone")],
    },
    {
      reason: "a steps.undefined.outputs.path reference beside an id-less step",
      text: canonical.replace(
        RUN_STEP,
        `${RUN_STEP.replace("steps.action-bun.outputs.path", "steps.undefined.outputs.path")}    - name: Tail\n      shell: bash\n      run: echo ok\n`,
      ),
      expected: [danglingMismatch("undefined")],
    },
  ])("$reason is refused", ({ text, expected }) => {
    expect(text).not.toBe(canonical);
    expect(actionsBunGuardMismatches(FILE, text)).toEqual(expected);
  });

  // pages-site records the caller's PATH ahead of its setup, by design.
  test("a run step neither using an action nor touching bun may precede the setup", () => {
    const record = `    - name: Record the caller's toolchain PATH\n      id: caller\n      shell: bash\n      run: echo "path=$PATH" >> "$GITHUB_OUTPUT"\n`;
    const preceded = canonical.replace("  steps:\n", `  steps:\n${record}`);
    expect(preceded).not.toBe(canonical);
    expect(actionsBunGuardMismatches(FILE, preceded)).toEqual([]);
  });

  test("an action running a bun it names only in env, with no setup, is refused", () => {
    const text = `runs:\n  using: composite\n  steps:\n    - name: Run\n      shell: bash\n      env:\n        BUN: bun\n      run: '"$BUN" x.ts'\n`;
    expect(actionsBunGuardMismatches(FILE, text)).toEqual([
      shapeMismatch("0 steps with id 'action-bun'"),
    ]);
  });

  // The shared setup action reads the caller's pin through its input and
  // carries no bun-setup step; any other action shaped like it is unpinned
  // on both counts.
  test("actions/bun-setup's own setup steps read the pin input; another action shaped like it is refused", () => {
    const shared = `runs:
  using: composite
  steps:
    - name: Set up bun
      id: setup-bun
      continue-on-error: true
      uses: oven-sh/setup-bun@v2
      with:
        bun-version-file: \${{ inputs.pin }}
    - name: Set up bun (retry)
      if: steps.setup-bun.outcome == 'failure'
      continue-on-error: true
      uses: oven-sh/setup-bun@v2
      with:
        bun-version-file: \${{ inputs.pin }}
`;
    expect(actionsBunGuardMismatches("actions/bun-setup/action.yml", shared)).toEqual([]);
    expect(actionsBunGuardMismatches(FILE, shared)).toEqual([
      shapeMismatch("0 steps with id 'action-bun'"),
      perStepMismatch,
      perStepMismatch,
    ]);
  });

  // A later setup-bun (the fetched tree's, a caller's) can put another bun
  // first on PATH; a step naming `bun` would run it. Block scalars are read
  // line by line, so a second line is as loud as the first.
  test.each([
    ['bun "${{ github.action_path }}/x.ts"', ['bun "${{ github.action_path }}/x.ts"']],
    ["bun install --frozen-lockfile --production", ["bun install --frozen-lockfile --production"]],
    ['|\n        "$ACTION_BUN" install\n        bun "x.ts"', ['bun "x.ts"']],
  ])("a step running %s beside the shared step is refused for bun by name", (run, lines) => {
    const text = canonical.replace(
      `      run: '"$ACTION_BUN" "\${{ github.action_path }}/x.ts"'\n`,
      () => `      run: ${run}\n`,
    );
    expect(text).not.toBe(canonical);
    expect(actionsBunGuardMismatches(FILE, text)).toEqual(
      lines.map((line) => bareBunMismatch(line)),
    );
  });

  test.each([
    { uses: "oven-sh/setup-bun@v2", reason: "a plain spelling" },
    { uses: '"oven-sh/setup-bun@v2"', reason: "a quoted look-alike" },
    {
      uses: "OVEN-SH/Setup-Bun@v2",
      reason: "a mixed-case id (GitHub action ids are case-insensitive)",
    },
  ])("an EXTRA bare setup-bun beside the shared step is refused per step - $reason", ({ uses }) => {
    const extra = `${canonical}
    - name: Set up bun again
      uses: ${uses}
`;
    expect(actionsBunGuardMismatches(FILE, extra)).toEqual([perStepMismatch]);
  });

  test("an EXTRA setup-bun pinned under the runner scratch root is refused per step like any other pin", () => {
    const extra = `${canonical}
    - name: Set up a fetched tree's bun
      uses: oven-sh/setup-bun@v2
      with:
        bun-version-file: \${{ runner.temp }}/tree/.bun-version
`;
    expect(actionsBunGuardMismatches(FILE, extra)).toEqual([perStepMismatch]);
  });

  test("an action that runs bun by name with no setup at all is refused for the missing setup and the name", () => {
    const text =
      'runs:\n  using: composite\n  steps:\n    - name: Run\n      shell: bash\n      run: bun "x.ts"\n';
    expect(actionsBunGuardMismatches(FILE, text)).toEqual([
      shapeMismatch("0 steps with id 'action-bun'"),
      bareBunMismatch('bun "x.ts"'),
    ]);
  });

  test("a non-bun action consuming another action's path output needs no guard", () => {
    const text =
      "runs:\n  using: composite\n  steps:\n    - id: tool\n      uses: x/setup-tool@v1\n    - name: Run\n      shell: bash\n      env:\n        TOOL: ${{ steps.tool.outputs.path }}\n      run: '\"$TOOL\" --check'\n";
    expect(actionsBunGuardMismatches(FILE, text)).toEqual([]);
  });

  test("an action touching no bun needs no guard", () => {
    const text =
      "runs:\n  using: composite\n  steps:\n    - name: Run\n      shell: bash\n      run: echo ok\n";
    expect(actionsBunGuardMismatches(FILE, text)).toEqual([]);
  });

  test("a commented setup-bun example alone demands nothing", () => {
    const text =
      "runs:\n  using: composite\n  steps:\n    # - uses: oven-sh/setup-bun@v2\n    - name: Run\n      shell: bash\n      run: echo ok\n";
    expect(actionSetsUpBun(text)).toBe(false);
    expect(actionsBunGuardMismatches(FILE, text)).toEqual([]);
  });

  test("the manifest walk sees nested actions", () => {
    expect(actionManifestFiles()).toContain("actions/pages-site/check-links/action.yml");
  });

  test("the composite actions' bun pin is ARMED: every bun-touching action.yml carries one pinned bun setup", () => {
    // The live-file forcing test: handing check-typography's shared step
    // the CALLER's pin goes red here.
    const files = actionManifestFiles();
    const setups = files.filter((file) => actionSetsUpBun(readFileSync(file, "utf-8")));
    expect(setups.length).toBeGreaterThan(0);
    expect(
      files.flatMap((file) => actionsBunGuardMismatches(file, readFileSync(file, "utf-8"))),
    ).toEqual([]);
  });
});

describe("majorMinor", () => {
  test("reads plain versions and single caret/tilde ranges", () => {
    expect(majorMinor("1.4.0", "w")).toEqual([1, 4]);
    expect(majorMinor("^1.4.0", "w")).toEqual([1, 4]);
    expect(majorMinor("~2.10", "w")).toEqual([2, 10]);
  });

  test("throws on anything else, so a half-parsed range never passes vacuously", () => {
    expect(() => majorMinor("latest", "w")).toThrow("w");
    expect(() => majorMinor(">=1.4.0", "w")).toThrow("MAJOR.MINOR");
    expect(() => majorMinor("^1.4.0 || ^2.0.0", "w")).toThrow("MAJOR.MINOR");
    expect(() => majorMinor("1.4.not-semver", "w")).toThrow("MAJOR.MINOR");
    expect(() => majorMinor("1.4.0-canary.1", "w")).toThrow("MAJOR.MINOR");
  });
});

describe("bunTypesAheadMismatches", () => {
  test("types at or behind the runtime's MAJOR.MINOR pass", () => {
    expect(
      bunTypesAheadMismatches("1.4.2", [
        { file: "package.json", version: "^1.4.0" },
        { file: "actions/x/package.json", version: "^1.3.14" },
      ]),
    ).toEqual([]);
  });

  test("types ahead on minor or major fail, naming the runtime pin's home", () => {
    const mismatches = bunTypesAheadMismatches("1.4.0", [
      { file: "package.json", version: "^1.5.0" },
      { file: "actions/x/package.json", version: "^2.0.0" },
    ]);
    expect(mismatches).toHaveLength(2);
    expect(mismatches[0].expected).toContain("files.yml");
    expect(mismatches[1].got).toContain("^2.0.0");
  });
});

describe("lockedTypesBunVersion", () => {
  // The shape bun.lock actually writes: a workspace dependency line (the
  // declared RANGE, which must not satisfy the extraction) above the
  // packages entry whose tuple head carries the resolved version.
  const lock = (resolved: string) =>
    [
      "{",
      '  "lockfileVersion": 1,',
      '  "workspaces": {',
      '    "": {',
      '      "devDependencies": {',
      '        "@types/bun": "^1.4.0",',
      "      },",
      "    },",
      "  },",
      '  "packages": {',
      `    "@types/bun": ["@types/bun@${resolved}", "", { "dependencies": { "bun-types": "${resolved}" } }, "sha512-x"],`,
      '    "x/@types/bun": ["@types/bun@9.9.9", "", {}, "sha512-y"],',
      "  },",
      "}",
    ].join("\n");

  test("reads the resolved version from the top-level packages entry, not the declared range", () => {
    expect(lockedTypesBunVersion(lock("1.5.0"), "bun.lock")).toBe("1.5.0");
  });

  test("a nested per-package resolution never satisfies the anchor", () => {
    const nestedOnly = lock("1.4.0").replace(/^\s*"@types\/bun": \["@types\/bun@1\.4\.0".*\n/m, "");
    expect(() => lockedTypesBunVersion(nestedOnly, "bun.lock")).toThrow("anchor");
  });

  test("a lock without the entry throws loudly instead of passing vacuously", () => {
    expect(() => lockedTypesBunVersion('{ "packages": {} }', "bun.lock")).toThrow(
      "resolved @types/bun",
    );
  });

  test("near miss: a lock resolving ahead of the runtime pin fails the rule's comparison", () => {
    // The reproduced gap: bun.lock resolves 1.5.0 while package.json
    // still declares ^1.4.0 - the declared floor passed, the installed
    // version must not.
    const installed = lockedTypesBunVersion(lock("1.5.0"), "bun.lock");
    const mismatches = bunTypesAheadMismatches("1.4.0", [{ file: "bun.lock", version: installed }]);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].file).toBe("bun.lock");
    expect(mismatches[0].got).toContain("1.5.0");
  });

  test("a lock resolving exactly the pin (or behind it) passes the rule's comparison", () => {
    const installed = lockedTypesBunVersion(lock("1.4.0"), "bun.lock");
    expect(bunTypesAheadMismatches("1.4.0", [{ file: "bun.lock", version: installed }])).toEqual(
      [],
    );
    expect(bunTypesAheadMismatches("1.5.1", [{ file: "bun.lock", version: installed }])).toEqual(
      [],
    );
  });
});

describe("bunRuntimeMismatches", () => {
  // Synthetic version pairs are the ONLY correct proof here, not a
  // concession: the guard's live population is permanently empty (CI
  // installs the pin via bun-version-file, and a matching local runtime
  // is the healthy state), so a live-tree control could never see it
  // fire - injected inputs are what keep the failing direction tested.
  test("a local runtime behind or ahead of the pin fails, naming both versions and the fix", () => {
    for (const local of ["1.3.14", "1.5.0", "2.4.0"]) {
      const found = bunRuntimeMismatches(local, "1.4.0");
      expect(found).toHaveLength(1);
      expect(found[0].got).toContain("1.4");
      expect(found[0].got).toContain(`${local.split(".")[0]}.${local.split(".")[1]}`);
      expect(found[0].got).toContain("bun upgrade");
    }
  });

  test("the pinned MAJOR.MINOR passes regardless of patch", () => {
    expect(bunRuntimeMismatches("1.4.0", "1.4.0")).toEqual([]);
    expect(bunRuntimeMismatches("1.4.3", "1.4.0")).toEqual([]);
  });

  test("an unreadable version throws loudly instead of passing vacuously", () => {
    expect(() => bunRuntimeMismatches("1.4.0-canary.1", "1.4.0")).toThrow("MAJOR.MINOR");
    expect(() => bunRuntimeMismatches("1.4.0", "")).toThrow("MAJOR.MINOR");
  });
});

describe("bunDirsMismatches", () => {
  const ACTION = "actions/validate-managed-files";
  const green: BunDirsInputs = {
    lockDirs: [".", "actions/check-typography", ACTION],
    dependabotBunDirs: [".", "actions/check-typography", ACTION],
    typecheckScript: `bun x tsc -p . && (cd actions/check-typography && bun x tsc -p .) && (cd ${ACTION} && bun x tsc -p .)`,
    typecheckRuns: `${TYPECHECK_TSCONFIG_LOOP}; do\n  (cd "$(dirname "$tsconfig")" && bun x tsc -p .)\ndone`,
    tsconfigDirs: [".", "actions/check-typography", ACTION],
  };
  const cases: [string, Partial<BunDirsInputs>, Mismatch[]][] = [
    ["every home covers the package", {}, []],
    [
      "dependabot's bun entry for the package is missing",
      { dependabotBunDirs: [".", "actions/check-typography"] },
      [
        {
          file: ".github/dependabot.yml",
          expected: `a bun ecosystem entry for ${ACTION} (it commits bun.lock)`,
          got: "no entry",
        },
      ],
    ],
    [
      "the typecheck script leaves the package out",
      {
        typecheckScript: "bun x tsc -p . && (cd actions/check-typography && bun x tsc -p .)",
      },
      [
        {
          file: "package.json",
          expected: `typecheck to cover ${ACTION}`,
          got: "not in the typecheck script",
        },
      ],
    ],
    [
      "the ci.yml loop drops the actions glob",
      {
        typecheckRuns:
          'for tsconfig in tsconfig.json; do\n  (cd "$(dirname "$tsconfig")" && bun x tsc -p .)\ndone',
      },
      [
        {
          file: "ci.yml typecheck",
          expected: `a glob loop ${TYPECHECK_TSCONFIG_LOOP}`,
          got: "no such loop",
        },
      ],
    ],
    [
      "the root commits a lockfile but no tsconfig.json",
      { tsconfigDirs: ["actions/check-typography", ACTION] },
      [
        {
          file: "./tsconfig.json",
          expected: "present (the ci.yml typecheck glob keys on it)",
          got: "missing",
        },
      ],
    ],
    [
      "the package commits a lockfile but no tsconfig.json",
      { tsconfigDirs: [".", "actions/check-typography"] },
      [
        {
          file: `${ACTION}/tsconfig.json`,
          expected: "present (the ci.yml typecheck glob keys on it)",
          got: "missing",
        },
      ],
    ],
  ];
  test.each(cases)("%s", (_name, drift, expected) => {
    expect(bunDirsMismatches({ ...green, ...drift })).toEqual(expected);
  });
});

describe("scratchScopedScriptMismatches", () => {
  test("the live package.json carries every pinned command verbatim", () => {
    const live = JSON.parse(readFileSync("package.json", "utf-8")) as {
      scripts: Record<string, string>;
    };
    expect(scratchScopedScriptMismatches(live.scripts, SCRATCH_SCOPED_SCRIPTS)).toEqual([]);
  });

  test("a drift back to a shared-scratch command fails, quoting the pin and the drift", () => {
    // The two retired shapes, each of which passed every other gate while
    // sibling runs trampled one another's scratch: a bare `bun test`
    // (fixtures under the shared os.tmpdir) and a fixed --dest path a
    // concurrent build check once wiped from under a running one.
    const cases: [string, string][] = [
      ["test", "bun test"],
      [
        "build:check",
        "bun .github/scripts/build-branches/branch_tree.ts --dest /tmp/repo-platform-build-check && rm -rf /tmp/repo-platform-build-check",
      ],
    ];
    for (const [name, drifted] of cases) {
      const found = scratchScopedScriptMismatches(
        { ...SCRATCH_SCOPED_SCRIPTS, [name]: drifted },
        SCRATCH_SCOPED_SCRIPTS,
      );
      expect(found).toEqual([
        {
          file: "package.json",
          expected: `${name} script '${SCRATCH_SCOPED_SCRIPTS[name]}' (the command scopes its scratch per run)`,
          got: `'${drifted}'`,
        },
      ]);
    }
  });

  test("a pinned script deleted outright fails as missing, never passes vacuously", () => {
    const { test: _, ...withoutTest } = SCRATCH_SCOPED_SCRIPTS;
    expect(scratchScopedScriptMismatches(withoutTest, SCRATCH_SCOPED_SCRIPTS)).toEqual([
      {
        file: "package.json",
        expected: `test script '${SCRATCH_SCOPED_SCRIPTS.test}' (the command scopes its scratch per run)`,
        got: "no such script",
      },
    ]);
  });
});
