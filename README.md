# baywatch

Personal agent orchestrator. Sits on top of [`@ai-hero/sandcastle`](https://github.com/mattpocock/sandcastle) and runs Claude agents locally to:

1. **Solve issues** assigned to me across many repos (dev agent).
2. **Review PRs** assigned to me, plus an explicit watchlist (review agent).

## Hard rules (do not relax without explicit instruction)

- **Never** runs `gh pr create` automatically.
- **Never** posts a GitHub review automatically.
- **Never** runs `git push origin` automatically.

The agent's output is always: a local branch, local commits, and local artifacts. Submitting to GitHub is a manual step I do myself.

## Stack

- Bun + TypeScript (strict)
- Biome 2.3 for lint/format
- `bun:sqlite` for state (`~/.baywatch/state.db`)
- `@ai-hero/sandcastle` with `podman()` sandbox + `head` branch strategy (work lands directly in your local clone on a fresh branch)
- `gh` CLI for GitHub auth + queries

## Workflow

For the **dev agent**, per assigned issue:

1. `cd` to the local clone for that repo.
2. Refuse to run if the working tree is dirty.
3. `git fetch origin`.
4. Cut a fresh branch off `origin/<default>` named `agent/issue-<num>-<slug>`.
5. Run install (`bun i` / `npm i` / `pnpm i` based on lockfile) so deps are current.
6. Hand off to sandcastle (`head` strategy + podman) to drive the agent.
7. Stop. The branch is ready for me to open in VS Code, review, and push manually.

For the **review agent**, per PR:

1. Skip if I've already reviewed at the PR's current `head_sha`.
2. Run a review agent in podman against the diff.
3. Drop `reviews/<owner>__<repo>__<pr>.md` and a `submit-review.sh` I run myself.

## Setup

```bash
bun install
bun install -g .                                  # makes `baywatch` callable from anywhere
cp .env.example .env                              # then add CLAUDE_CODE_OAUTH_TOKEN (and optionally GITHUB_TOKEN)
cp baywatch.config.example.ts baywatch.config.ts  # then point cloneRoots at your dirs
gh auth status                                    # confirm gh is authed (host-side)

# Build the shared sandbox image (one time, ~2 min).
podman machine start                              # if not already running
podman build -t baywatch-agent -f Containerfile .
```

`baywatch.config.ts` is gitignored — your real paths stay on your machine.

### Auth tokens

Two env vars matter:

- **`CLAUDE_CODE_OAUTH_TOKEN`** (required) — get with `claude setup-token`. Bills your Claude subscription rather than per-token API credits. Falls back to `ANTHROPIC_API_KEY` if you'd rather use API auth.
- **`GITHUB_TOKEN`** (optional) — fine-grained PAT with **read-only** scopes (Contents: read, Issues: read, PRs: read, Metadata: read). The agent's `gh` inside the sandbox uses this. Read-only at the token level means even if the harness deny rules slipped, gh writes would 401 at GitHub. Without it, the agent has no GH access inside the sandbox and works only from the data baywatch pre-loaded into the prompt.

## Commands

```bash
bun baywatch list issues
bun baywatch list issues some-org/some-repo#42             # + ad-hoc issue refs
bun baywatch list prs                                      # assigned + review-requested
bun baywatch list prs some-org/some-repo#370               # + ad-hoc PR refs

bun baywatch dev --dry-run --limit 3
bun baywatch dev some-org/some-repo#42                     # also implement this one
bun baywatch review --dry-run                              # discovered PRs
bun baywatch review some-org/some-repo#370                 # also review this one

bun baywatch install-specs                                 # Fig autocomplete
```

Ad-hoc refs are one-shot: pass `owner/repo#num` on the command line whenever you want to include an issue or PR you're not auto-discovered for. They're never persisted to config.

## Status

Iteration 1 — scaffolding only. `dev` and `review` are stubs that print intent. Discovery (`list issues`, `list prs`) and the prep step (fetch + branch + install) are real and safe to run.
