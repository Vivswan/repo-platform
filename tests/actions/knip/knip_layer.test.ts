// knip_layer.ts is the rule the fleet's knip reads its configuration through, and knip's schema only judges the result,
// so each row is a configuration form a repository can write and the configuration knip must then run: the negation
// joins a configured list once, where knip reads the root's lists; a list knip reads as its defaults stays as it came
// (a negation beside knip's default patterns would make the list explicit, which changes how knip treats an entry's
// exports); a function is called with knip's arguments. knip's own `isDefaultPattern` is the test, from the action's
// knip. What knip refuses, knip_action.test.ts runs through knip.

import { describe, expect, test } from "bun:test";
import { layer } from "../../../actions/knip/knip_layer";
import { KNIP_DEFAULT_PATTERNS } from "../../../actions/knip/run";
import { PLATFORM_CHECKOUT_DIR } from "../../../actions/shared/platform";

const NEGATION = `!${PLATFORM_CHECKOUT_DIR}/**`;
const DEFAULT_ENTRY = "{index,cli,main}.{js,mjs,cjs,jsx,ts,tsx,mts,cts}!";
const { isDefaultPattern } = await import(KNIP_DEFAULT_PATTERNS);
const options = { negation: NEGATION, isDefaultPattern };
type Arguments = Parameters<ReturnType<typeof layer>>[0];
const run = (own: unknown, manifest: { knip?: unknown } = {}, args = {} as Arguments) =>
  layer(own, manifest, options)(args);

describe("actions/knip/knip_layer", () => {
  test.each<{ form: string; own: unknown; manifest?: { knip?: unknown }; expected: unknown }>([
    {
      form: "a string entry over a manifest list already carrying the negation",
      own: { entry: "src/main.ts" },
      manifest: { knip: { project: ["src/**/*.ts", NEGATION], ignoreWorkspaces: ["old"] } },
      expected: {
        project: ["src/**/*.ts", NEGATION],
        ignoreWorkspaces: ["old"],
        entry: ["src/main.ts", NEGATION],
      },
    },
    {
      form: "empty strings, knip's defaults, stay as they came",
      own: { entry: "", project: "" },
      expected: { entry: "", project: "" },
    },
    {
      form: "knip's default patterns alone stay as they came",
      own: {
        entry: [DEFAULT_ENTRY, `src/${DEFAULT_ENTRY}`],
        project: ["**/*.{js,mjs,cjs,jsx,ts,tsx,mts,cts}!"],
        includeEntryExports: true,
      },
      expected: {
        entry: [DEFAULT_ENTRY, `src/${DEFAULT_ENTRY}`],
        project: ["**/*.{js,mjs,cjs,jsx,ts,tsx,mts,cts}!"],
        includeEntryExports: true,
      },
    },
    {
      form: "a default pattern beside an explicit one: the list is explicit, so the negation joins",
      own: { entry: [DEFAULT_ENTRY, "**/*.test.ts"] },
      expected: { entry: [DEFAULT_ENTRY, "**/*.test.ts", NEGATION] },
    },
    {
      form: "the root workspace under workspaces['.']; other workspaces and the top level untouched",
      own: {
        project: ["never/**"],
        workspaces: { ".": { entry: ["src/main.ts"] }, "packages/*": { entry: ["index.ts"] } },
      },
      expected: {
        project: ["never/**"],
        workspaces: {
          ".": { entry: ["src/main.ts", NEGATION] },
          "packages/*": { entry: ["index.ts"] },
        },
      },
    },
  ])("$form", async ({ own, manifest, expected }) => {
    expect(await run(own, manifest)).toEqual(expected);
  });

  test("a module namespace whose default export is a promise of a function: called with knip's arguments, layered over the manifest", async () => {
    const own = {
      default: Promise.resolve((args: { production?: boolean }) => ({
        entry: args.production ? ["dist/main.ts"] : ["src/main.ts", "**/*.test.ts"],
      })),
      ignored: [/^left-/],
    };
    const manifest = { knip: { entry: ["tools/*.ts"], ignoreBinaries: ["make"] } };
    expect(await run(own, manifest, { production: true } as Arguments)).toEqual({
      entry: ["dist/main.ts", NEGATION],
      ignoreBinaries: ["make"],
    });
  });
});
