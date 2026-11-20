#!/usr/bin/env bun

// ci.yml's actionlint job runs this in each written tree: the actionlint on PATH, with the ignores the action passes.

import { IGNORE_ARGS } from "../../../actions/actionlint/actionlint.ts";
import { must } from "../shared/proc.ts";

must(["actionlint", "-color", ...IGNORE_ARGS]);
