#!/usr/bin/env bun
// Every fleet job's first read of the PAT: GitHub hands a job that cannot see the secret the empty string, not a
// failure, and gh, git, and the settings CLI would then probe, push, or apply as nobody. The step passes the secret
// as PAT; README.md's Credentials section links the same recipe (tests/fleet/require_fleet_token.test.ts pins it).

import { PLATFORM_NAME } from "../../../actions/shared/platform.ts";
import { fail } from "../shared/gha.ts";

export const FLEET_ENVIRONMENT = "fleet-operator";
export const FLEET_SECRET = "REPO_PLATFORM_TOKEN";
const PAT_PERMISSIONS =
  "contents=write&pull_requests=write&workflows=write&administration=write&issues=write&actions=read&environments=write";
export const PAT_RECIPE_URL = `https://github.com/settings/personal-access-tokens/new?name=${FLEET_SECRET}&description=${PLATFORM_NAME}+fleet%3A+push+sync+and+central+settings&${PAT_PERMISSIONS}`;

export function requireFleetToken(env: NodeJS.ProcessEnv = process.env): string {
  const token = env.PAT ?? "";
  if (token !== "") return token;
  return fail(
    `the fleet token is not set: ${FLEET_SECRET} read as empty, and only a secret of this repository's ${FLEET_ENVIRONMENT} environment reaches this job. ` +
      `Create a fine-grained PAT with the permissions pre-selected at ${PAT_RECIPE_URL}, grant it the managed repositories, ` +
      `then store it with 'gh secret set ${FLEET_SECRET} --env ${FLEET_ENVIRONMENT}' in this repository.`,
  );
}

if (import.meta.main) requireFleetToken();
