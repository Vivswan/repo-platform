// The label-preflight invocation grammar and the rule pinning the
// fail-closed preflight's landed shape in settings-repos.yml.

import { parse as parseYaml } from "yaml";
import { firstDiff, type Mismatch } from "./comparison.ts";
import { asRecord, read } from "./inputs.ts";
import type { Rule } from "./rule_roster.ts";

/** The preflight script's path stem, the token the invocation grammar
 *  and the settings-label-preflight rule key on. */
export const PREFLIGHT_SCRIPT = "fleet/label_preflight.ts";

/** A run block's executable shell command segments: heredoc BODIES dropped
 *  (text fed to a command, not commands), continuations joined, then one
 *  quote-aware split at unquoted newlines, `;`, `&&`, `||`, with an unquoted
 *  word-start `#` commenting out its line. Text inside quotes stays segment
 *  text, so quoted data can neither split into a phantom command nor
 *  truncate a real one. Still textual, not a shell: `$(...)`, quotes spanning
 *  lines, and a `<<` inside a quoted string are not modeled, and each degrades
 *  toward dropped lines (a FALSE MISMATCH), never toward reading data as a command. */
export function shellSegments(run: string): string[] {
  // Pass 1, line-wise: every heredoc opener on a non-comment line
  // queues its terminator (POSIX order for multiple heredocs on one
  // line); body lines are dropped until each closes - at an EXACT
  // terminator line for <<WORD (an indented look-alike is still body),
  // with leading TABS stripped for <<-WORD. Bare delimiters are any
  // unquoted-word characters, not just \w; quoted and backslashed
  // spellings are covered.
  const lines: string[] = [];
  const pending: { terminator: string; dashed: boolean }[] = [];
  for (const line of run.split("\n")) {
    if (pending.length > 0) {
      const head = pending[0];
      if ((head.dashed ? line.replace(/^\t+/, "") : line) === head.terminator) pending.shift();
      continue;
    }
    if (!line.trimStart().startsWith("#")) {
      const opener = /<<(-?)\s*(?:"([^"]+)"|'([^']+)'|\\?([^\s;&|<>()'"\\]+))/g;
      for (const match of line.matchAll(opener)) {
        pending.push({ terminator: match[2] ?? match[3] ?? match[4], dashed: match[1] === "-" });
      }
    }
    lines.push(line);
  }
  // Pass 2: the quote-aware sweep.
  const text = lines.join("\n").replaceAll("\\\n", " ");
  const segments: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote !== null) {
      if (quote === '"' && ch === "\\" && i + 1 < text.length) {
        current += ch + text[++i];
        continue;
      }
      if (ch === quote) quote = null;
      current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "\\" && i + 1 < text.length) {
      current += ch + text[++i];
      continue;
    }
    if (ch === "\n" || ch === ";") {
      segments.push(current);
      current = "";
      continue;
    }
    if ((ch === "&" && text[i + 1] === "&") || (ch === "|" && text[i + 1] === "|")) {
      segments.push(current);
      current = "";
      i++;
      continue;
    }
    if (ch === "#" && (current === "" || /\s$/.test(current))) {
      while (i + 1 < text.length && text[i + 1] !== "\n") i++;
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments.filter((segment) => segment.trim() !== "");
}

/** How a segment RUNS the preflight at command position: 'direct' (`bun
 *  <...>fleet/label_preflight.ts` opens the segment), 'hidden' (the command
 *  run_hidden.ts executes after one closed double-quoted capture-name
 *  argument and `--`, anchored so text INSIDE the quoted label never reads
 *  as the wrapped command), or null for everything else (an echoed or
 *  argument-position token, a quoted path, an inline `VAR=x bun` prefix), so
 *  a spoof fails the invocation count loudly. EXECUTION is not proven here:
 *  `false && bun ...` and `|| true` pass the grammar; the run byte pin owns those. */
