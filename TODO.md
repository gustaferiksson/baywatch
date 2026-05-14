# baywatch — todo

Captured so context doesn't get lost between sessions. Roughly ordered by
expected leverage. Cross items off when done.

## In progress
- [ ] **Sync agent branch back to main clone on `session stop`/`rm`** — mirrors
      what `baywatch dev`/`review` already do at the end of a one-shot run.
      Adds `pushBranchToMain()` call to `stopSession()` and `removeSession()`.

## Real work, high value
- [ ] **Persistent terminal cache → instant session switching** *(macOS)*.
      Maintain a process-wide cache of `LocalProcessTerminalView` per
      container, keep alive across selection changes, swap visibility instead
      of dismantling/respawning the PTY. Removes the ~500ms-1s podman exec
      spawn per switch.
- [ ] **Stage / commit panel in the detail inspector** *(macOS)*. File list
      with checkboxes (staged/unstaged), commit message field, Commit button.
      Calls `git add` per checked file + `git commit -m` via podman exec.
      Lets you land the agent's work without leaving the app.
- [ ] **Sandcastle-style session JSONL linking on stop/rm** *(CLI)*. Pull
      claude session transcript JSONLs out of the container's
      `~/.claude/projects/-home-agent-workspace/`, rewrite `cwd` to the host
      main clone path, and write to `~/.claude/projects/<encoded-main>/` so
      your host's `claude --resume` picks them up.

## Quality of life *(macOS app)*
- [ ] **Side-by-side diff view** (toggle in inspector). DiffView render
      strategy alternative for hunks with empty placeholders for inserts/deletes.
- [ ] **Auto-refresh diff while detail visible**. Currently manual via the
      toolbar refresh button.
- [ ] **Sidebar grouping by state with section headers** (Needs Input /
      Working / Idle / Done). HIG-native source-list pattern (Mail).
- [ ] **Last-activity timestamp in sidebar rows** ("2m ago" relative time).
      The `lastEventAt` field is already on `Session`.
- [ ] **Diff stats in sidebar rows** ("+15 −8") — cached per-tick.
- [ ] **"Open clone in Finder / Editor" in context menu**. `NSWorkspace.open()`
      for the clone path, `NSWorkspace.openApplication(...)` for VS Code/Zed.

## Bigger / strategic
- [ ] **GitHub integration for issues + PRs in the macOS app**. Different flows
      for review-other-PRs vs my-PRs vs new-dev / pre-dev. Needs design before
      building.
- [ ] **Remote Control via libsecret inside the container** — currently we use
      a *separate* identity so the host's auth stays untouched. The libsecret
      route would let the same identity multiplex, but is fragile (cross-update
      schema risk).

## Done recently
- [x] CLI: session lifecycle (new/ls/attach/stop/rm/login), wrap.sh for
      resume, tmux + xterm-256color, hooks → status.jsonl, host
      settings/.claude.json merge, host CLAUDE.md/agents/skills mount.
- [x] macOS app v1: sidebar with live state, embedded SwiftTerm, diff with
      inline comment popovers + comment indicators, comments panel with
      send-to-session, notifications, Settings.
- [x] SwiftTerm 100ms input-lag fix (pinned to commit `d024ed7`).
- [x] Async SessionActions to remove main-thread beachballs.
- [x] ⌘N create / ⌘⌫ remove keyboard shortcuts.
