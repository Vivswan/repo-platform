import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseFlags } from "./flags.ts";

const HELPER = join(import.meta.dir, "flags.ts");

// Error paths call process.exit, so exercise them in a subprocess the way
// the adopting scripts hit them.
function run(snippet: string): { exitCode: number; stderr: string } {
  const proc = Bun.spawnSync([
    "bun",
    "-e",
    `import { parseFlags } from ${JSON.stringify(HELPER)}; ${snippet}`,
  ]);
  return { exitCode: proc.exitCode, stderr: proc.stderr.toString() };
}

describe("parseFlags", () => {
  test("returns required and optional flags as a typed record", () => {
    const flags = parseFlags(["--a", "1", "--b", "2"], ["--a"], ["--b"]);
    expect(flags["--a"]).toBe("1");
    expect(flags["--b"]).toBe("2");
  });

  test("last occurrence wins for a duplicated flag", () => {
    expect(parseFlags(["--a", "1", "--a", "2"], ["--a"])["--a"]).toBe("2");
  });

  test("an empty-string value satisfies a required flag", () => {
    expect(parseFlags(["--a", ""], ["--a"])["--a"]).toBe("");
  });

  test("a value that looks like a flag is consumed as the value", () => {
    expect(parseFlags(["--a", "--b"], ["--a"])["--a"]).toBe("--b");
  });

  test("an absent optional flag is simply missing", () => {
    expect("--b" in parseFlags(["--a", "1"], ["--a"], ["--b"])).toBe(false);
  });

  test("an inherited object key does not satisfy a required flag", () => {
    const { exitCode, stderr } = run(`parseFlags([], ["toString"]);`);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("missing required flags: toString");
  });

  test("an unknown flag fails naming the allowed set", () => {
    const { exitCode, stderr } = run(`parseFlags(["--nope", "1"], ["--a"]);`);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('unknown or valueless argument "--nope"');
    expect(stderr).toContain("--a");
  });

  test("a trailing flag with no value fails", () => {
    const { exitCode, stderr } = run(`parseFlags(["--a"], ["--a"]);`);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("unknown or valueless argument");
  });

  test("a missing required flag fails naming exactly the missing ones", () => {
    const { exitCode, stderr } = run(`parseFlags(["--a", "1"], ["--a", "--b", "--c"]);`);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("missing required flags: --b, --c");
  });
});