export function preflightInvocation(segment: string): "direct" | "hidden" | null {
  // The path stems carry a path-segment boundary: a stem glued to ANY
  // preceding non-separator character (not-sync/, my.fleet/) is a
  // DIFFERENT tree's file merely ending in the expected name, which
  // must not read as the wrapper or the script - only a fresh token or
  // a parent directory's `/` may precede the stem.
  const direct = /^\s*bun\s+\S*?(?<![^\s/])fleet\/label_preflight\.ts(?=\s|$)/;
  const hidden =
    /^\s*bun\s+\S*?(?<![^\s/])sync\/run_hidden\.ts\s+"[^"]*"\s+--\s+bun\s+\S*?(?<![^\s/])fleet\/label_preflight\.ts(?=\s|$)/;
  if (hidden.test(segment)) return "hidden";
  if (direct.test(segment)) return "direct";
  return null;
}

/** An invocation segment's argument text, whitespace-normalized - the
 *  shape the settings-label-preflight rule's argument allowlist
 *  compares exactly, so an extra, missing, drifted, or repeated flag
 *  is visible rather than merely "present". */
export function preflightArgs(segment: string): string {
  return segment
    .slice(segment.indexOf(PREFLIGHT_SCRIPT) + PREFLIGHT_SCRIPT.length)
    .replace(/\s+/g, " ")
    .trim();
}

/** Lenient mapping view of parsed YAML for the preflight judge; a
 *  non-mapping reads as empty, so shape checks mismatch instead of
 *  throwing on malformed steps. */
