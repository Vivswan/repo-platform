// TypeScript committers import these constants. The two refresh workflows cannot: their create-pull-request step spells
// SYNC_IDENTITY, and the pins-and-identities rule (scripts/check/ssot/literal_anchors.ts) holds every such step to it.

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
