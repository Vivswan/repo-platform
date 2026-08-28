// open_pr.ts: the PR-body section collection and the auto-merge decision.
// The script is gh-bound, so a stub gh on PATH records every invocation
// and serves canned answers; the assertions read the recorded `pr create`
// body and the presence/absence of the `pr merge` arm call. The section
// fixtures write through the SAME filename constants the production
// writers use (section_files.ts), so a renamed report file fails here.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REMOVED_SPLITS_NAME,
  SETTINGS_LAYERING_NAME,
  TAIL_SHRANK_NAME,
} from "../../.github/scripts/sync/section_files.ts";

const script = join(import.meta.dir, "../../.github/scripts/sync/open_pr.ts");

const ghStub = `#!/usr/bin/env bash
set -euo pipefail
{ printf '%s' "gh"; for a in "$@"; do printf '\\x1f%s' "$a"; done; printf '\\x1e'; } >>"$CALLS_LOG"
case "$1 $2" in
  "pr list") printf '' ;;
  "pr create") echo "https://github.com/o/r/pull/1" ;;
  "pr view") echo "https://github.com/o/r/pull/1" ;;
  "pr merge")
    # gh's merge output can quote a credentialed URL and name target
    # settings; open_pr must redact it publicly and suppress it for a
    # hidden target.
    echo "auto-merge enabled via https://x-access-token:ghp_MERGESENTINEL@github.com/o/r.git"
    ;;
  *) : ;;
esac
`;

interface Options {
  /** RUNNER_TEMP files by name (old_commit.txt is always written); Buffer
   * values let a fixture carry invalid UTF-8 capture bytes. */
  temp?: Record<string, string | Buffer>;
  /** Contents for the env-named flag files ("" = present but empty). */
  files?: Record<string, string>;
  env?: Record<string, string>;
}

