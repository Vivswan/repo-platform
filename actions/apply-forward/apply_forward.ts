#!/usr/bin/env bun
// The contract is action.yml's description. Every answer carries its HTTP status, so a 404 (no record yet, a commit the
// repository no longer holds) is told from an outage, and the ancestry question goes to GitHub's compare.

import { appendFileSync } from "node:fs";
import { error, notice, requireEnv } from "../shared/action_runtime.ts";
import { type Answer, answerText, github } from "../shared/github.ts";

const SHA_RE = /^[0-9a-f]{40}$/;

export const recordRef = (leg: string): string => `refs/platform/applied/${leg}`;
const short = (sha: string): string => sha.slice(0, 12);

export type Verdict =
  | { proceed: boolean; recorded: string; notice: string | null }
  | { error: string };

const unexpected = (what: string, answer: Answer): string =>
  `${what} answered ${answerText(answer)}`;

/** The record's commit, null for none (a 404). */
export function judgeRecord(
  answer: Answer,
  ref: string,
): { recorded: string | null } | { error: string } {
  if (answer.status === 404) return { recorded: null };
  if (answer.status !== 200) return { error: unexpected("reading the record", answer) };
  let found: { ref?: unknown; object?: { sha?: unknown } };
  try {
    found = JSON.parse(answer.body) as typeof found;
  } catch {
    return { error: `the record is not JSON: ${answer.body}` };
  }
  const sha = found.object?.sha;
  if (found.ref !== ref || typeof sha !== "string" || !SHA_RE.test(sha)) {
    return { error: `the record names no commit: ${answer.body}` };
  }
  return { recorded: sha };
}

/** GitHub's compare status of recorded...sha, or gone for a 404: a recorded commit the repository no longer holds. */
export type Relation = "ahead" | "behind" | "identical" | "diverged" | "gone";

export function judgeCompare(answer: Answer): { relation: Relation } | { error: string } {
  if (answer.status === 404) return { relation: "gone" };
  if (answer.status !== 200) return { error: unexpected("comparing the commits", answer) };
  let status: unknown;
  try {
    status = (JSON.parse(answer.body) as { status?: unknown }).status;
  } catch {
    status = undefined;
  }
  if (
    status === "ahead" ||
    status === "behind" ||
    status === "identical" ||
    status === "diverged"
  ) {
    return { relation: status };
  }
  return { error: `the compare names no status: ${answer.body}` };
}

interface Leg {
  repository: string;
  leg: string;
  sha: string;
}

const refPath = ({ repository, leg }: Leg): string =>
  `repos/${repository}/git/ref/${recordRef(leg).slice("refs/".length)}`;

/** The record and, when it names another commit, how this one stands to it; relation null means it names this commit. */
type RecordRead =
  | { recorded: null }
  | { recorded: string; relation: Relation | null }
  | { error: string };

async function readRecord(leg: Leg): Promise<RecordRead> {
  const record = judgeRecord(await github({ path: refPath(leg) }), recordRef(leg.leg));
  if ("error" in record) return record;
  if (record.recorded === null) return { recorded: null };
  if (record.recorded === leg.sha) return { recorded: leg.sha, relation: null };
  const compared = judgeCompare(
    await github({ path: `repos/${leg.repository}/compare/${record.recorded}...${leg.sha}` }),
  );
  if ("error" in compared) return compared;
  return { recorded: record.recorded, relation: compared.relation };
}

export async function check(leg: Leg): Promise<Verdict> {
  const read = await readRecord(leg);
  if ("error" in read) return read;
  if (read.recorded === null) return { proceed: true, recorded: "", notice: null };
  const { recorded, relation } = read;
  const applied = `${leg.leg} last applied ${short(recorded)}`;
  switch (relation) {
    case null:
    case "ahead":
    case "identical":
      return { proceed: true, recorded, notice: null };
    case "behind":
      return {
        proceed: false,
        recorded,
        notice: `superseded: ${applied}, which is ahead of this run's ${short(leg.sha)}; nothing to apply here`,
      };
    case "diverged":
    case "gone":
      return {
        proceed: true,
        recorded,
        notice: `${applied}, which is off this history; applying ${short(leg.sha)}`,
      };
  }
}

/** One pass of the record: read, judge, write. A 422 is GitHub refusing the write (a newer run wrote first, so the
 *  fast-forward or the create is refused; or an invalid write) and is handed back for the caller to decide. */
async function recordOnce(leg: Leg): Promise<Verdict | { refused: Answer }> {
  const read = await readRecord(leg);
  if ("error" in read) return read;
  const { repository, sha } = leg;
  const ref = recordRef(leg.leg);
  let written: Answer;
  let moved: string | null = null;
  if (read.recorded === null) {
    written = await github({
      method: "POST",
      path: `repos/${repository}/git/refs`,
      json: { ref, sha },
    });
  } else {
    const { recorded, relation } = read;
    if (relation === null) return { proceed: true, recorded, notice: null };
    if (relation === "behind") {
      return {
        proceed: false,
        recorded,
        notice: `a newer run recorded ${short(recorded)} ahead of this run's ${short(sha)}; the record stands`,
      };
    }
    if (relation === "diverged" || relation === "gone") {
      moved = `${leg.leg}'s record ${short(recorded)} is off this history; moving it to ${short(sha)}`;
    }
    written = await github({
      method: "PATCH",
      path: `repos/${repository}/git/refs/${ref.slice("refs/".length)}`,
      json: { sha, force: moved !== null },
    });
  }
  const { status } = written;
  if (status === 200 || status === 201) return { proceed: true, recorded: sha, notice: moved };
  if (status === 422) return { refused: written };
  return { error: unexpected("writing the record", written) };
}

/** A refused write gets one more pass, which reads what stands now and judges it (a newer run's record stands, an older
 *  run's is fast-forwarded, this commit is already there); a second refusal is the error. */
export async function record(leg: Leg): Promise<Verdict> {
  const first = await recordOnce(leg);
  if (!("refused" in first)) return first;
  const second = await recordOnce(leg);
  if (!("refused" in second)) return second;
  return { error: unexpected("writing the record", second.refused) };
}

if (import.meta.main) {
  const mode = requireEnv("MODE");
  const leg: Leg = {
    repository: requireEnv("GITHUB_REPOSITORY"),
    leg: requireEnv("LEG"),
    sha: requireEnv("SHA"),
  };
  if (mode !== "check" && mode !== "record") {
    error(`mode must be check or record, not '${mode}'`);
    process.exit(2);
  }
  const verdict = mode === "check" ? await check(leg) : await record(leg);
  if ("error" in verdict) {
    error(verdict.error);
    process.exit(1);
  }
  if (verdict.notice !== null) notice(verdict.notice);
  appendFileSync(
    requireEnv("GITHUB_OUTPUT"),
    `proceed=${verdict.proceed}\nrecorded=${verdict.recorded}\n`,
  );
}
