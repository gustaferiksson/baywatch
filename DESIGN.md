# baywatch — design (v2 re-model)

> Re-purposing baywatch from a GitHub issue/PR **workflow orchestrator** into a
> **task-centric, multi-repo AI coding-agent cockpit** with a native macOS UI.
> This doc is the plan of record. Decisions below were settled in a design
> grilling session; the decision log at the bottom records the "why".

## One-liner

A native macOS cockpit for driving AI coding agents: each **session** is an
agent run against a **task** (a durable bundle of repos + branches), sandboxed
in podman, reviewed as a PR-style diff, steered by inline comments, and landed
back into your real clones on your command.

## From → to

| | Today | v2 |
|---|---|---|
| Surface | CLI + VS Code ext + macOS app | **macOS app only** (CLI stays as engine) |
| Unit of work | a run tied to one GitHub issue/PR | a **Task** (repos+branches) with N **Sessions** |
| Repos per run | 1 | **N**, addable on the fly |
| Behaviour | fixed dev / review **workflows** | freeform **query**, no workflow types |
| GitHub | discovery engine (issue/review queues) | **status surface** (PR checks) + push/PR |
| Editing | none in-app | staged: review → comment → in-app editor → LSP |

## Core model

Two levels, both lightweight.

**Task** — durable; the feature you come back to. `~/.baywatch/tasks/<id>/task.json`
```ts
type Task = {
  id: string
  name: string
  query?: string                 // the original prompt / intent
  repos: TaskRepo[]              // the {repo → branch} bundle
  createdAt: number
}
type TaskRepo = { ownerRepo: string; branch: string; mainClonePath: string }
```

**Session** — ephemeral; one agent run against a Task. `~/.baywatch/sessions/<id>/`
```ts
type SessionMeta = {
  id: string
  taskId: string                // NEW — session belongs to a task
  name: string
  repos: SessionRepo[]          // was singular repo/branch/clonePath
  container: { name: string; id: string }
  startedAt: number
  // resume/link fields as today
}
type SessionRepo = { ownerRepo: string; branch: string; clonePath: string }
```
State is still derived from `status.jsonl` hook events (`starting/working/awaiting-input/idle/done/failed/stopped`).

## Sandbox & lifecycle

Reuses today's model (isolated hardlinked clones, branch-ref fetch-back) — just N times.

1. **New Task** → pick repos (`RepoNode` picker), type query. Per repo:
   `createAgentClone` cuts a fresh branch off `origin/<default>`. First session starts.
2. **Mount** → one **per-session clone-parent** (`~/.baywatch/clones/<session>/`)
   is identity-mounted into the container; each repo's clone is a subdir inside it.
3. **Add repo on the fly** → drop a new clone into that already-mounted parent
   (appears live, **no container restart**) **and** append it to the Task's `repos`.
4. **Session ends** → `pushBranchToMain` runs **automatically per repo** (local
   `git fetch` of the branch ref into the real clone — **no push, never touches
   your working tree**). This keeps the Task's branches durable.
5. **Reopen Task (new session)** → per repo, clone the real checkout and
   `checkout -B <branch> <branch>` (the landed branch **with its commits**), so
   the agent continues the feature — or you point it at "review this."

## GitHub = status surface

- For any pushed branch: `gh pr view <branch> --json statusCheckRollup` /
  `gh pr checks` → live **checks badge**. Local-only branch → "not pushed".
- **Push + `gh pr create` stay manual**, per repo. (Original hard rule: never
  auto-push, never auto-PR — preserved. The only automatic step is the local
  fetch-back, which never leaves your machine.)

## Landing actions (uniform, manual, per repo)

No session "type". Every session offers the same optional actions:
1. **Review** the per-repo diff (`git diff origin/<default>...<branch>`,
   three-dot / PR semantics).
2. **Land** — already automatic on session end.
3. **Push + Create PR** — when you want it.
4. **Checks badge** — appears once a PR exists.

