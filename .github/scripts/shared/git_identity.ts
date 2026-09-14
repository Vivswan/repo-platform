// TypeScript committers import these constants. The refresh workflow cannot: its create-pull-request step spells
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
