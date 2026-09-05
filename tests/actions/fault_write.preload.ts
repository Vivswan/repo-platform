// A bun --preload for the stamp hook's rollback tests: the FIRST
// writeFileSync to the path in FAULT_WRITE_PATH truncates the file, then
// throws EIO - the half-written state a real write can leave; later writes
// to it (the rollback's restore) succeed. require(), not import: the
// module object is what the hook's named import reads at call time, and an
// ESM namespace is read-only.
const fs = require("node:fs");
const real = fs.writeFileSync;
const target = process.env.FAULT_WRITE_PATH ?? "";
let armed = target !== "";
fs.writeFileSync = (path: unknown, data: unknown, options?: unknown) => {
  if (armed && String(path) === target) {
    armed = false;
    real(path, "");
    const err = new Error(`EIO: injected write failure on ${target}`) as NodeJS.ErrnoException;
    err.code = "EIO";
    throw err;
  }
  return real(path, data, options);
};
