#!/usr/bin/env bun
// Runs before the install and with an empty environment, so node builtins only and the paths as arguments. A path that
// cannot be removed throws, which fails the step; a path that does not exist is already clear.

import { rmSync } from "node:fs";

const paths = process.argv.slice(2);
if (paths.length !== 3 || paths.includes("")) {
  throw new Error("usage: clear.ts <scratch dir> <verdict file> <comment file>");
}
for (const path of paths) rmSync(path, { recursive: true, force: true });
