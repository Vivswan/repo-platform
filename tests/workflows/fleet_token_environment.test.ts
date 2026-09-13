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

  test("no workflow declares the secret as a call input or passes it on a call", () => {
    // A caller job cannot declare an environment, so a passed copy is the empty string: dead plumbing.
    const declaring = workflows
      .filter(({ doc }) =>
        Object.keys(doc.on.workflow_call?.secrets ?? {}).some(
          (name) => name.toUpperCase() === SECRET,
        ),
      )
      .map(({ rel }) => rel);
    expect(declaring).toEqual([]);
    const passing = workflows.flatMap(({ rel, doc }) =>
      Object.entries(doc.jobs)
        .filter(([, job]) => job.uses !== undefined && job.secrets !== undefined)
        .map(([id]) => `${rel} job ${id}`),
    );
    expect(passing).toEqual([]);
  });
});
