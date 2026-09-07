// The module-manifest rules' pure helpers (scripts/check/ssot/modules.ts).

import { describe, expect, test } from "bun:test";
import { gatesOnModule } from "../../../scripts/check/ssot/modules.ts";

describe("gatesOnModule", () => {
  const script = [
    "#!/usr/bin/env bash",
    "# if has fuzzer; then a comment must never count",
    'has() { case "$mods" in *",$1,"*) return 0 ;; *) return 1 ;; esac; }',
    'if has bun; then present "## Node " /tmp/smoke/.gitignore; fi',
    "elif has pr-title; then",
    'if [ "$PRIVATE" != "true" ] && { has rust || has uv; }; then',
    "if ! has agents; then",
    "  - uses: oven-sh/setup-bun@v2",
    "echo done # has pages would be a trailing-comment spoof",
  ].join("\n");

  test.each([
    { script, module: "bun", gated: true, reason: "an if condition" },
    { script, module: "pr-title", gated: true, reason: "an elif condition" },
    { script, module: "rust", gated: true, reason: "a brace-group opener" },
    { script, module: "uv", gated: true, reason: "an || operand" },
    { script, module: "agents", gated: true, reason: "a negated form" },
    { script, module: "fuzzer", gated: false, reason: "a comment-line mention" },
    { script, module: "pages", gated: false, reason: "a trailing-comment mention" },
    {
      script: "uses: oven-sh/setup-bun@v2\nbun install",
      module: "bun",
      gated: false,
      reason: "an unrelated substring",
    },
    {
      script: "if has pr-title; then",
      module: "pr",
      gated: false,
      reason: "a prefix of a longer module name",
    },
  ])("$reason gates on '$module': $gated", ({ script: text, module, gated }) => {
    expect(gatesOnModule(text, module)).toBe(gated);
  });
});
