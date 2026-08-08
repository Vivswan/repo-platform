// Boundary validation for external JSON (gh api responses, files handed
// between jobs): a malformed payload fails right here with a shape
// diagnosis instead of a confusing TypeError later. The diagnosis names
// paths and issue codes only - never received values, which can be
// target-derived (hide-details discipline).

import type { ZodType } from "zod";

export function parseWith<T>(schema: ZodType<T>, data: unknown, label: string): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`)
      .join("; ");
    console.log(`::error::${label}: unexpected shape - ${issues}`);
    process.exit(1);
  }
  return result.data;
}
