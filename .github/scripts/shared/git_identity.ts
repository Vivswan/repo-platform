// Every committer is a TypeScript script importing these constants; no workflow or action carries its own copy.

import { BUILD_BOT, SYNC_BOT } from "../../../actions/shared/platform.ts";

export interface GitIdentity {
  name: string;
  email: string;
}

export const SYNC_IDENTITY: GitIdentity = {
  name: SYNC_BOT,
  email: `${SYNC_BOT}@users.noreply.github.com`,
};

/** The build-branches publisher's committer, deliberately distinct from
 * the sync's: build commits on the orphan branches name their producer. */
export const BUILD_IDENTITY: GitIdentity = {
  name: BUILD_BOT,
  email: `${BUILD_BOT}@users.noreply.github.com`,
};