function asMapping(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The terminal backstop: each preflight step's run block, byte-for-byte.
 *  The invocation grammar names WHICH facet drifted for ordinary edits, but
 *  a textual parser cannot prove EXECUTION, and each reviewer-built smuggle
 *  (heredoc bodies, quoted-label text, quoted-data splits, exotic delimiters)
 *  needed another refinement; this pin ends the class: ANY deviation
 *  mismatches, and a deliberate edit updates this constant in the same
 *  change. Exported so the suite can prove each comparison fires. */
export const PREFLIGHT_EXPECTED_RUN: Record<string, string> = {
  ".github/workflows/settings-repos.yml":
    'if [ "$TARGET" = "$GITHUB_REPOSITORY" ]; then\n' +
    '  bun .github/scripts/sync/run_hidden.ts "settings labels" -- \\\n' +
    "    bun .github/scripts/fleet/label_preflight.ts \\\n" +
    '    --merged "$RUNNER_TEMP/merged-settings.yml" \\\n' +
    '    --repo "$TARGET" --target-dir . --mode "$MODE"\n' +
    "else\n" +
    '  bun .github/scripts/sync/run_hidden.ts "settings labels" -- \\\n' +
    "    bun .github/scripts/fleet/label_preflight.ts \\\n" +
    '    --merged "$RUNNER_TEMP/merged-settings.yml" \\\n' +
    '    --repo "$TARGET" --ref "${{ steps.render.outputs.ref }}" --mode "$MODE"\n' +
    "fi\n",
};

// The exact argument lists the invocations may carry, whitespace-
// normalized: an ALLOWLIST, not a presence test. label_preflight.ts
// stands down or re-scopes on flags a presence test would never look
// at (--sections, --target-dir, a repeated --mode's last value wins),
// so anything but an exact match is a stood-down guard. The multiset
// also pins the COUNT: a gutted if/else branch is a missing
// invocation, not a surviving step.
const PREFLIGHT_EXPECTED_ARGS: Record<string, string[]> = {
  ".github/workflows/settings-repos.yml": [
    '--merged "$RUNNER_TEMP/merged-settings.yml" --repo "$TARGET" --target-dir . --mode "$MODE"',
    '--merged "$RUNNER_TEMP/merged-settings.yml" --repo "$TARGET" --ref "${{ steps.render.outputs.ref }}" --mode "$MODE"',
  ],
};

/** One apply input's expectation in the census below: mirrored from a
 *  preflight env var AND pinned to one expected expression (text parity alone
 *  is not enough: the same expression string can EVALUATE differently in a
 *  run step's env and a uses step's with, e.g. via github.action, so both
 *  sides must carry the one context-stable expression), a fixed literal, or
 *  presence-only because another rule owns the value (re-pinning it here
 *  would double-report one edit). */
export type ApplyWithExpectation =
  | { parity: string; value: string }
  | { literal: string }
  | { pinnedElsewhere: true };

// The COMPLETE census of each apply step's with: inputs. Every input mirrors
// a preflight env var (the guard must judge under exactly the configuration
// the apply runs with, both sides pinned to one context-stable expression),
// is a fixed literal, or is value-pinned by another rule; a key outside the
// census fails outright, which is what makes the mirrored-input class
// CLOSED. The parity env names double as the preflight's env-key ALLOWLIST:
// an env var outside the census (BASH_ENV) can inject execution the run pin
// cannot see. Exported so the suite can mutation-test every entry.
export const PREFLIGHT_APPLY_WITH: Record<string, Record<string, ApplyWithExpectation>> = {
  ".github/workflows/settings-repos.yml": {
    token: { parity: "GH_TOKEN", value: "${{ secrets.REPO_PLATFORM_TOKEN }}" },
    mode: { parity: "MODE", value: "${{ inputs.check_only && 'check' || 'apply' }}" },
    repository: { parity: "TARGET", value: "${{ steps.resolve.outputs.repo }}" },
    "settings-file": { pinnedElsewhere: true },
    "private-repos": { literal: "redact" },
    "private-report": { literal: "issue" },
    "on-missing-permission": { literal: "fail" },
  },
};

/** The mirrored env names per file - the preflight's env-key allowlist. */
function preflightParityEnvNames(rel: string): Set<string> {
  return new Set(
    Object.values(PREFLIGHT_APPLY_WITH[rel]).flatMap((expectation) =>
      "parity" in expectation ? [expectation.parity] : [],
    ),
  );
}

// Job-level env keys the apply job may carry (workflow-level env is
// rejected outright): a job or workflow env var reaches the preflight's
// shell exactly like a step one, so BASH_ENV smuggled one level up is
// the same injection the step-level allowlist closes.
export const PREFLIGHT_JOB_ENV_KEYS: Record<string, ReadonlySet<string>> = {
  ".github/workflows/settings-repos.yml": new Set(["HIDE_DETAILS", "SETTINGS_REPORT_TITLE"]),
};

// The job-level EXECUTION-CONTEXT census, a rule rather than an accepted
// residual because the class is in-file and closable: `container:` re-homes
// every step into an image whose env and PATH arrive underneath the env
// allowlists' sight, `services:` attaches containers, and runner keys keep
// being added, so the apply job's keys are ALLOWLISTED rather than
// enumerated as hazards, with runs-on value-pinned to the hosted runner the
// byte-pinned run blocks assume. `defaults:` is absent here because its
// dedicated check owns it; `env:` is a KEY here, PREFLIGHT_JOB_ENV_KEYS judges its content.
export const PREFLIGHT_APPLY_JOB_KEYS: Record<string, ReadonlySet<string>> = {
  ".github/workflows/settings-repos.yml": new Set([
    "name",
    "needs",
    "if",
    "strategy",
    "env",
    "runs-on",
    "timeout-minutes",
    "steps",
  ]),
};

/** The one hosted runner the apply job may request. */
export const PREFLIGHT_APPLY_RUNS_ON = "ubuntu-latest";

// The persisted-environment class: a PRIOR step can write `BASH_ENV=<hook>
// >> $GITHUB_ENV` (bash sources the hook before the pinned run block, and an
// `exit 0` there skips the guard green) or prepend a counterfeit bun via
// GITHUB_PATH. No landed apply-job step touches these, so ANY mention in a
// run block mismatches. Recorded residuals: the called scripts are this
// repo's own CI-gated code (the trust boundary is the WORKFLOW FILE), and the
// scan catches LITERAL spellings; an obfuscated write is adversarial code in
// a reviewed file, outside any textual rule's reach, and stays review's.
export const PREFLIGHT_FORBIDDEN_RUN_TOKENS = ["GITHUB_ENV", "BASH_ENV", "GITHUB_PATH"] as const;

// The steps strictly BETWEEN the preflight and the apply, byte-pinned
// like the run block itself: the guard's verdict is only as good as
// the merged document staying untouched until the apply reads it, so
// the gap is part of the guarded shape (an intervening step could
// rewrite $RUNNER_TEMP/merged-settings.yml after validation). The
// gap is exactly the stood-down notice settings-hidden-step-notices
// requires.
const PREFLIGHT_GAP_STEPS: Record<string, { if: string; run: string }[]> = {
  ".github/workflows/settings-repos.yml": [
    {
      if: "steps.labels.outputs.not_applicable == 'true'",
      run: 'echo "::notice::label preflight stood down for ${{ matrix.repo }}: ${{ steps.labels.outputs.reason }}"\n',
    },
  ],
};

// Step keys the preflight may carry - an ALLOWLIST, because the
// reroute class is open-ended: `shell: true {0}` runs `true <script>`
// (the script never executes), and working-directory:,
// continue-on-error:, or a future runner key softens or reroutes the
// guard the same way while the byte-pinned run block reads intact.
export const PREFLIGHT_STEP_KEYS: Record<string, ReadonlySet<string>> = {
  ".github/workflows/settings-repos.yml": new Set(["name", "id", "if", "env", "run"]),
};

/** The whole per-job judgment for the settings-label-preflight rule,
 *  pure over a parsed job (and its workflow document, for the
 *  inherited-state checks) so the suite can prove every comparison
 *  fires on a synthetic mutation (the live-file mutations cannot
 *  isolate them). Returns the number of settings-apply steps seen (the
 *  rule's anchor count) alongside the mismatches. */
export function labelPreflightJobMismatches(
  rel: string,
  jobName: string,
  job: Record<string, unknown>,
  workflow: Record<string, unknown> = {},
): { applies: number; mismatches: Mismatch[] } {
  if (!(rel in PREFLIGHT_EXPECTED_RUN)) {
    throw new Error(`labelPreflightJobMismatches: no pinned preflight shape for ${rel}`);
  }
  const mismatches: Mismatch[] = [];
  const raw = job.steps;
  if (!Array.isArray(raw)) return { applies: 0, mismatches };
  const steps = raw.map(asMapping);
  const applyAts = steps.flatMap((step, index) =>
    String(step.uses ?? "").includes("github-settings-as-code") ? [index] : [],
  );
  if (applyAts.length === 0) return { applies: 0, mismatches };
  // Exactly ONE apply step: the gap pin below guards the stretch from
  // the preflight to THE apply, and a second invocation of the settings
  // action would sit outside that guarded stretch by construction.
  if (applyAts.length > 1) {
    mismatches.push({
      file: rel,
      expected: `exactly one settings apply step in job '${jobName}'`,
      got: `${applyAts.length} steps use the action - a second apply escapes the pinned preflight-to-apply gap`,
    });
  }
  // Inherited execution state: a workflow- or job-level defaults.run
  // reroutes every run step exactly like a step-level shell:, and a
  // workflow/job env var (BASH_ENV) injects like a step one - the
  // step-level allowlists alone would miss both.
  if ("defaults" in workflow) {
    mismatches.push({
      file: rel,
      expected:
        "no workflow-level defaults: (a defaults.run shell or working-directory reroutes every run step around the byte-pinned run block)",
      got: "a defaults: key on the workflow",
    });
  }
  const workflowEnvKeys = Object.keys(asMapping(workflow.env));
  if (workflowEnvKeys.length > 0) {
    mismatches.push({
      file: rel,
      expected:
        "no workflow-level env: (a workflow env var - BASH_ENV - reaches the preflight's shell like a step one)",
      got: `workflow env key(s) '${workflowEnvKeys.join("', '")}'`,
    });
  }
  if ("defaults" in job) {
    mismatches.push({
      file: rel,
      expected: `no defaults: on job '${jobName}' (a job-level shell or working-directory reroutes every run step around the byte-pinned run block)`,
      got: "a defaults: key on the job",
    });
  }
  for (const key of Object.keys(asMapping(job.env))) {
    if (!PREFLIGHT_JOB_ENV_KEYS[rel].has(key)) {
      mismatches.push({
        file: rel,
        expected:
          `only the pinned job-level env keys [${[...PREFLIGHT_JOB_ENV_KEYS[rel]].join(", ")}] on ` +
          `job '${jobName}' - a job env var (BASH_ENV) reaches the preflight's shell like a step one`,
        got: `job env key '${key}'`,
      });
    }
  }
  for (const key of Object.keys(job)) {
    if (key === "defaults") continue; // the dedicated defaults check above owns it
    if (!PREFLIGHT_APPLY_JOB_KEYS[rel].has(key)) {
      mismatches.push({
        file: rel,
        expected:
          `only the pinned job keys [${[...PREFLIGHT_APPLY_JOB_KEYS[rel]].join(", ")}] on job ` +
          `'${jobName}' - any other key (container:, services:, a future runner key) re-homes ` +
          "the execution context underneath every step-level pin",
        got: `job key '${key}'`,
      });
    }
  }
  const runsOn = String(job["runs-on"] ?? "").trim();
  if (runsOn !== PREFLIGHT_APPLY_RUNS_ON) {
    mismatches.push({
      file: rel,
      expected:
        `runs-on: ${PREFLIGHT_APPLY_RUNS_ON} on job '${jobName}' (the pinned hosted runner - a ` +
        "self-hosted label is a different machine wearing the same workflow text)",
      got: runsOn === "" ? "no runs-on" : `runs-on: ${runsOn}`,
    });
  }
  for (const [index, step] of steps.entries()) {
    const runText = String(step.run ?? "");
    for (const token of PREFLIGHT_FORBIDDEN_RUN_TOKENS) {
      if (runText.includes(token)) {
        mismatches.push({
          file: rel,
          expected:
            `no ${token} in any run block of job '${jobName}' (persisted environment poisons later ` +
            "steps: a BASH_ENV hook or a counterfeit PATH entry reroutes the guard while its pinned run block reads intact)",
          got: `step ${index + 1} ('${String(step.name ?? step.id ?? "unnamed")}') mentions ${token}`,
        });
      }
    }
  }
  const segments = (step: Record<string, unknown>): string[] =>
    shellSegments(String(step.run ?? ""));
  const invokes = (segment: string) => preflightInvocation(segment) !== null;
  const preflightAts = steps.flatMap((step, index) =>
    segments(step).some(invokes) ? [index] : [],
  );
  if (preflightAts.length === 0) {
    const mentioned = steps.some((step) => String(step.run ?? "").includes(PREFLIGHT_SCRIPT));
    mismatches.push({
      file: rel,
      expected: `a fleet/label_preflight.ts step in job '${jobName}' before its settings apply`,
      got: mentioned
        ? "a mention, but no recognized command-position invocation - an unexpected invocation form does not satisfy the pin; use the landed shape"
        : "no such step - the apply would delete labels the target still references, unchecked",
    });
    return { applies: applyAts.length, mismatches };
  }
  if (preflightAts.length > 1) {
    mismatches.push({
      file: rel,
      expected: `exactly one label-preflight step in job '${jobName}'`,
      got: `${preflightAts.length} steps invoke it - a second site escapes the pinned guard shape`,
    });
  }
  const preflight = steps[preflightAts[0]];
  const preflightIf = String(preflight.if ?? "").trim();
  const preflightEnv = asMapping(preflight.env);
  const invocations = segments(preflight).filter(invokes);
  // The gap between the preflight and the apply is part of the guarded
  // shape: the verdict is only as good as the merged document staying
  // untouched until the apply reads it.
  const firstApply = Math.min(...applyAts);
  if (preflightAts[0] < firstApply) {
    const gap = steps.slice(preflightAts[0] + 1, firstApply);
    const expectedGap = PREFLIGHT_GAP_STEPS[rel];
    if (gap.length !== expectedGap.length) {
      mismatches.push({
        file: rel,
        expected:
          `exactly ${expectedGap.length} step(s) between the preflight and the apply (the pinned ` +
          "gap - an intervening step could rewrite the merged document after the guard validated it)",
        got: `${gap.length} step(s)`,
      });
    } else {
      gap.forEach((step, index) => {
        const pinned = expectedGap[index];
        const keys = Object.keys(step).sort().join(", ");
        if (keys !== "if, name, run") {
          mismatches.push({
            file: rel,
            expected: `gap step ${index + 1} carrying exactly the keys [if, name, run] (the pinned notice shape)`,
            got: `keys [${keys}]`,
          });
        } else if (
          String(step.if ?? "").trim() !== pinned.if ||
          String(step.run ?? "") !== pinned.run
        ) {
          mismatches.push({
            file: rel,
            expected: `gap step ${index + 1} matching the pinned stood-down notice (PREFLIGHT_GAP_STEPS: run byte-for-byte, if compared after trimming)`,
            got: "a drifted gap step",
          });
        }
      });
    }
  }
  for (const key of Object.keys(preflight)) {
    if (!PREFLIGHT_STEP_KEYS[rel].has(key)) {
      mismatches.push({
        file: rel,
        expected:
          `only the pinned step keys [${[...PREFLIGHT_STEP_KEYS[rel]].join(", ")}] on the preflight ` +
          "step - any other key (shell:, working-directory:, continue-on-error:) reroutes or softens " +
          "the guard while the byte-pinned run block reads intact",
        got: `step key '${key}'`,
      });
    }
  }
  const allowedEnv = preflightParityEnvNames(rel);
  for (const key of Object.keys(preflightEnv)) {
    if (!allowedEnv.has(key)) {
      mismatches.push({
        file: rel,
        expected:
          `only the mirrored env keys [${[...allowedEnv].join(", ")}] on the preflight step - ` +
          "an env var outside the census (BASH_ENV) can inject execution the run pin cannot see",
        got: `env key '${key}'`,
      });
    }
  }
  // EVERY apply step, like the skip-gate rule: a second invocation of
  // the settings action must not borrow the first one's guard.
  for (const applyAt of applyAts) {
    if (preflightAts[0] > applyAt) {
      mismatches.push({
        file: rel,
        expected: `the label preflight BEFORE the settings apply step (job '${jobName}')`,
        got: "the preflight runs after the apply - the deletions it exists to refuse have already happened",
      });
    }
    const applyIf = String(steps[applyAt].if ?? "").trim();
    // TEXT parity only, deliberately: this proves the guard and the apply
    // share ONE condition; the condition's VALUE is the sibling
    // settings-apply-skip-gate rule's job, so a JOINT drift fires there, and
    // re-pinning it here would double-report every legitimate edit. The split
    // is load-bearing defense in depth: retiring the sibling (its roster entry
    // makes that loud) would leave this parity satisfiable by any condition.
    if (preflightIf !== applyIf) {
      mismatches.push({
        file: rel,
        expected:
          `the label preflight's condition identical (after trimming) to the apply step's ` +
          `(${JSON.stringify(applyIf)}) - the guard must run exactly when the guarded apply runs`,
        got: preflightIf === "" ? "no condition at all" : preflightIf,
      });
    }
    const applyWith = asMapping(steps[applyAt].with);
    const census = PREFLIGHT_APPLY_WITH[rel];
    for (const key of Object.keys(applyWith)) {
      if (!(key in census)) {
        mismatches.push({
          file: rel,
          expected:
            `only the pinned apply inputs [${Object.keys(census).join(", ")}] - an input outside ` +
            "the census changes what the apply does in a way the guard cannot mirror",
          got: `with key '${key}'`,
        });
      }
    }
    for (const [key, expectation] of Object.entries(census)) {
      const withValue = String(applyWith[key] ?? "").trim();
      if ("pinnedElsewhere" in expectation) {
        if (!(key in applyWith)) {
          mismatches.push({
            file: rel,
            expected: `the apply input with.${key} present (its value is pinned by another rule)`,
            got: "no such input",
          });
        }
        continue;
      }
      if ("literal" in expectation) {
        if (withValue !== expectation.literal) {
          mismatches.push({
            file: rel,
            expected: `the apply input with.${key}: ${JSON.stringify(expectation.literal)} (the pinned census value)`,
            got: withValue === "" ? "no such input" : withValue,
          });
        }
        continue;
      }
      const envValue = String(preflightEnv[expectation.parity] ?? "").trim();
      if (withValue !== expectation.value) {
        mismatches.push({
          file: rel,
          expected:
            `the apply input with.${key}: ${JSON.stringify(expectation.value)} (the census's ` +
            "context-stable expression - text parity alone can evaluate differently between a run step's env and a uses step's with)",
          got: withValue === "" ? "no such input" : withValue,
        });
      }
      if (envValue !== expectation.value) {
        mismatches.push({
          file: rel,
          expected:
            `preflight env ${expectation.parity}: ${JSON.stringify(expectation.value)} (the same ` +
            `pinned expression the apply's with.${key} carries - the guard must judge under exactly the configuration the apply runs with)`,
          got: envValue === "" ? "no such env value" : envValue,
        });
      }
    }
  }
  const expectedArgs = [...PREFLIGHT_EXPECTED_ARGS[rel]].sort();
  const actualArgs = invocations.map(preflightArgs).sort();
  if (firstDiff(expectedArgs, actualArgs) !== -1) {
    mismatches.push({
      file: rel,
      expected:
        `exactly ${PREFLIGHT_EXPECTED_ARGS[rel].length} preflight invocation(s) carrying the pinned ` +
        `argument lists [${PREFLIGHT_EXPECTED_ARGS[rel].join("] [")}] - an extra, missing, or drifted ` +
        "flag stands the guard down at runtime while every pinned flag still reads present",
      got: actualArgs.length === 0 ? "none" : `[${actualArgs.join("] [")}]`,
    });
  }
  if (String(preflight.run ?? "") !== PREFLIGHT_EXPECTED_RUN[rel]) {
    mismatches.push({
      file: rel,
      expected:
        "the preflight step's run block byte-identical to the landed shape (the PREFLIGHT_EXPECTED_RUN pin) - " +
        "anything else is unauditable by a textual rule; a deliberate edit updates the pin in the same change",
      got: "a drifted run block",
    });
  }
  if (rel === ".github/workflows/settings-repos.yml") {
    if (invocations.some((segment) => preflightInvocation(segment) === "direct")) {
      mismatches.push({
        file: rel,
        expected:
          "every label-preflight invocation wrapped in run_hidden.ts (label names and referencing file paths are target content a hide-details log may not carry)",
        got: "an unwrapped invocation",
      });
    }
    if (String(preflight.id ?? "") !== "labels") {
      mismatches.push({
        file: rel,
        expected:
          "id: labels on the preflight step (the stood-down notice reads steps.labels.outputs.*)",
        got: preflight.id === undefined ? "no id" : `id: ${String(preflight.id)}`,
      });
    }
  }
  return { applies: applyAts.length, mismatches };
}

/** One workflow file's whole judgment: every job through
 *  labelPreflightJobMismatches, plus the anchor-lost throw - a parsed
 *  document with no settings-apply step anywhere means the rule's
 *  subject vanished, which must never pass silently. Exported so the
 *  suite can prove the throw fires on an apply-free document. */
export function labelPreflightFileMismatches(
  rel: string,
  workflow: Record<string, unknown>,
): Mismatch[] {
  const mismatches: Mismatch[] = [];
  let applies = 0;
  for (const [jobName, job] of Object.entries(asMapping(workflow.jobs))) {
    const result = labelPreflightJobMismatches(rel, jobName, asMapping(job), workflow);
    applies += result.applies;
    mismatches.push(...result.mismatches);
  }
  if (applies === 0) throw new Error(`${rel}: no github-settings-as-code step - anchor lost`);
  return mismatches;
}

/** The rules this module contributes to the checker's run (check_ssot.ts). */
export const labelPreflightRules: Rule[] = [
  {
    // Referenced-label preflight: the FAIL-CLOSED guard the apply runs before
    // github-settings-as-code's reconciliation DELETES labels. Dropping,
    // reordering, softening, or re-aiming the step is silent (the apply stays
    // green while referenced-label deletions go unchecked, or checked against
    // the WRONG repository), so the whole landed shape is pinned, down to the
    // byte-identical run block and gap: every earlier textual refinement was
    // smuggled past. labelPreflightJobMismatches is the judgment, pure over a parsed
    // job; settings-hidden-step-notices pins the notice compensating for this step's hidden output.
    name: "settings-label-preflight",
    run: () => {
      const rel = ".github/workflows/settings-repos.yml";
      return labelPreflightFileMismatches(rel, asRecord(parseYaml(read(rel)), rel));
    },
  },
];
