// Rules anchored on files.yml's module data: the pages token grammar.

import { type Mismatch, mustMatch, setMismatch } from "./comparison.ts";
import { modules, read } from "./inputs.ts";
import type { Rule } from "./rule_roster.ts";

/** The rules this module contributes to the checker's run (check_ssot.ts). */
export const moduleRules: Rule[] = [
  {
    // reusable-pages.yml's hand-written token grammar against the modules
    // declaring pages commands in files.yml: the workflow's case arm is the
    // one independently-authored copy of the token set the plan resolves.
    name: "pages-grammar",
    run: () => {
      const reference = modules()
        .filter((m) => m.pages !== undefined)
        .map((m) => m.name)
        .concat("none");
      const pages = read(".github/workflows/reusable-pages.yml");
      // Anchor on the token-validation case block: the workflow has other
      // case statements whose arms fit the same shape.
      const tokenCase = mustMatch(
        pages,
        /case "\$tool" in([\s\S]*?)esac/,
        "reusable-pages.yml",
        "token case block",
      )[1];
      const arm = mustMatch(
        tokenCase,
        /^\s*((?:[a-z]+\|)+[a-z]+)\) ;;$/m,
        "reusable-pages.yml",
        "setup case arm",
      )[1];
      const mismatches: Mismatch[] = setMismatch(
        ".github/workflows/reusable-pages.yml setup tokens",
        reference,
        arm.split("|"),
      );
      return mismatches;
    },
  },
];
