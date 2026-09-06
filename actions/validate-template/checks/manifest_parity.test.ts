import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MANIFEST_NAME } from "../../shared/manifest.ts";
import { loadContext } from "../context.ts";
import { checkManifestParity } from "./manifest_parity.ts";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const sha = (text: string) =>
  new Bun.CryptoHasher("sha256").update(Buffer.from(text, "latin1")).digest("hex");
const B = "<!-- BEGIN REPO-PLATFORM MANAGED -->";
const E = "<!-- END REPO-PLATFORM MANAGED -->";
const split = (begin: string, end: string, hash: string, grammar = "managed-region") =>
  `{"class": "split", "grammar": ${JSON.stringify(grammar)}, "begin": ${JSON.stringify(begin)}, "end": ${JSON.stringify(end)}, "hash": "${hash}"}`;

/** One render exercising every branch of the per-entry dispatch, in
 *  manifest order; the paths sit outside the ownership roster so the
 *  roster cross-check contributes nothing and this check's own verdicts,
 *  remedies included, are the whole list. */
function render(): string {
  const root = mkdtempSync(join(tmpdir(), "manifest-parity-"));
  roots.push(root);
  const region = `${B}\n# Notes\n${E}\n`;
  const files: Record<string, string> = {
    ".github/.copier-answers.yml": "_commit: c0ffee\n_src_path: gh:Vivswan/repo-platform\n",
    "docs/intact.md": "managed content\n",
    "docs/drifted.md": "edited content\n",
    "docs/notes.md": `preamble\n${region}tail\n`,
    "docs/broken-region.md": `${B}\n${B}\nno end\n`,
    "docs/old-grammar.md": region,
    "docs/unstamped.md": "content\n",
    "docs/starter.md": "repo-owned\n",
    "docs/legacy.md": "settings\n",
    "docs/odd.md": "content\n",
  };
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  symlinkSync("intact.md", join(root, "docs/link.md"));
  mkdirSync(join(root, "docs/dir.md"));
  const entries: Record<string, string> = {
    [MANIFEST_NAME]: '{"class": "managed", "hash": null, "commit": "c0ffee", "withheld": true}',
    "docs/intact.md": `{"class": "managed", "hash": "${sha("managed content\n")}"}`,
    "docs/drifted.md": `{"class": "managed", "hash": "${sha("original content\n")}"}`,
    "docs/notes.md": split(B, E, sha(region)),
    "docs/broken-region.md": split(B, E, sha(region)),
    "docs/old-grammar.md": split(B, E, sha(region), "tail-marker"),
    "docs/no-grammar.md": `{"class": "split", "begin": "# b", "end": "# e", "hash": "${"d".repeat(64)}"}`,
    "docs/unstamped.md": '{"class": "managed", "hash": null}',
    "docs/starter.md": `{"class": "starter", "hash": "${"a".repeat(64)}"}`,
    "docs/legacy.md": '{"class": "mergeable"}',
    "docs/odd.md": '{"class": "bespoke"}',
    "docs/short-hash.md": '{"class": "managed", "hash": "abc"}',
    "docs/link.md": `{"class": "managed", "hash": "${sha("intact.md")}"}`,
    "docs/dir.md": `{"class": "managed", "hash": "${"e".repeat(64)}"}`,
    "docs/deleted.md": `{"class": "managed", "hash": "${"f".repeat(64)}"}`,
    ".github/workflows/withheld.yml": '{"class": "managed", "hash": null, "withheld": true}',
    ".github/workflows/split-withheld.yml": `{"class": "split", "grammar": "managed-region", "begin": "# b", "end": "# e", "hash": null, "withheld": true}`,
    "docs/withheld.md": '{"class": "managed", "hash": null, "withheld": true}',
    ".github/workflows/gone-unstamped.yml": '{"class": "managed", "hash": null}',
    "docs/bad-marker.md": '{"class": "managed", "hash": null, "withheld": "yes"}',
    "docs/marked-stamped.md": `{"class": "managed", "hash": "${"f".repeat(64)}", "withheld": true}`,
    "docs/marked-starter.md": '{"class": "starter", "withheld": true}',
  };
  writeFileSync(
    join(root, MANIFEST_NAME),
    `{\n  "files": {\n${Object.entries(entries)
      .map(([path, body]) => `    ${JSON.stringify(path)}: ${body}`)
      .join(",\n")}\n  }\n}\n`,
  );
  return root;
}