A "review an existing PR" session just uses the badge and skips Land/Push.

## UI — native macOS cockpit (only surface)

- **Left sidebar: two-level tree** — **Tasks as sections**, sessions as rows
  beneath. Sort by state rank; row badges: state, PR checks, `+/−` diff stats,
  last-activity. (Reuses `SidebarView`.)
- **Detail view** — embedded terminal (`SessionTerminalView` / SwiftTerm) +
  per-repo **diff** (`DiffView`) + a per-repo **landing strip** (branch,
  Land / Push / PR buttons, checks badge).
- **Comment-to-agent loop** (the steering star, already built): inline
  `AddCommentPopover` → indicators → `CommentsPanel` → **send-to-session** →
  agent revises. Made **multi-repo aware** (a comment carries its repo/file;
  all feed the one session's agent, which sees every repo).
- **Hand-editing** → see staged plan below.

## Editor + LSP — staged (biggest single build; never blocks the orchestrator)

- **Phase 2 — in-app editor, no LSP.** Native editor via **CodeEditSourceEditor**
  (AppKit + Tree-sitter highlighting, macOS-native). Edit → save to the clone →
  container sees it live (identity mount) → lands on fetch-back with the agent's
  commits. Fully useful without LSP.
- **Phase 3 — LSP.** Protocol client via ChimeHQ **LanguageClient** /
  **LanguageServerProtocol**. **Gotcha:** the code + its installed deps live
  *inside the podman container*, so language servers must run **in the container**,
  spoken to over `podman exec -i <container> <server> --stdio` (not host-side).
  Per-language, per-image work — layered onto the Phase-2 editor.

## Build phases (roadmap)

**Phase 1 — the orchestrator (ship this first):**
1. `Task` entity + persistence (`~/.baywatch/tasks/`).
2. Multi-repo `SessionMeta` (repos list + `taskId`); migrate readers
   (`sessionsState.ts`, Swift `Session`/`SessionMeta`).
3. Per-session clone-parent identity mount; multi-repo container spawn.
4. Branch-reuse mode in `createAgentClone` (continue vs fresh).
5. Auto per-repo `pushBranchToMain` on session end.
6. "Add repo" action on a running session.
7. `prStatusForBranch()` in `gh.ts`; checks badge.
8. Two-level (Task→Session) sidebar; per-repo landing strip in detail.
9. "Open clone in VS Code/Zed" per repo (bridge until Phase 2).

**Phase 2 — in-app editor** (CodeEditSourceEditor + Tree-sitter).

**Phase 3 — in-container LSP** (ChimeHQ client over `podman exec`).

## Deletions (Phase 1 cleanup — confirmed)

- `vscode/` — the entire VS Code extension.
- `prompts/` — `review-pr.md`, `solve-issue.md`, `review-bundle.md` (workflow templates).
- GitHub **discovery** engine: dev/review workflow code paths, issue/review
  queues — `discovery.ts`, `reviewVerdict.ts`, `reviews/`, and the `dev`/`review`
  CLI commands. Keep `gh.ts` (repurposed for status + push/PR).

## Decision log

1. **Native cockpit, not TUI/multiplexer.** Ruled out herdr/tmux/dmux.
2. **Delete the VS Code extension.** macOS app is the only surface.
3. **Delete workflows.** No fixed dev/review types; a session takes any query.
4. **Flat-ish model:** lightweight explicit **Task** over ephemeral **Sessions**
   (chosen over implicit session-fork and pure-label grouping).
5. **Multi-repo per session**, repos addable on the fly (per-session mount trick).
6. **Isolated clones + fetch-back** kept; **auto local fetch-back on end** added
   so tasks are resumable next day.
7. **GitHub = status surface** (PR checks), not a workflow/discovery engine.
8. **Landing manual & uniform**; PR creation manual (safety rule preserved).
9. **Editor + LSP in scope but staged** (orchestrator → editor → LSP), because
   it's the largest, most separable build and LSP has the in-container gotcha.
