# baywatch — todo

Captured so context doesn't get lost between sessions. Roughly ordered by
expected leverage. Cross items off when done.

**Plan of record:** see [`DESIGN.md`](./DESIGN.md) — baywatch is being re-modelled
from a GitHub issue/PR *workflow* orchestrator into a task-centric, multi-repo
agent **cockpit** (native macOS only). Phases below track that build.

---

## Phase 1 — the orchestrator (ship this first)

The multi-repo Task/Session re-model. Each item is roughly a slice.

- [ ] **Task entity + persistence** — `Task {id,name,query?,repos:[{ownerRepo,
      branch,mainClonePath}],createdAt}` under `~/.baywatch/tasks/<id>/task.json`.
      New `src/tasksState.ts`.
- [ ] **Multi-repo `SessionMeta`** — `repos: SessionRepo[]` + `taskId`; drop the
      singular `repo/branch/clonePath/mainClonePath`. Adapt `runSession`,
      `syncBranchToMainClone`, `cli.runSessionNew`. Clean break on state shape
      (few live sessions; let old single-repo ones age out).
- [ ] **Swift read-models** follow the new shape (`Session.swift` + call sites).
- [ ] **Per-session clone-parent mount** — identity-mount
      `~/.baywatch/clones/<session>/`; each repo is a subdir clone. One mount,
      N repos, `claude` cwd = the parent so it sees them all.
- [ ] **Add repo on the fly** — drop a new clone into the mounted parent (appears
      live, no container restart) AND append it to the Task's `repos`.
- [ ] **Branch-reuse mode in `createAgentClone`** — continue an existing Task's
      branch (`checkout -B <branch> <branch>`) vs cut fresh off `origin/<default>`.
- [ ] **Auto local fetch-back on session end** *(was: "sync branch back on
      stop/rm")* — `pushBranchToMain` per repo on `stop`/`rm`. No push, never
      touches your working tree. This is what makes tasks resumable next day.
- [ ] **`prStatusForBranch()` in `gh.ts`** — `gh pr view <branch> --json
      statusCheckRollup` → checks state. Local-only branch → "not pushed".
- [ ] **Two-level sidebar** — Tasks as sections, sessions as rows beneath
      (reuses `SidebarView`; sort by state rank). *Supersedes the old
      "group by state/repo" item — grouping is now Task→Session.*
- [ ] **Per-repo landing strip** in the detail view — branch, **Land** /
      **Push** / **Create PR** buttons, checks badge. *Absorbs the old
      "stage/commit panel" item.*
- [ ] **"Open clone in VS Code/Zed"** per repo — `NSWorkspace.openApplication`.
      Bridge for hand-editing until the Phase 2 editor lands.
- [ ] **Task/session naming** — derive from the query (was "better session
      naming"): `<repo>-<rand>` → task name from first prompt / user-typed.

## Phase 2 — in-app editor (no LSP yet)

- [ ] Native editor via **CodeEditSourceEditor** (AppKit + Tree-sitter
      highlighting). Edit → save to the clone → container sees it live (identity
      mount) → lands on fetch-back with the agent's commits.

## Phase 3 — in-container LSP

- [ ] LSP client via ChimeHQ **LanguageClient** / **LanguageServerProtocol**.
      **Gotcha:** code + deps live *inside* the container → run language servers
      in the container, spoken to over `podman exec -i <server> --stdio`.
      Per-language, per-image work, layered on the Phase-2 editor.

---

## Ongoing QoL *(macOS app)* — slot in alongside phases

- [ ] **Persistent terminal cache → instant session switching**. Cache
      `LocalProcessTerminalView` per container, swap visibility instead of
      respawning the PTY. Removes ~500ms-1s podman exec spawn per switch.
- [ ] **Side-by-side diff view** (toggle). DiffView render alternative with
      empty placeholders for inserts/deletes.
- [ ] **Auto-refresh diff while detail visible** (currently manual).
- [ ] **Sidebar filter / search** — `.searchable(text:)` on the list.
- [ ] **Last-activity timestamp in sidebar rows** ("2m ago"). `lastEventAt`
      already on `Session`.
- [ ] **Diff stats in sidebar rows** ("+15 −8") — cached per-tick.

## Parked / strategic

- [ ] **Remote Control via libsecret inside the container** — currently a
      separate identity keeps host auth untouched. libsecret would let one
      identity multiplex, but is fragile (cross-update schema risk).

## Superseded by the re-model

- ~~GitHub issue/PR **discovery** integration in the macOS app~~ — GitHub is now
  a **status surface** (PR checks), not a discovery/workflow engine. The
  issue/review queues + dev/review workflows are being **deleted**
  (`discovery.ts`, `reviewVerdict.ts`, `reviews/`, `prompts/`, the VS Code ext).

## Done recently

- [x] **Native session discovery via host-matching paths.** Sessions run with
      the clone bind-mounted at its real host path inside the container, and
      `~/.claude/projects/<encoded-clone>/` bind-mounted too — so JSONLs land on
      the host with the right `cwd`. `claude --resume` and any tool that walks
      `~/.claude/projects/` picks up live baywatch sessions natively.
- [x] CLI: session lifecycle (new/ls/attach/stop/rm/login), wrap.sh for resume,
      tmux + xterm-256color, hooks → status.jsonl, host settings/.claude.json
      merge, host CLAUDE.md/agents/skills mount.
- [x] macOS app v1: sidebar with live state, embedded SwiftTerm, diff with
      inline comment popovers + comment indicators, comments panel with
      send-to-session, notifications, Settings.
- [x] SwiftTerm 100ms input-lag fix (pinned to commit `d024ed7`).
- [x] Async SessionActions to remove main-thread beachballs.
- [x] ⌘N create / ⌘⌫ remove keyboard shortcuts.
