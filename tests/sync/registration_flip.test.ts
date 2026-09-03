// registration_flip.ts: the one-run .repo-platform.yml ownership flip
// (managed -> repo-owned starter). The trigger is HEAD's own manifest
// class, the header reword is exact-match-only and byte-surgical, and the
// note distinguishes "reworded" from "hands off a repo-edited header".

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  flipSummary,
  retrySummary,
  rewordedRegistration,
  starterHeaderFor,
  transitionRegistrationStarter,
} from "../../.github/scripts/sync/registration_flip.ts";
import { boundedSpawnSync } from "../shared/bounded_spawn";

const OLD_HEADER = [
  "# This file is managed by Vivswan/repo-platform. Its presence",
  "# marks this repository as participating in push sync. `modules` is this",
  "# repo's module selection - edit it and the next sync applies the change.",
  "",
].join("\n");

const git = (args: string[]) => {
  const proc = boundedSpawnSync(args);
  expect(proc.exitCode).toBe(0);
};

/** A target checkout whose HEAD manifest classes the registration file
 * `manifestClass` (null: no manifest committed at all), with `registration`
 * as the working-tree file. */
function target(registration: string, manifestClass: string | null = "managed"): string {
  const dir = mkdtempSync(join(tmpdir(), "registration-flip-"));
  git(["git", "-C", dir, "init", "-q", "-b", "main"]);
  git(["git", "-C", dir, "config", "commit.gpgsign", "false"]);
  git(["git", "-C", dir, "config", "core.hooksPath", "/dev/null"]);
  git(["git", "-C", dir, "config", "user.email", "t@example.com"]);
  git(["git", "-C", dir, "config", "user.name", "t"]);
  if (manifestClass !== null) {
    mkdirSync(join(dir, ".github"), { recursive: true });
    writeFileSync(
      join(dir, ".github/repo-platform-manifest.json"),
      `${JSON.stringify({ files: { ".repo-platform.yml": { class: manifestClass } } }, null, 2)}\n`,
    );
  }
  git(["git", "-C", dir, "add", "-A"]);
  git(["git", "-C", dir, "commit", "-qm", "head", "--allow-empty"]);
  writeFileSync(join(dir, ".repo-platform.yml"), registration);
  return dir;
}

describe("starterHeaderFor", () => {
  test("renders the template's own leading comment block for the owner", () => {
    const header = starterHeaderFor("SomeOwner");
    expect(header).toContain("SomeOwner/repo-platform");
    expect(header).not.toContain("{{");
    // Every line is a comment; the block ends before the blank line.
    for (const line of header.trimEnd().split("\n")) expect(line.startsWith("#")).toBe(true);
  });

  test("a template without the owner expression throws instead of guessing", () => {
    const bogus = mkdtempSync(join(tmpdir(), "registration-flip-"));
    writeFileSync(join(bogus, "t.jinja"), "# plain header\nmodules: []\n");
    expect(() => starterHeaderFor("Vivswan", join(bogus, "t.jinja"))).toThrow(
      /no leading comment block/,
    );
  });
});

describe("rewordedRegistration", () => {
  test.each([
    { reason: "the fleet owner", owner: "Vivswan" },
    { reason: "an owner captured from the header line itself", owner: "OtherOwner" },
  ])("replaces the exact old rendered header and nothing else: $reason", ({ owner }) => {
    // Byte-exact: the new header for the captured owner, then everything
    // after the old block untouched - the blank seam line the render puts
    // between header and body included, no body edits.
    const body =
      '\nmodules: ["uv"]\nmirrors:\n  - source: LICENSE.md\n    targets: [a/LICENSE.md]\n';
    expect(rewordedRegistration(`${OLD_HEADER.replaceAll("Vivswan", owner)}${body}`)).toBe(
      `${starterHeaderFor(owner)}${body}`,
    );
  });

  test("a hand-edited header is left alone (null)", () => {
    expect(rewordedRegistration(`# my own words\n${OLD_HEADER}modules: []\n`)).toBeNull();
    expect(rewordedRegistration('modules: ["uv"]\n')).toBeNull();
  });
});

