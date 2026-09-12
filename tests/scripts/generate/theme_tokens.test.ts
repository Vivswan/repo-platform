import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { capture } from "../../../.github/scripts/shared/proc.ts";
import {
  THEME_TOKENS_CSS,
  themeCssCurrent,
  themeTokensCss,
} from "../../../scripts/generate/theme_tokens";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();
const REPO_ROOT = resolve(import.meta.dir, "../../..");

describe("themeTokensCss", () => {
  test("the committed CSS is the rendered token data", () => {
    expect(readFileSync(join(REPO_ROOT, THEME_TOKENS_CSS), "utf-8")).toBe(themeTokensCss());
  });

  test("the cascade order holds: shared, light, dark, hue slots, then print last", () => {
    const css = themeTokensCss();
    const at = (selector: string) => css.indexOf(selector);
    expect(at(":root,\n.dark {")).toBeGreaterThan(-1);
    expect(at(":root,\n.dark {")).toBeLessThan(at("\n\n:root {"));
    expect(at("\n\n:root {")).toBeLessThan(at("\n\n.dark {"));
    expect(at("\n\n.dark {")).toBeLessThan(at('html[data-fleet-hue="1"]'));
    expect(at('html[data-fleet-hue="1"]')).toBeLessThan(at("@media print {"));
    expect(css.trimEnd().endsWith("/* END GENERATED: theme-tokens */")).toBe(true);
  });

  test("the check reads stale and missing as not current, the rendered bytes as current", () => {
    const dir = temp.dir("theme-tokens-");
    const path = join(dir, "tokens.css");
    expect(themeCssCurrent(path)).toBe(false);
    writeFileSync(path, `${themeTokensCss()}\n`);
    expect(themeCssCurrent(path)).toBe(false);
    writeFileSync(path, themeTokensCss());
    expect(themeCssCurrent(path)).toBe(true);
  });

  test("--check passes on the committed file and rejects a stray argument", () => {
    const ok = capture(["bun", "scripts/generate/theme_tokens.ts", "--check"], { cwd: REPO_ROOT });
    expect(ok.exitCode).toBe(0);
    const bad = capture(["bun", "scripts/generate/theme_tokens.ts", "--write"], { cwd: REPO_ROOT });
    expect([bad.exitCode, bad.stderr.trim()]).toEqual([
      2,
      "error: unrecognized argument(s): --write",
    ]);
  });
});
