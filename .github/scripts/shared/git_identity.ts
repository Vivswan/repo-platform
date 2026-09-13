// TypeScript committers import these constants. The two refresh workflows cannot: their create-pull-request step spells
// SYNC_IDENTITY, and the pins-and-identities rule (scripts/check/ssot/literal_anchors.ts) holds every such step to it.

import { SYNC_BOT } from "../../../actions/shared/platform.ts";

export interface GitIdentity {
  name: string;
  email: string;
}

export const SYNC_IDENTITY: GitIdentity = {
  name: SYNC_BOT,
  email: `${SYNC_BOT}@users.noreply.github.com`,
};
