# baywatch — agent rules

This repo is a personal agent orchestrator. **You** (Claude) may be running here in two modes:

1. As the maintainer's pair when they're editing the orchestrator itself.
2. As a spawned agent (via `@ai-hero/sandcastle` + podman) inside a target repo, working on a specific issue or PR review.

In **either** mode, the rules below are absolute. They are also enforced by `.claude/settings.json` deny rules — but treat the prose here as the source of truth and don't try to work around the harness.

## Hard rules

- **Never** create, comment on, edit, close, reopen, merge, or review a GitHub PR via `gh` or the API. The human submits PRs and reviews manually.
- **Never** create, comment on, edit, close, or otherwise modify GitHub issues via `gh` or the API.
- **Never** `git push` to any remote. Local commits only. The human pushes manually.
- **Never** modify git remotes (`git remote add/remove/set-url`).
- **Never** trigger or modify CI workflows, secrets, variables, releases, or repo settings via `gh`.
- **Never** run a `gh api` call with a write method (`POST`/`PUT`/`PATCH`/`DELETE`).

## Soft rules (escalate to the user before doing)

- Force-resetting branches (`git reset --hard`) on anything that isn't a freshly cut agent branch.
- Deleting branches.
- Deleting files outside the working area you were given.

## What's fine

- Reading anything (`gh issue view`, `gh pr view`, `gh pr diff`, `git log`, etc.).
- Cutting new branches, committing, running tests, running formatters.
- Writing review notes to `reviews/` or other local artifacts.

## Output expectations

- **Dev agent**: end with a clean local branch + commits on a fresh branch cut from `origin/<default>`. Don't push. Don't open a PR. Tell the maintainer the branch name and a one-line summary.
- **Review agent**: end with a markdown file at `reviews/<owner>__<repo>__<pr>.md` and a `submit-review.sh` next to it that the maintainer runs themselves. The script may invoke `gh pr review` — but you do not run it.