describe("checkManifestParity", () => {
  test("one render walks every dispatch branch and reports exactly these verdicts", () => {
    const findings = checkManifestParity(loadContext(render(), false));
    expect(findings).toEqual([
      {
        severity: "error",
        message:
          ".github/repo-platform-manifest.json: entry '.github/repo-platform-manifest.json' carries a withheld marker outside its one shape (`true` on a hash-null managed or split entry under .github/workflows/) - the sync writes the marker only for a workflow it could not deliver; revert the entry (git history has the stamped original) or run a recovery sync (recover=recopy)",
      },
      {
        severity: "error",
        message:
          "docs/drifted.md: content does not match the sha256 recorded in .github/repo-platform-manifest.json - the file drifted from the last stamped sync state; local edits to a managed file are replaced by the next template sync (move them to a repo-owned location), and intended template-side updates restamp on that sync",
      },
      {
        severity: "error",
        message:
          "docs/broken-region.md: the managed-region marker lines ('<!-- BEGIN REPO-PLATFORM MANAGED -->' ... '<!-- END REPO-PLATFORM MANAGED -->') recorded in .github/repo-platform-manifest.json are missing, duplicated, or out of order in the file, so managed-region parity cannot be verified - restore the single marker pair or run a template sync",
      },
      {
        severity: "error",
        message:
          ".github/repo-platform-manifest.json: entry 'docs/old-grammar.md' declares split grammar \"tail-marker\", which this validator does not read (one grammar exists: managed-region) - the manifest predates this validator; run a template sync to restamp it",
      },
      {
        severity: "error",
        message:
          ".github/repo-platform-manifest.json: entry 'docs/no-grammar.md' lacks the split grammar field every render stamps - a hand edit, and sync baselines manifest edits instead of healing them; revert the entry (git history has the stamped original) or run a recovery sync (recover=recopy)",
      },
      {
        severity: "error",
        message:
          "docs/unstamped.md: .github/repo-platform-manifest.json records no hash for it (unstamped) - the render's stamp hook did not run; run a template sync (or bun stamp_manifest.ts from the build branch) to stamp it",
      },
      {
        severity: "error",
        message:
          ".github/repo-platform-manifest.json: entry 'docs/starter.md' is a starter carrying a hash - starters are repo-owned after the first render, so sync makes no byte-parity promise about them; run a template sync to regenerate the manifest",
      },
      {
        severity: "error",
        message:
          ".github/repo-platform-manifest.json: entry 'docs/legacy.md' has class \"mergeable\", which is retired - the next template sync re-renders the manifest (settings.yml became a repo-owned starter)",
      },
      {
        severity: "error",
        message:
          ".github/repo-platform-manifest.json: entry 'docs/odd.md' has unknown class \"bespoke\" (expected managed, split, or starter); run a template sync to regenerate the manifest",
      },
      {
        severity: "error",
        message:
          ".github/repo-platform-manifest.json: entry 'docs/short-hash.md': hash must be null or a lowercase sha256 hex digest; run a template sync to regenerate and restamp the manifest",
      },
      {
        severity: "error",
        message:
          "docs/dir.md: listed in .github/repo-platform-manifest.json but is neither a regular file nor a symlink; run a template sync to restore the managed render",
      },
      {
        severity: "error",
        message:
          "docs/deleted.md: listed as managed in .github/repo-platform-manifest.json but missing from the repo - a managed file deleted outside a sync; restore it from git history or run a recovery sync (recover=recopy)",
      },
      {
        severity: "advisory",
        message:
          ".github/workflows/withheld.yml: listed as managed in .github/repo-platform-manifest.json but withheld from the repo - the sync's push token lacked the Workflows scope, so it could not create the workflow file; grant Workflows read/write to the sync token and run a recovery sync (recover=recopy), which re-renders it",
      },
      {
        severity: "advisory",
        message:
          ".github/workflows/split-withheld.yml: listed as split in .github/repo-platform-manifest.json but withheld from the repo - the sync's push token lacked the Workflows scope, so it could not create the workflow file; grant Workflows read/write to the sync token and run a recovery sync (recover=recopy), which re-renders it",
      },
      {
        severity: "error",
        message:
          ".github/repo-platform-manifest.json: entry 'docs/withheld.md' carries a withheld marker outside its one shape (`true` on a hash-null managed or split entry under .github/workflows/) - the sync writes the marker only for a workflow it could not deliver; revert the entry (git history has the stamped original) or run a recovery sync (recover=recopy)",
      },
      {
        severity: "error",
        message:
          ".github/workflows/gone-unstamped.yml: listed as managed in .github/repo-platform-manifest.json but missing from the repo - a managed file deleted outside a sync; restore it from git history or run a recovery sync (recover=recopy)",
      },
      {
        severity: "error",
        message:
          ".github/repo-platform-manifest.json: entry 'docs/bad-marker.md' carries a withheld marker outside its one shape (`true` on a hash-null managed or split entry under .github/workflows/) - the sync writes the marker only for a workflow it could not deliver; revert the entry (git history has the stamped original) or run a recovery sync (recover=recopy)",
      },
      {
        severity: "error",
        message:
          ".github/repo-platform-manifest.json: entry 'docs/marked-stamped.md' carries a withheld marker outside its one shape (`true` on a hash-null managed or split entry under .github/workflows/) - the sync writes the marker only for a workflow it could not deliver; revert the entry (git history has the stamped original) or run a recovery sync (recover=recopy)",
      },
      {
        severity: "error",
        message:
          ".github/repo-platform-manifest.json: entry 'docs/marked-starter.md' carries a withheld marker outside its one shape (`true` on a hash-null managed or split entry under .github/workflows/) - the sync writes the marker only for a workflow it could not deliver; revert the entry (git history has the stamped original) or run a recovery sync (recover=recopy)",
      },
    ]);
  });
});
