// The fleet PAT lives in the `fleet-operator` environment (main only, .github/settings.local.yml), so only a job that
// declares the environment reads it. GitHub does not fail a job that names a secret it cannot see: the read is the
// empty string, and a `|| github.token` fallback then degrades silently.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const ENVIRONMENT = "fleet-operator";
const SECRET = "REPO_PLATFORM_TOKEN";
const root = join(import.meta.dir, "../..");
const workflowsDir = ".github/workflows";

interface Job {
  environment?: unknown;
  uses?: string;
  secrets?: unknown;
}
interface Workflow {
  on: Record<string, { secrets?: unknown } | null>;
  env?: unknown;
  jobs: Record<string, Job>;
}

const workflows = readdirSync(join(root, workflowsDir))
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => ({
    rel: `${workflowsDir}/${name}`,
    doc: parseYaml(readFileSync(join(root, workflowsDir, name), "utf8")) as Workflow,
  }));

// Fails closed: a secrets read that is not a literal OTHER name counts as this one. Actions ignores case, and a
// workflow-level `env` is every job's.
const NAMED_SECRET =
  /\bsecrets\s*(?:\.\s*([A-Za-z_][A-Za-z0-9_]*)\b|\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\])/gi;
const strings = (node: unknown): string[] =>
  typeof node === "string"
    ? [node]
    : typeof node === "object" && node !== null
      ? Object.entries(node).flatMap(([key, value]) => [key, ...strings(value)])
      : [];
const readsSecret = (job: Job, workflowEnv: unknown) =>
  strings([workflowEnv, job])
    .flatMap((text) => [...text.matchAll(/\$\{\{([\s\S]*)\}\}/g)].map(([, e]) => e))
    .some((expression) => {
      let named = false;
      const rest = expression.replace(NAMED_SECRET, (_, dot, bracket) => {
        if ((dot ?? bracket).toUpperCase() === SECRET) named = true;
        return "";
      });
      return named || /\bsecrets\b/i.test(rest);
    });

describe(`the ${SECRET} readers`, () => {
  const readers = workflows.flatMap(({ rel, doc }) =>
    Object.entries(doc.jobs)
      .filter(([, job]) => readsSecret(job, doc.env))
      .map(([id, job]) => ({ site: `${rel} job ${id}`, job })),
  );

  test(`every job reading the secret declares environment: ${ENVIRONMENT}`, () => {
    expect(readers.length).toBeGreaterThan(0);
    const undeclared = readers.filter(({ job }) => job.environment !== ENVIRONMENT);
    expect(undeclared.map(({ site }) => site)).toEqual([]);
  });

  // actions/runner#4453: a job reached through two calls reads the environment secret only when every caller on
  // the chain inherits (a called workflow inherits down only what it received). A mapped copy is the caller's empty read.
  test("a caller inherits exactly when its call reaches a job declaring the environment; none maps the secret", () => {
    const declaring = workflows
      .filter(({ doc }) =>
        Object.keys(doc.on.workflow_call?.secrets ?? {}).some(
          (name) => name.toUpperCase() === SECRET,
        ),
      )
      .map(({ rel }) => rel);
    expect(declaring).toEqual([]);
    const reachesEnvironment = (rel: string, seen = new Set<string>()): boolean => {
      const doc = workflows.find((workflow) => workflow.rel === rel)?.doc;
      if (doc === undefined || seen.has(rel)) return false;
      seen.add(rel);
      return Object.values(doc.jobs).some(
        (job) =>
          job.environment === ENVIRONMENT ||
          (job.uses?.startsWith("./") === true && reachesEnvironment(job.uses.slice(2), seen)),
      );
    };
    const calls = workflows.flatMap(({ rel, doc }) =>
      Object.entries(doc.jobs)
        .filter(([, job]) => job.uses !== undefined)
        .map(([id, job]) => ({
          site: `${rel} job ${id}`,
          secrets: job.secrets,
          needsInherit:
            job.uses?.startsWith("./") === true && reachesEnvironment(job.uses.slice(2)),
        })),
    );
    expect(calls.filter((call) => call.needsInherit).length).toBeGreaterThan(0);
    const mapping = calls.filter(({ secrets }) => secrets !== undefined && secrets !== "inherit");
    expect(mapping.map(({ site }) => site)).toEqual([]);
    const wrong = calls.filter(
      ({ secrets, needsInherit }) => (secrets === "inherit") !== needsInherit,
    );
    expect(wrong.map(({ site }) => site)).toEqual([]);
  });
});
