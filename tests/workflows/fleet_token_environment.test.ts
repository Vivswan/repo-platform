// The fleet PAT lives in the `fleet-operator` environment (main only, .github/settings.local.yml), so only a job that
// declares the environment reads it. GitHub does not fail a job that names a secret it cannot see: the read is the
// empty string, so the job's first read of the secret is the guard step that turns an empty read red.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ContextAccess, type Expr, IndexAccess, Literal } from "@actions/expressions/ast";
import { parse as parseYaml } from "yaml";
import {
  FLEET_ENVIRONMENT as ENVIRONMENT,
  FLEET_SECRET as SECRET,
} from "../../.github/scripts/fleet/require_fleet_token.ts";
import { parseExpression, subexpressions } from "../shared/github_expression.ts";

const root = join(import.meta.dir, "../..");
const workflowsDir = ".github/workflows";
const GUARD_STEP = {
  name: "Require the fleet token",
  env: { PAT: `\${{ secrets.${SECRET} }}` },
  run: "bun .github/scripts/fleet/require_fleet_token.ts",
};

interface Job {
  environment?: unknown;
  uses?: string;
  secrets?: unknown;
  steps?: unknown[];
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

/** Every string in the node, keys included, depth first. */
function strings(node: unknown): string[] {
  if (typeof node === "string") {
    return [node];
  }

  if (typeof node === "object" && node !== null) {
    return Object.entries(node).flatMap(([key, value]) => [key, ...strings(value)]);
  }

  return [];
}

function isSecretsContext(expr: Expr): boolean {
  return expr instanceof ContextAccess && expr.name.lexeme.toLowerCase() === "secrets";
}

/** Whether the expression reads the secret: `secrets.<name>` by dot or literal bracket, in any case (Actions ignores
 *  it). Fails closed: a read of `secrets` under no literal key (`toJSON(secrets)`, `secrets[inputs.name]`) counts as
 *  this one. */
function readsSecretIn(expr: Expr): boolean {
  if (expr instanceof IndexAccess && isSecretsContext(expr.expr)) {
    const key = expr.index instanceof Literal ? expr.index.literal.coerceString() : null;
    return key === null || key.toUpperCase() === SECRET;
  }

  return isSecretsContext(expr) || subexpressions(expr).some(readsSecretIn);
}

/** Whether a `${{ }}` expression anywhere in the nodes reads the secret, as the runner parses it: a `'secrets.X'`
 *  inside a string literal is text. A workflow-level `env` is every job's. */
function readsSecret(...nodes: unknown[]): boolean {
  return strings(nodes)
    .flatMap((text) => [...text.matchAll(/\$\{\{([\s\S]*?)\}\}/g)].map(([, source]) => source))
    .some((source) => readsSecretIn(parseExpression(source).tree));
}

// The reader is GitHub's own parser, so `'secrets.X'` inside a string literal is text, not a read, and a read of
// `secrets` under a key the expression computes, or under none, fails closed.
describe("readsSecret", () => {
  test.each<[string, boolean]>([
    [`\${{ format('secrets.${SECRET}') }}`, false],
    [`\${{ secrets.${SECRET} }}`, true],
    [`\${{ secrets['${SECRET.toLowerCase()}'] }}`, true],
    ["${{ secrets.GITHUB_TOKEN }}", false],
    ["${{ toJSON(secrets) }}", true],
    ["${{ secrets[inputs.name] }}", true],
    [`\${{ github.ref }} \${{ secrets.${SECRET} }}`, true],
  ])("%s reads it: %p", (text, expected) => {
    expect(readsSecret({ env: { X: text } })).toBe(expected);
  });
});

describe(`the ${SECRET} readers`, () => {
  const readers = workflows.flatMap(({ rel, doc }) =>
    Object.entries(doc.jobs)
      .filter(([, job]) => readsSecret(doc.env, job))
      .map(([id, job]) => ({ site: `${rel} job ${id}`, job, workflowEnv: doc.env })),
  );

  test(`every job reading the secret declares environment: ${ENVIRONMENT}`, () => {
    expect(readers.length).toBeGreaterThan(0);
    const undeclared = readers.filter(({ job }) => job.environment !== ENVIRONMENT);
    expect(undeclared.map(({ site }) => site)).toEqual([]);
  });

  // An earlier reader would clone, probe, or push as nobody; a conditional guard is no guard. A read outside `steps`
  // (a workflow or job `env`, a `container` or `services` env) reaches the job before the guard runs.
  test("every reader's first step reading the secret is the unconditional guard step", () => {
    const enclosing = readers.filter(({ job: { steps, ...rest }, workflowEnv }) =>
      readsSecret(workflowEnv, rest),
    );
    expect(enclosing.map(({ site }) => site)).toEqual([]);
    const firsts = readers.map(({ site, job }) => ({
      site,
      step: job.steps?.find((step) => readsSecret(step)),
    }));
    expect(firsts).toEqual(readers.map(({ site }) => ({ site, step: GUARD_STEP })));
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
      if (doc === undefined || seen.has(rel)) {
        return false;
      }
      seen.add(rel);
      return Object.values(doc.jobs).some(
        (job) =>
          job.environment === ENVIRONMENT ||
          (job.uses?.startsWith("$/") === true && reachesEnvironment(job.uses.slice(2), seen)),
      );
    };
    const calls = workflows.flatMap(({ rel, doc }) =>
      Object.entries(doc.jobs)
        .filter(([, job]) => job.uses !== undefined)
        .map(([id, job]) => ({
          site: `${rel} job ${id}`,
          secrets: job.secrets,
          needsInherit:
            job.uses?.startsWith("$/") === true && reachesEnvironment(job.uses.slice(2)),
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
