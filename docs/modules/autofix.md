---
order: 130
---

# Autofix

This page is the `autofix` module's guide: what a repository declares so a pull request's automated fixes are committed for it, what the hook must do, and what the push refuses.

```text
trigger               stage job (token: read)         artifact        push job (token: write)          pull request
fix-lint label   ->   checks out the head, sha S  ->  fix.patch   ->  reads the lists from main    ->  one commit on the branch
or a push that        runs YOUR hook                  report.json     checks out S, applies            one sticky notice
touches `push.on`     stages what the lists allow     (data only)     judges every path, pushes        label removed
runs:  your code (the hook, its installs)                             platform code alone, no install from the branch
```

The repository's own commands run where the token can only read. The job that can push runs none of the pull request's code: it takes a patch, judges it against lists it read from the default branch, and pushes one commit.

| Trigger          | Runs when                                                                          | A change outside the lists                           | Nothing to fix |
| ---------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------- | -------------- |
| `fix-lint` label | the label is added to a same-repository pull request; it is removed after each run | dropped and named in the notice; the rest is pushed  | one notice     |
| a push           | `autofix.push` is declared and a file the pull request changes matches `push.on`   | the whole fix is refused, red, and the path is named | no notice      |

## Set it up

1. **Select the module and declare the lists,** in `.repo-platform.yml`:

   ```yaml
   modules: [bun, autofix]
   autofix:
     label:
       paths: ["src/**", "tests/**", "docs/**", "*.ts", "*.json", "*.md"] # a fix may add or change these
     push: # optional: without it only the label runs
       on: ["src/**", "README.md"] # a pull request touching these runs the hook on every push
       paths: [README.md, "docs/reference/*.md", "src/generated/*.ts"]
       delete: [src/generated/old/] # only here may a fix delete files
   ```

