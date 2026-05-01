# Task: solve issue {{ISSUE_REPO}}#{{ISSUE_NUMBER}}

**Title:** {{ISSUE_TITLE}}
**URL:** {{ISSUE_URL}}
**Branch:** {{BRANCH_NAME}} (already cut from `origin/{{DEFAULT_BRANCH}}`, deps already installed on host)

## Issue body

{{ISSUE_BODY}}

## Additional notes from the maintainer

These are free-form notes the maintainer left for this run. Treat them as **higher priority than the issue body** — they're more recent and more specific.

{{ADDITIONAL_NOTES}}

## Hard rules (do not relax)

- **Never** `git push`. Never `gh pr create`. Never run any GitHub write command.
- **Never** modify git remotes.
- The `.claude/settings.json` deny list enforces this at the harness level — don't try to work around it.

## Code-style rules (apply when writing or editing code)

- **Code is visible. Usage is up to the consumer.** No lazy auto-init in getters, no detect-and-execute coupled in one function, no cross-domain reads inside single-domain functions, no silent fallbacks, no `console.log` in library code, no barrel re-exports that hide where things live.
- **Functional core, imperative shell.** Pure functions return values; the entry point wires side effects visibly.
- **Make impossible states impossible — without branded strings.** Discriminated unions over `optional field + boolean flag` pairs; `as const` and `satisfies` for narrowing. Plain `string` for identifiers (no `string & { __brand }`).
- **No comments unless WHY is non-obvious.** Don't reference the current task or PR — that belongs in commit messages.

## Workflow

1. **Explore.** Read the issue carefully. Read the smallest set of source files and tests you need to understand the change. Don't read the whole repo.
2. **Plan.** Decide the smallest change that addresses the issue. Note alternatives you rejected and why.
3. **Implement.** Write the simplest version. Run the project's test command if there's an obvious one (`bun test`, `npm test`, `pytest`, etc.). Fix failures before continuing.
4. **Self-review.** Re-read your diff with these lenses, in this order:
   - **Correctness:** does the change actually solve the issue (vs. an adjacent problem)?
   - **Visibility:** any auto-detect-and-execute, lazy init, silent fallbacks, or hidden cross-domain reads you introduced?
   - **Type design:** any `optional + boolean flag` pair that should be a discriminated union? Any `as` casts that should be a type guard or schema parse? Any nullable chains hiding state?
   - **Comments:** any comments restating what the code does? Delete them. Any TODOs or commented-out code? Delete them.
   - **Surface area:** did you add features beyond what the issue requested? Roll those back.
5. **Apply fixes from self-review.** Iterate until clean.
6. **Commit.** One commit (or a small number of logically-grouped commits) on `{{BRANCH_NAME}}`. Concise message focused on the *why*.
7. **Output a one-line summary** of what you changed.

## Done

When the issue is fully addressed and you've committed:

<promise>COMPLETE</promise>

If you can't complete (missing context, blocked on external decisions, tests fail and you can't reasonably fix them):

<promise>BLOCKED: one-line reason</promise>
