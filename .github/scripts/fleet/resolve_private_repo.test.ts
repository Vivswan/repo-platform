import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyTag } from "./redact.ts";

// End-to-end harness for the leg-side resolver, stub-gh style (see
// select_settings_repos.test.ts). Running the real script against tags
// computed by redact.ts's verifyTag is also the bash/TS HMAC lockstep
// proof: resolution only succeeds when both sides derive the same key and
// tag - openssl is real here, only `gh` is stubbed.
describe("resolve_private_repo.sh", () => {
  const script = join(import.meta.dir, "resolve_private_repo.sh");
  const root = mkdtempSync(join(tmpdir(), "resolve-private-"));
  const bin = join(root, "bin");
  const PAT = "resolver-test-pat";
  const RUN_ID = "31337";
  const FLEET = ["Vivswan/pub-repo", "Vivswan/hidden-server", "Other/Shared-Private"];

  beforeAll(() => {
    mkdirSync(bin);
    writeFileSync(
      join(bin, "gh"),
      [
        "#!/usr/bin/env bash",
        `echo '[${JSON.stringify(
          FLEET.map((full_name) => ({ full_name, archived: false, permissions: { push: true } })),
        )}]'`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
  });

  interface Run {
    exitCode: number;
    stdout: string;
    env: string;
    output: string;
  }

  function run(name: string, extra: Record<string, string>): Run {
    const work = join(root, `work-${name}`);
    mkdirSync(join(work, "temp"), { recursive: true });
    const envFile = join(work, "env");
    const outFile = join(work, "out");
    writeFileSync(envFile, "");
    writeFileSync(outFile, "");
    const proc = Bun.spawnSync(["bash", script], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        PAT,
        GITHUB_RUN_ID: RUN_ID,
        GITHUB_ENV: envFile,
        GITHUB_OUTPUT: outFile,
        RUNNER_TEMP: join(work, "temp"),
        ...extra,
      },
    });
    return {
      exitCode: proc.exitCode,
      stdout: proc.stdout.toString() + proc.stderr.toString(),
      env: readFileSync(envFile, "utf-8"),
      output: readFileSync(outFile, "utf-8"),
    };
  }

  test("public rows pass through untouched", () => {
    const r = run("public", {
      TARGET_INPUT: "Vivswan/pub-repo",
      REDACT_NAME: "false",
      VERIFY: "",
    });
    expect(r.exitCode).toBe(0);
    expect(r.env).toContain("TARGET=Vivswan/pub-repo");
    expect(r.env).toContain("TARGET_DISPLAY=Vivswan/pub-repo");
    expect(r.output).toContain("repo=Vivswan/pub-repo");
    expect(r.stdout).not.toContain("::add-mask::");
  });

  test("resolves a redacted row by tag and masks before anything else", () => {
    const r = run("resolve", {
      TARGET_INPUT: "h**-s**r",
      REDACT_NAME: "true",
      VERIFY: verifyTag(PAT, RUN_ID, "Vivswan/hidden-server"),
    });
    expect(r.exitCode).toBe(0);
    expect(r.env).toContain("TARGET=Vivswan/hidden-server");
    expect(r.env).toContain("TARGET_DISPLAY=h**-s**r");
    expect(r.output).toContain("repo=Vivswan/hidden-server");
    // The slug and bare name reach stdout only as masker registrations,
    // and those precede every other line mentioning the target.
    const lines = r.stdout.split("\n");
    for (const line of lines) {
      if (line.includes("hidden-server") || line.includes("Vivswan/hidden-server")) {
        expect(line).toStartWith("::add-mask::");
      }
    }
    expect(lines.indexOf("::add-mask::Vivswan/hidden-server")).toBeGreaterThanOrEqual(0);
    expect(lines.indexOf("::add-mask::hidden-server")).toBeGreaterThan(
      lines.indexOf("::add-mask::Vivswan/hidden-server"),
    );
  });

  test("masks lowercase forms of a mixed-case slug", () => {
    const r = run("case", {
      TARGET_INPUT: "S**-P**e",
      REDACT_NAME: "true",
      VERIFY: verifyTag(PAT, RUN_ID, "other/shared-private"),
    });
    expect(r.exitCode).toBe(0);
    expect(r.env).toContain("TARGET=Other/Shared-Private");
    expect(r.stdout).toContain("::add-mask::Other/Shared-Private");
    expect(r.stdout).toContain("::add-mask::other/shared-private");
    expect(r.stdout).toContain("::add-mask::Shared-Private");
    expect(r.stdout).toContain("::add-mask::shared-private");
  });

  test("zero matches fails closed naming only the hint", () => {
    const r = run("zero", {
      TARGET_INPUT: "g**-r**d",
      REDACT_NAME: "true",
      VERIFY: verifyTag(PAT, RUN_ID, "Vivswan/gone-renamed"),
    });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("cannot resolve the plan-time target (g**-r**d)");
    expect(r.stdout).not.toContain("gone-renamed");
    expect(r.env).toBe("");
    expect(r.output).toBe("");
  });

  test("an empty verify on a redacted row fails closed", () => {
    const r = run("noverify", {
      TARGET_INPUT: "h**-s**r",
      REDACT_NAME: "true",
      VERIFY: "",
    });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("without a resolution tag");
    expect(r.env).toBe("");
  });
});