2. **Fill in the hook** the sync seeds, `.github/actions/autofix/action.yml` ([below](#the-hook-githubactionsautofixactionyml)). The seed fails on purpose.

3. **Delete what it replaces:** the repository's `auto-format.yml`, any fix workflow of its own, and their scripts and tests. The sync does not remove a repo-owned file.

   A registration whose `except` names the old `auto-format.yml` workflow drops that line in the first sync pull request after the platform stopped shipping that starter, whether or not it selects this module. Before that sync the line keeps the old starter out; from it on, the sync holds on an `except` line no entry writes.

The managed `.github/workflows/auto-fix.yml` arrives with the sync. The `fix-lint` label is in every repository's settings already.

## The lists

| Key            | Meaning                                                                        |
| -------------- | ------------------------------------------------------------------------------ |
| `label.paths`  | what a fix started by the label may add or change; required                    |
| `label.delete` | what it may delete; default none                                               |
| `push.on`      | a push runs the hook when a file the pull request changes matches one of these |
| `push.paths`   | what a fix started by a push may add or change                                 |
| `push.delete`  | what it may delete; default none                                               |

- **An entry is a glob:** `*` stops at a slash, `**` crosses them and reaches dotfiles, `{a,b}` lists names. An entry ending in a slash is that directory and everything under it. A leading `!` is refused.
- **`paths: ["**"]` is allowed.** The set below is still refused.
- **Read from the default branch,** by the push job itself, at the time it pushes. A pull request that edits its own lists changes nothing until it merges.
- **Never carried, whatever the lists say:** anything under `.github/` outside `.github/scripts/`, `.repo-platform.yml`, `.gitmodules`, a symbolic link, a submodule, and a path with a control character, a backslash, or bytes that are not UTF-8.
- **`.github/scripts/` is carried when a list reaches it,** as any other path is. `**` reaches it, and so does `.github/scripts/**`:

  ```text
  path the fixer changed                paths: ["src/**"]    paths: ["**"]
  src/app.ts                            carried              carried
  .github/scripts/check.ts              left out             carried
  .GitHub/Scripts/check.ts              left out             left out: only the exact spelling opens
  .github/workflows/ci.yml              left out             left out
  .github/actions/autofix/action.yml    left out             left out
  .github/dependabot.yml                left out             left out
  ```

  A script there may later run in a workflow that holds a write token, as any code in the repository may. The fixer is the pull request's own code, run at its head, so the author could have pushed the same change by hand: autofix adds no power. It is no review guarantee: an approval given before the fix still stands.
- **A rename** is judged as a deletion and an addition.
- **A pull request changing more than 3000 files** runs the hook on every push without asking which files: GitHub lists no more than that.

## The hook: `.github/actions/autofix/action.yml`

The hook is a starter: the sync writes it once when the module is selected and never rewrites it. It is a composite action, run from the checkout in the stage job.

| Contract          | Value                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| input `event`     | `label` or `push`: what started the run, so one hook can format on one and generate on the other |
| output `findings` | optional text: what the fixer could not fix; shown in the notice                                 |
| output `subject`  | optional: the commit's subject, one Conventional Commit line                                     |
| runs as           | a step on the pull request's head commit, with a token that can only read                        |
| leaves            | the fixes in the work tree; it never commits or pushes                                           |
| a non-zero exit   | stops the fix: nothing is committed, and the job is red                                          |

**What the fixer did fix is committed even when findings remain.** A fixer that exits non-zero on leftover findings must have that exit swallowed, or it stops the fix:

```yaml
outputs:
  findings:
    description: What the fixer could not fix
    value: ${{ steps.lint.outputs.findings }}
  subject:
    description: The commit's subject
    value: "style: format with biome"

runs:
  using: composite
  steps:
    - uses: oven-sh/setup-bun@<sha> # <tag>, the pin the bun starters carry
      with:
        bun-version-file: .bun-version
    - shell: bash
      run: bun install --frozen-lockfile --ignore-scripts
    - id: lint
      shell: bash
      run: bun run lint:fix || echo "findings=the fixer left findings; the lint check lists them" >> "$GITHUB_OUTPUT"
```

- **Run the repository's own fixer,** a script or a tool resolved from its lockfile, so no tool version is spelled a second time in the hook.
- **Install without lifecycle scripts** (`--ignore-scripts`) where the repository can: the job runs the pull request's code, and the fewer scripts the better.
- **A generator** (event `push`) runs with no `||`: a failed generator must stop the fix.
- **The subject** is used, with the whitespace around it removed, when the rest is one line of at most 100 printable ASCII characters, is no workflow command (no leading `::`, no `##[`), and the [commit-names gate](../../actions/validate-commit-names/action.yml) accepts it: the push job asks the gate itself. Anything else becomes `style: apply automated fixes`.

## What the push job does and refuses

In order, the first row that matches ends the run:

| The push job finds                                            | Outcome                                                                        |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| the stage job reported a push-event change outside the lists  | refused, red; the notice names each path; nothing is committed                 |
| an empty patch                                                | no commit; the label gets "nothing to fix", a push removes its last notice     |
| a patch that does not apply to the head sha                   | failed, red; the notice says nothing was pushed                                |
| a patched path outside the lists, or in the never-carried set | the whole patch is refused, red, even on the label: the stage job was bypassed |
| the branch still at the head sha                              | one commit pushed; the notice says the new head's run waits for approval       |
| the branch moved while the fix was built                      | superseded, green, with a notice; the branch is left alone                     |
| the branch deleted while the fix was built                    | superseded, green; the notice says the branch is gone                          |
| the push rejected with the branch unmoved                     | failed, red; the notice says the branch has not moved                          |
| the push rejected and the branch unreadable                   | failed, red; the notice says the branch could not be read back                 |

- **The push is leased to the built sha:** it lands only while the branch names exactly the commit the hook ran on. A rejection is classed by reading the branch again, never by git's message.
- **The commit** is authored by `github-actions[bot]` and carries the date of the commit it fixes, so a rerun of the push job rebuilds the same commit and finds it pushed.
- **A Dependabot pull request's commit** carries `[dependabot skip]`, so Dependabot keeps rebasing the pull request.
- **Git hooks never run** in the push job, and the patch is applied to the index alone.
- **Paths, the subject, and findings are quoted** in the notice and the run summary: a code span, or a fenced block for findings, each cut to a cap. A control character and an HTML comment's opener are spelled out (`<\x21--`), so no quoted text can pass for a comment's hidden marker.
- **A dropped deletion can take an allowed change with it.** Git holds a name as a file or as a directory:

  ```text
  the fixer                          lists                               the commit       the notice names
  deletes d/f, adds a file d         paths: [d]      delete: []          neither change   d/f, and d: cannot be carried without deleting d/f
  deletes f, adds f/x                paths: ["f/x"]  delete: []          neither change   f, and f/x: cannot be carried without deleting f
  ```

## The notice

Each trigger keeps one comment of its own, so a label run and a push run on the same commit never write over each other.

| The run                                       | Its trigger's comment                                     |
| --------------------------------------------- | --------------------------------------------------------- |
| has something to say                          | replaced with the new notice                              |
| is a push with nothing to fix                 | deleted, so an earlier "Refused" does not outlive the fix |
| died before the push step could word a notice | replaced with one fixed line that points at the run's log |
| stopped in the hook, or was cancelled         | left as it was; the red run is the report                 |

## The held run

A push with the workflow token does not start the new head's `pull_request` run: GitHub holds it for approval. The notice says so. Approve the run from the merge box or the Actions tab, or push a commit. No stronger token is wired in, by design: a token that started runs would sit one job away from the pull request's own code.

A repository that declares `autofix.push` takes this cost on every fix the push makes.

## Forks, reruns, and removal

- **A fork's pull request** given the label: the label is removed with a note that forks are not fixed. That job runs on `pull_request_target`, checks nothing out, and runs no pull request code. A fork's pushes run nothing.
- **A push by Dependabot** starts its run as a fork's push does: read-only unless the workflow's `permissions` raise the token, which no real run has confirmed here. Count on the label for a Dependabot pull request: a person adds it, so its run holds the usual token.
- **The label's name** is matched without case, as GitHub matches it.
- **A rerun** is safe at every step: the label already gone, the commit already on the branch, and the notice already posted each read as done.
- **Adding the label again** cancels the older label run; a newer push cancels the older push run.
- **Removing the module** retires `auto-fix.yml`; the hook stays (a starter).
