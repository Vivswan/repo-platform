// TypeScript committers import these constants. The two refresh workflows cannot: their create-pull-request steps spell
// SYNC_IDENTITY, and tests/workflows/refresh_shape.test.ts holds them to it.

import { SYNC_BOT } from "../../../actions/shared/platform.ts";

export interface GitIdentity {
  name: string;
  email: string;
}

export const SYNC_IDENTITY: GitIdentity = {
  name: SYNC_BOT,
  email: `${SYNC_BOT}@users.noreply.github.com`,
};