describe("transitionRegistrationStarter", () => {
  test("HEAD manifest managed: rewords the header, notes the flip", () => {
    const body = '\nmodules: ["uv"]\n';
    const dir = target(`${OLD_HEADER}${body}`);
    const out = join(dir, "registration-flip.md");
    transitionRegistrationStarter(dir, out, "t");
    expect(readFileSync(join(dir, ".repo-platform.yml"), "utf-8")).toBe(
      `${starterHeaderFor("Vivswan")}${body}`,
    );
    expect(readFileSync(out, "utf-8")).toBe(flipSummary(true));
  });

  test("HEAD manifest managed, repo-edited header: hands off, still notes the flip", () => {
    const text = '# our own header\nmodules: ["uv"]\n';
    const dir = target(text);
    const out = join(dir, "registration-flip.md");
    transitionRegistrationStarter(dir, out, "t");
    expect(readFileSync(join(dir, ".repo-platform.yml"), "utf-8")).toBe(text);
    expect(readFileSync(out, "utf-8")).toBe(flipSummary(false));
  });

  test("HEAD manifest already starter, old header still present: rewords with the retry note", () => {
    // The failed-then-merged shape: the flip landed (HEAD classes starter)
    // but an earlier sync's reword did not. The old header text is the
    // trigger, so the reword still lands - with the smaller note.
    const body = '\nmodules: ["uv"]\n';
    const dir = target(`${OLD_HEADER}${body}`, "starter");
    const out = join(dir, "registration-flip.md");
    transitionRegistrationStarter(dir, out, "t");
    expect(readFileSync(join(dir, ".repo-platform.yml"), "utf-8")).toBe(
      `${starterHeaderFor("Vivswan")}${body}`,
    );
    expect(readFileSync(out, "utf-8")).toBe(retrySummary());
  });

  test("converged state (reworded header, starter at HEAD): no note, file untouched", () => {
    const text = `${starterHeaderFor("Vivswan")}\nmodules: ["uv"]\n`;
    const dir = target(text, "starter");
    const out = join(dir, "registration-flip.md");
    transitionRegistrationStarter(dir, out, "t");
    expect(readFileSync(join(dir, ".repo-platform.yml"), "utf-8")).toBe(text);
    expect(readFileSync(out, "utf-8")).toBe("");
  });

  test("an unreadable HEAD manifest still rewords by the header trigger, with the retry note", () => {
    // The old header text alone is proof of the pre-flip vintage (only the
    // pre-flip template rendered it, and the hash pinning enforced it), so
    // a damaged manifest must not park the reword forever - it only
    // downgrades the note (other machinery reports the manifest damage).
    const body = '\nmodules: ["uv"]\n';
    const dir = target(`${OLD_HEADER}${body}`, null);
    const out = join(dir, "registration-flip.md");
    transitionRegistrationStarter(dir, out, "t");
    expect(readFileSync(join(dir, ".repo-platform.yml"), "utf-8")).toBe(
      `${starterHeaderFor("Vivswan")}${body}`,
    );
    expect(readFileSync(out, "utf-8")).toBe(retrySummary());
  });

  test("fail-soft: a broken template source leaves the file alone and says so", () => {
    const text = `${OLD_HEADER}modules: ["uv"]\n`;
    const dir = target(text);
    const out = join(dir, "registration-flip.md");
    transitionRegistrationStarter(dir, out, "t", join(dir, "no-such-template.jinja"));
    expect(readFileSync(join(dir, ".repo-platform.yml"), "utf-8")).toBe(text);
    expect(readFileSync(out, "utf-8")).toContain("did not complete");
  });
});

describe("flipSummary and retrySummary", () => {
  test("both flip outcomes name the flip; only one claims the reword", () => {
    expect(flipSummary(true)).toContain("repo-owned now");
    expect(flipSummary(true)).toContain("was reworded");
    expect(flipSummary(false)).toContain("repo-owned now");
    expect(flipSummary(false)).toContain("NOT rewritten");
    for (const summary of [flipSummary(true), flipSummary(false)]) {
      expect(summary).toContain("no longer drift");
    }
  });

  test("the retry note claims the reword alone, not the flip", () => {
    expect(retrySummary()).toContain("header reworded");
    expect(retrySummary()).not.toContain("repo-owned now");
  });
});
