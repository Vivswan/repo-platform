// A github.token push onto a PR leaves the new head's pull_request run held for approval (GitHub's GITHUB_TOKEN
// docs), so every source that pushes so tells the PR one notice: what it pushed, then the fact and the way out.
// The two halves meet at the first ": "; the second half is compared across the sources, and a workflow is
// judged on its wiring, so its run warning and its sticky comment can only ever say the one string.
//
//   script    -> the PUSHED_NOTICE const, one declaration by extraction; the calling workflow posts its output
//   workflow  -> the push step's NOTICE env, echoed as the warning and the `notice` output the sticky step posts

import { parse as parseYaml } from "yaml";
import { constStringValue } from "../../lib/ts_extract.ts";
import type { Mismatch } from "./comparison.ts";
import { asRecord, readSource } from "./inputs.ts";
import type { Rule } from "./rule_roster.ts";
import { STICKY_COMMENT_ACTION } from "./sticky_comments.ts";

export type NoticeKind = "script" | "workflow";

/** The first source's second half is the expected text. */
export const NOTICE_SOURCES: readonly { rel: string; kind: NoticeKind }[] = [
  { rel: "actions/dedupe-bun-lockfile/dedupe-bun-lockfile.ts", kind: "script" },
  { rel: "files/base/.github/workflows/auto-format.yml", kind: "workflow" },
];

const SEAM = ": ";
const SHAPE =
  "a notice shaped `<what was pushed> with the workflow token: <the fact and the way out>`";
export const OUTPUT_LINE = 'echo "notice=$NOTICE" >> "$GITHUB_OUTPUT"';
export const WARNING_LINE = 'echo "::warning::$NOTICE"';
export const POSTED_IF = "steps.push.outputs.notice != ''";
export const POSTED_MESSAGE = "${{ steps.push.outputs.notice }}";

type Step = Record<string, unknown>;

function lost(rel: string, detail: string): never {
  throw new Error(`${rel}: anchor for the held-run notice not found (${detail})`);
}

/** Step outputs are job-scoped, so the sticky step is judged inside the job whose push step writes `notice`. */
function pushJob(rel: string, text: string): { push: Step; steps: Step[] } {
  const jobs = asRecord(asRecord(parseYaml(text), rel).jobs, `${rel} jobs`);
  const found = Object.values(jobs).flatMap((job) => {
    const raw = asRecord(job, `${rel} job`).steps;
    const steps = Array.isArray(raw) ? raw.map((step) => asRecord(step, `${rel} step`)) : [];
    const push = steps.find((step) => step.id === "push");
    return push === undefined ? [] : [{ push, steps }];
  });
  return found.length === 1 ? found[0] : lost(rel, `${found.length} jobs with a step id push`);
}

function workflowNotice(rel: string, push: Step): string {
  const notice = asRecord(push.env ?? {}, `${rel} push step env`).NOTICE;
  return typeof notice === "string" ? notice : lost(rel, "no NOTICE env on the push step");
}

/** The push step's run and the sticky step's with are read parsed, so a re-quoted or re-wrapped copy of the text
 *  cannot stand in for the wiring. */
function wiringMismatches(rel: string, push: Step, steps: Step[]): Mismatch[] {
  const mismatches: Mismatch[] = [];
  const lines = new Set(
    String(push.run ?? "")
      .split("\n")
      .map((line) => line.trim()),
  );
  for (const line of [OUTPUT_LINE, WARNING_LINE]) {
    if (!lines.has(line)) {
      mismatches.push({
        file: rel,
        expected: `the push step running ${line}`,
        got: "no such line",
      });
    }
  }
  const sticky = steps.filter((step) =>
    String(step.uses ?? "").startsWith(`${STICKY_COMMENT_ACTION}@`),
  );
  if (sticky.length !== 1) lost(rel, `${sticky.length} sticky comment steps`);
  const [step] = sticky;
  const message = asRecord(step.with ?? {}, `${rel} sticky step with`).message;
  if (message !== POSTED_MESSAGE) {
    mismatches.push({
      file: rel,
      expected: `with.message: ${POSTED_MESSAGE}`,
      got: message === undefined ? "no message" : `with.message: ${String(message)}`,
    });
  }
  if (step.if !== POSTED_IF) {
    mismatches.push({
      file: rel,
      expected: `if: ${POSTED_IF}`,
      got: step.if === undefined ? "no if" : `if: ${String(step.if)}`,
    });
  }
  return mismatches;
}

export function heldRunNoticeMismatches(
  sources: readonly { rel: string; kind: NoticeKind; text: string }[],
): Mismatch[] {
  if (sources.length < 2) throw new Error("held-run-notice: fewer than two sources - anchor lost");
  const mismatches: Mismatch[] = [];
  let expected: string | null = null;
  for (const { rel, kind, text } of sources) {
    let notice: string;
    if (kind === "script") {
      notice = constStringValue(text, "PUSHED_NOTICE", { where: rel, what: "the held-run notice" });
    } else {
      const { push, steps } = pushJob(rel, text);
      notice = workflowNotice(rel, push);
      mismatches.push(...wiringMismatches(rel, push, steps));
    }
    const seam = notice.indexOf(SEAM);
    if (seam === -1) {
      mismatches.push({ file: rel, expected: SHAPE, got: notice });
      continue;
    }
    const fact = notice.slice(seam + SEAM.length);
    if (expected === null) expected = fact;
    else if (fact !== expected) {
      mismatches.push({ file: rel, expected: `${sources[0].rel}'s: ${expected}`, got: fact });
    }
  }
  return mismatches;
}

export const heldRunNoticeRules: Rule[] = [
  {
    name: "held-run-notice",
    run: () =>
      heldRunNoticeMismatches(
        NOTICE_SOURCES.map((source) => ({ ...source, text: readSource(source.rel) })),
      ),
  },
];
