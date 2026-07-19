# Ejecting a repository from repo-platform management

Detaching is cheap by design: managed repos degrade to normal repos, not
broken ones. Nothing at runtime depends on repo-platform except workflow
`uses:` references, which keep working as long as repo-platform exists (they
are pinned to release tags).

## Full eject

1. Delete the management metadata:

   ```bash
   git rm .copier-answers.yml .repo-platform.yml
   ```

2. Delete the sync workflow:

   ```bash
   git rm .github/workflows/template-sync.yml
   ```

3. (Optional) Inline the reusable workflows. Replace each thin caller
   (`pr-title.yml`, `auto-assign.yml`, `codeql.yml`, `pages.yml`) with a copy
   of the corresponding `reusable-*.yml` job from repo-platform, and replace
   `uses: Vivswan/repo-platform/actions/...` steps with vendored copies of
   the action scripts. Skip this if repo-platform continues to exist; the
   pinned references keep working unchanged.

4. (Optional) Strip the marker comments from `.gitignore`. The content keeps
   working either way.

5. Commit:

   ```bash
   git commit -m "chore: detach from repo-platform management"
   ```

Every remaining file (settings.yml, AGENTS.md, editorconfig, gitignore
content, CI jobs) is plain configuration that works standalone.

## Pause instead of eject

To stop receiving sync PRs without detaching, delete only
`.github/workflows/template-sync.yml` (or disable the workflow in the
Actions UI). The sync also refuses to run if `.repo-platform.yml` is
removed. Re-adding the file/workflow resumes updates.
