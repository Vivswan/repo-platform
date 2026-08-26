// Compile-time regression fixture - never imported, never run. MergedValue
// deliberately admits NO null: hardening strips every null before the
// merge, and an apply handed one would crash the action. tests/ sit
// outside the root tsconfig's include, so a widening of MergedValue would
// be invisible to `bun x tsc -p .` without this file - here, the
// expect-error directive below goes UNUSED the moment null becomes
// assignable, and tsc fails with TS2578 exactly where the regression
// landed.

import type { MergedValue } from "./settings_document.ts";

// @ts-expect-error MergedValue must never admit null
const bad: MergedValue = null;
void bad;
