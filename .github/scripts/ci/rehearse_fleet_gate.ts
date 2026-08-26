#!/usr/bin/env bun
// CI entry for ci.yml's rehearse-fleet job: the fleet rehearsal in gate
// mode (sync/rehearse_fleet.ts --gate). A separate ci/ entry because this
// is a network gate - it needs the fleet PAT and clones every public
// managed repo - so, exactly like resolve_action_refs.ts, it is CI-only
// by design and must never join package.json's offline check chain (the
// ssot local-gates rule pins every non-ci/ command in a gating job to
// that chain).

import { join } from "node:path";
import { passthrough } from "../shared/proc.ts";

process.exit(
  passthrough(["bun", join(import.meta.dir, "..", "sync", "rehearse_fleet.ts"), "--gate"]),
);