function run(opts: Options = {}) {
  const root = mkdtempSync(join(tmpdir(), "open-pr-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), ghStub, { mode: 0o755 });
  const runnerTemp = join(root, "runner-temp");
  mkdirSync(runnerTemp);
  writeFileSync(join(runnerTemp, "old_commit.txt"), "build@oldsha");
  for (const [name, content] of Object.entries(opts.temp ?? {})) {
    writeFileSync(join(runnerTemp, name), content);
  }
  const fileEnv: Record<string, string> = {};
  const fileVars = [
    "DRIFT_FILE",
    "CARRIED_FILE",
    "CARRY_REVIEW_FILE",
    "RETIRED_MODULES_FILE",
    "REMOVED_PATHS_FILE",
    "WITHHELD_FILE",
    "MANIFEST_LICENSE_FILE",
  ];
  for (const name of fileVars) {
    const path = join(root, `${name.toLowerCase()}.txt`);
    fileEnv[name] = path;
    const content = opts.files?.[name];
    if (content !== undefined) writeFileSync(path, content);
  }
  const calls = join(root, "calls.log");
  const proc = Bun.spawnSync(["bun", script], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      CALLS_LOG: calls,
      TARGET: "Vivswan/target",
      RUNNER_TEMP: runnerTemp,
      GITHUB_REPOSITORY: "Vivswan/repo-platform",
      GITHUB_OUTPUT: join(root, "gh-output.txt"),
      BRANCH: "automation/repo-platform",
      BASE_BRANCH: "main",
      DISPLAY: "build@newsha",
      RECOVER: "",
      RESOLVED: "",
      VALIDATION: "passed",
      HIDE_DETAILS: "",
      ...fileEnv,
      ...opts.env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const raw = existsSync(calls) ? readFileSync(calls, "utf-8") : "";
  const records = raw
    .split("\x1e")
    .filter(Boolean)
    .map((record) => record.split("\x1f"));
  const create = records.find((args) => args[1] === "pr" && args[2] === "create");
  const body = create ? (create[create.indexOf("--body") + 1] ?? "") : "";
  return {
    exitCode: proc.exitCode,
    output: proc.stdout.toString() + proc.stderr.toString(),
    records,
    body,
    merged: records.some((args) => args[1] === "pr" && args[2] === "merge"),
  };
}

describe("open_pr sections and auto-merge", () => {
  test("a clean update carries no sections and arms auto-merge", () => {
    const r = run();
    expect(r.exitCode).toBe(0);
    expect(r.body).toContain("Automated template update");
    expect(r.body).toContain("- New: `build@newsha`");
    expect(r.body).not.toContain("TAIL TRIPWIRE");
    expect(r.merged).toBe(true);
    expect(r.output).toContain("auto-merge armed");
  });

  test("the merge output is re-emitted redacted for a public target", () => {
    const r = run();
    expect(r.output).not.toContain("ghp_MERGESENTINEL");
    expect(r.output).toContain("auto-merge enabled via https://***@github.com/o/r.git");
  });

  test("a hidden target's merge output stays off the log entirely", () => {
    const r = run({ env: { HIDE_DETAILS: "true" } });
    expect(r.merged).toBe(true);
    expect(r.output).toContain("auto-merge armed");
    expect(r.output).not.toContain("ghp_MERGESENTINEL");
    expect(r.output).not.toContain("auto-merge enabled via");
  });

  test("a tail-shrank report becomes a body section and forces review", () => {
    const report = "> [!WARNING]\n> TAIL TRIPWIRE: lines missing\n";
    const r = run({ temp: { [TAIL_SHRANK_NAME]: report } });
    expect(r.exitCode).toBe(0);
    expect(r.body).toContain("TAIL TRIPWIRE: lines missing");
    expect(r.merged).toBe(false);
    expect(r.output).toContain("auto-merge left off");
  });

  test("a settings-layering report becomes a body section and forces review", () => {
    const r = run({ temp: { [SETTINGS_LAYERING_NAME]: "### settings.yml layering\ndropped" } });
    expect(r.exitCode).toBe(0);
    expect(r.body).toContain("settings.yml layering");
    expect(r.merged).toBe(false);
  });

  test("the carry summary is a section WITHOUT forcing review", () => {
    const r = run({ files: { CARRIED_FILE: "- `AGENTS.md`: rebuilt structurally" } });
    expect(r.exitCode).toBe(0);
    expect(r.body).toContain("rebuilt structurally");
    expect(r.merged).toBe(true);
  });

  test("the carry-review flag forces review without a body section of its own", () => {
    const r = run({ files: { CARRY_REVIEW_FILE: "AGENTS.md: managed-half edits reset\n" } });
    expect(r.exitCode).toBe(0);
    expect(r.body).not.toContain("managed-half edits reset");
    expect(r.merged).toBe(false);
    expect(r.output).toContain("auto-merge left off");
  });

  test("withheld workflow files and a removed-splits report both force review", () => {
    const withheld = run({ files: { WITHHELD_FILE: ".github/workflows/ci.yml\n" } });
    expect(withheld.body).toContain("WITHHELD");
    expect(withheld.merged).toBe(false);
    const report =
      "> [!WARNING]\n> This update DELETES file(s) whose previous copy carries a\n> repository-owned half.\n\n- `AGENTS.md`: this repository-owned content leaves with the deletion:\n\n  ````text\n  local agents tail\n  ````\n";
    const removed = run({ temp: { [REMOVED_SPLITS_NAME]: report } });
    expect(removed.body).toContain("This update DELETES");
    expect(removed.body).toContain("local agents tail");
    expect(removed.merged).toBe(false);
  });

  test("informational sections (retired modules, removed paths, manifest license) stay auto-merge-eligible", () => {
    const r = run({
      files: {
        RETIRED_MODULES_FILE: "fuzzer\n",
        REMOVED_PATHS_FILE: ".github/old.yml\n",
        MANIFEST_LICENSE_FILE: "license metadata note\n",
      },
    });
    expect(r.body).toContain("Retired modules dropped from the selection: fuzzer");
    expect(r.body).toContain("- .github/old.yml");
    expect(r.body).toContain("license metadata note");
    expect(r.merged).toBe(true);
  });

  test("out-of-band settings drift prepends to the top and forces review", () => {
    const r = run({ files: { DRIFT_FILE: "> [!WARNING]\n> drift detected\n" } });
    expect(r.body.startsWith("> [!WARNING]\n> drift detected")).toBe(true);
    expect(r.merged).toBe(false);
  });

  test("an oversized pile-up of sections stays under GitHub's 64 KiB body limit", () => {
    // Each section bounds itself, but several near their caps can SUM past
    // 64 KiB and gh would fail outright, stranding the pushed branch. The
    // aggregate budget drops the overflowing sections and adds one
    // truncation banner - and the run still stays manual (the banner does
    // not touch the flag-driven needs-review decision).
    const big = (tag: string) =>
      `${tag}\n${Array.from({ length: 700 }, (_, i) => `${tag} line ${i} ${"y".repeat(24)}`).join("\n")}`;
    const r = run({
      files: { CARRIED_FILE: big("carry") },
      temp: {
        [TAIL_SHRANK_NAME]: big("tripwire"),
        [REMOVED_SPLITS_NAME]: big("removed"),
      },
    });
    expect(r.exitCode).toBe(0);
    expect(Buffer.byteLength(r.body, "utf-8")).toBeLessThan(65536);
    expect(r.body).toContain("truncated to stay under GitHub's size limit");
    // The tail tripwire and removed-splits sections force review, so even
    // with their prose dropped the PR must not auto-merge.
    expect(r.merged).toBe(false);
  });

  test("a pathological oversized drift is bounded at the prepend, body under the limit", () => {
    // Drift is prepended on top and its value is target-controlled (a huge
    // recorded description); unbounded it would starve the reserved
    // validation section or trip the end-cutting hard cap that would drop
    // it - so it is truncated at its own cap with a note.
    const hugeDrift = `> [!WARNING]\n> drift\n${"d".repeat(200000)}`;
    const r = run({ files: { DRIFT_FILE: hugeDrift } });
    expect(r.exitCode).toBe(0);
    expect(Buffer.byteLength(r.body, "utf-8")).toBeLessThan(65536);
    expect(r.body).toContain(
      "reproduce the sync locally for the full report - docs/private-repos.md",
    );
    expect(r.merged).toBe(false);
  });

  test("a single over-limit multibyte drift line is cut on a char boundary", () => {
    // One line with no newline to trim to, made of a 3-byte char against a
    // cap NOT divisible by 3, forces the truncation's continuation-byte
    // back-off: a 2-byte char with an even cap would already land on a
    // boundary and leave the back-off branch untested.
    const oneLine = "\u20ac".repeat(30000); // 90000 bytes (3-byte char), no newlines
    const r = run({ files: { DRIFT_FILE: oneLine } });
    expect(r.exitCode).toBe(0);
    expect(Buffer.byteLength(r.body, "utf-8")).toBeLessThan(65536);
    expect(r.body).toContain(
      "reproduce the sync locally for the full report - docs/private-repos.md",
    );
    expect(r.body).not.toContain("\ufffd");
    expect(r.merged).toBe(false);
  });

  test("a hidden target's validation diagnostics survive budget exhaustion (reserved)", () => {
    // The PR body is a hidden target's only diagnostics channel
    // (run_hidden hides the log, the failure issue defers to the PR), so
    // the reservation must keep the workflow error's "details in the PR
    // body" claim true even when ordinary sections fill the budget.
    const big = (tag: string) =>
      `${tag}\n${Array.from({ length: 700 }, (_, i) => `${tag} line ${i} ${"y".repeat(24)}`).join("\n")}`;
    const capture = `validation diagnostic sentinel line\n${"d".repeat(5000)}`;
    const r = run({
      files: { CARRIED_FILE: big("carry") },
      temp: {
        [TAIL_SHRANK_NAME]: big("tripwire"),
        [REMOVED_SPLITS_NAME]: big("removed"),
        "hidden-template-validation.log": capture,
      },
      env: { VALIDATION: "failed", HIDE_DETAILS: "true" },
    });
    expect(r.exitCode).toBe(0);
    expect(Buffer.byteLength(r.body, "utf-8")).toBeLessThan(65536);
    // Ordinary sections overflowed (banner present), yet the validation
    // warning and its captured diagnostics made it in.
    expect(r.body).toContain("truncated to stay under GitHub's size limit");
    expect(r.body).toContain("Validation failed on the updated tree");
    expect(r.body).toContain("they are below");
    expect(r.body).toContain("validation diagnostic sentinel line");
    expect(r.merged).toBe(false);
  });

  test("the reservation holds at the boundary: near-full ordinary budget plus a full excerpt", () => {
    // The capture is SINGLE-LINE so the excerpt is char-cut at its true
    // 20000-byte maximum (a multi-line fixture would shed the oversized
    // line whole and leave a tiny excerpt that passes under any reserve).
    // The graded fillers must be OMITTED at the reserved headroom: if the
    // reservation shrinks below the excerpt's real size, a filler gets
    // accepted and the validation section no longer fits - and if the
    // excerpt plus framing outgrows the reserve, the near-full carry
    // alone pushes it out. Either regression fails the sentinel checks.
    const nearFull = `carry\n${"c".repeat(39400)}`;
    const capture = `validation diagnostic sentinel line ${"d".repeat(30000)}`;
    const r = run({
      files: { CARRIED_FILE: nearFull },
      temp: {
        "hidden-template-validation.log": capture,
        [TAIL_SHRANK_NAME]: `tripfill\n${"t".repeat(4000)}`,
        [REMOVED_SPLITS_NAME]: `removedfill\n${"r".repeat(2000)}`,
      },
      env: { VALIDATION: "failed", HIDE_DETAILS: "true" },
    });
    expect(r.exitCode).toBe(0);
    // The near-full carry was ACCEPTED (it fits the unreserved headroom);
    // the fillers were not (the reserve kept the headroom too small).
    expect(r.body).toContain("carry");
    expect(r.body).not.toContain("tripfill");
    expect(r.body).not.toContain("removedfill");
    expect(r.body).toContain("truncated to stay under GitHub's size limit");
    // The full-size excerpt landed inside the reservation.
    expect(r.body).toContain("validation diagnostic sentinel line");
    expect(r.body).toContain("(truncated; reproduce validation locally");
    expect(Buffer.byteLength(r.body, "utf-8")).toBeLessThanOrEqual(62000 + 300);
    expect(r.merged).toBe(false);
  });

  test("invalid capture bytes cannot inflate the excerpt past its reservation", () => {
    // Invalid bytes decode to 3-byte U+FFFD replacements, so the excerpt
    // must be bounded on its re-encoded size or the reserved section is
    // dropped exactly when the ordinary budget is full.
    const nearFull = `carry\n${"c".repeat(38800)}`;
    const capture = Buffer.concat([
      Buffer.from("validation diagnostic sentinel line ", "utf-8"),
      Buffer.alloc(25000, 0x80), // lone continuation bytes: invalid UTF-8
    ]);
    const r = run({
      files: { CARRIED_FILE: nearFull },
      temp: { "hidden-template-validation.log": capture },
      env: { VALIDATION: "failed", HIDE_DETAILS: "true" },
    });
    expect(r.exitCode).toBe(0);
    expect(Buffer.byteLength(r.body, "utf-8")).toBeLessThan(65536);
    expect(r.body).toContain("carry");
    // The reserved section landed, excerpting the decoded (replaced) bytes.
    expect(r.body).toContain("validation diagnostic sentinel line");
    expect(r.body).toContain("\ufffd");
    expect(r.body).toContain("(truncated; reproduce validation locally");
    expect(r.merged).toBe(false);
  });

  test("an oversized recorded _commit cannot starve the reserved validation excerpt", () => {
    // The base body sits OUTSIDE the section budget and interpolates the
    // target's recorded _commit, which resolve_refs leaves unbounded (a
    // long-but-valid revision expression still resolves) - display must
    // clip it, or the inflated base pushes the reserved section out.
    const hugeOldCommit = `abc1234${"^0".repeat(30000)}`;
    const capture = `validation diagnostic sentinel line ${"d".repeat(30000)}`;
    const r = run({
      temp: {
        "old_commit.txt": hugeOldCommit,
        "hidden-template-validation.log": capture,
      },
      env: { VALIDATION: "failed", HIDE_DETAILS: "true" },
    });
    expect(r.exitCode).toBe(0);
    expect(Buffer.byteLength(r.body, "utf-8")).toBeLessThan(65536);
    expect(r.body).toContain("- Previous: `abc1234^0");
    expect(r.body).toContain("[clipped]");
    expect(r.body).toContain("validation diagnostic sentinel line");
    expect(r.merged).toBe(false);
  });

  test("raw NULs in the capture cannot kill the gh spawn (delivery survives)", () => {
    // Raw control bytes decode VERBATIM (unlike invalid bytes), and argv
    // cannot carry a NUL: unescaped, gh pr create fails before any PR
    // exists - the whole delivery channel lost, worse than an omitted
    // section. Mixed with invalid bytes to cover both decode paths.
    // A NUL FLOOD, not a token amount: unescaped it would pass the budget
    // checks at raw size, quadruple at the spawn-boundary escape, and send
    // the body through capBody's end-cutting - the reservation math must
    // measure the escaped text instead.
    const capture = Buffer.concat([
      Buffer.from("validation diagnostic sentinel line ", "utf-8"),
      Buffer.alloc(50, 0x80), // invalid continuation bytes: decode to U+FFFD
      Buffer.alloc(25000, 0x00), // raw NULs: decode verbatim
    ]);
    const r = run({
      temp: { "hidden-template-validation.log": capture },
      env: { VALIDATION: "failed", HIDE_DETAILS: "true" },
    });
    // Delivery happened at all: the gh stub was reached and recorded.
    expect(r.exitCode).toBe(0);
    expect(r.body).not.toBe("");
    expect(r.body).not.toContain("\u0000");
    expect(Buffer.byteLength(r.body, "utf-8")).toBeLessThan(65536);
    expect(r.body).toContain("validation diagnostic sentinel line");
    expect(r.body).toContain("\\x00"); // the escaped representation is visible
    expect(r.body).toContain("\ufffd");
    expect(r.body).not.toContain("hard-truncated"); // never detoured through capBody
    expect(r.merged).toBe(false);
  });

  test("a raw NUL in any ordinary section file is escaped at the spawn boundary", () => {
    // Section files are written by this repo's own escaping writers, but
    // the boundary guard must hold even when one slips through.
    const r = run({ files: { CARRIED_FILE: "carry section with a \u0000 byte" } });
    expect(r.exitCode).toBe(0);
    expect(r.body).not.toContain("\u0000");
    expect(r.body).toContain("carry section with a \\x00 byte");
  });

  test("a NUL-heavy ordinary section is measured escaped, sparing the reserved excerpt", () => {
    // Unescaped, 25000 raw NULs fit the ordinary budget, quadruple at the
    // boundary backstop past the hard cap, and capBody's end-cutting would
    // take the reserved section - chunks must be escaped BEFORE measuring.
    const nulHeavy = `carry\n${"\u0000".repeat(25000)}`;
    const capture = "validation diagnostic sentinel line\n";
    const r = run({
      files: { CARRIED_FILE: nulHeavy },
      temp: { "hidden-template-validation.log": capture },
      env: { VALIDATION: "failed", HIDE_DETAILS: "true" },
    });
    expect(r.exitCode).toBe(0);
    expect(r.body).not.toContain("\u0000");
    expect(Buffer.byteLength(r.body, "utf-8")).toBeLessThan(65536);
    expect(r.body).toContain("validation diagnostic sentinel line");
    expect(r.body).not.toContain("hard-truncated");
    expect(r.merged).toBe(false);
  });

  test("a huge capture is excerpted from a bounded prefix, not decoded whole", () => {
    // run_hidden writes the capture uncapped; only a prefix may ever be
    // read (an unbounded decode could stall or exhaust memory before the
    // reserved append).
    const capture = Buffer.concat([
      Buffer.from("validation diagnostic sentinel line\n", "utf-8"),
      Buffer.alloc(5_000_000, 0x61), // 5 MB of "a"
    ]);
    const r = run({
      temp: { "hidden-template-validation.log": capture },
      env: { VALIDATION: "failed", HIDE_DETAILS: "true" },
    });
    expect(r.exitCode).toBe(0);
    expect(Buffer.byteLength(r.body, "utf-8")).toBeLessThan(65536);
    expect(r.body).toContain("validation diagnostic sentinel line");
    expect(r.body).toContain("(truncated; reproduce validation locally");
    expect(r.merged).toBe(false);
  });

  test("a pathological drift cannot starve the reserved validation section", () => {
    // Drift is target-controlled and prepended on top; unbounded it would
    // either eat the whole budget or push the validation section past the
    // end-cutting hard cap. It is bounded with its own truncation note.
    const hugeDrift = `> [!WARNING]\n> drift\n${Array.from({ length: 4000 }, (_, i) => `drift line ${i}`).join("\n")}`;
    const r = run({
      files: { DRIFT_FILE: hugeDrift },
      temp: { "hidden-template-validation.log": "validation diagnostic sentinel line\n" },
      env: { VALIDATION: "failed", HIDE_DETAILS: "true" },
    });
    expect(r.exitCode).toBe(0);
    expect(Buffer.byteLength(r.body, "utf-8")).toBeLessThan(65536);
    expect(r.body).toContain(
      "reproduce the sync locally for the full report - docs/private-repos.md",
    );
    expect(r.body).toContain("Validation failed on the updated tree");
    expect(r.body).toContain("validation diagnostic sentinel line");
    expect(r.merged).toBe(false);
  });
});
