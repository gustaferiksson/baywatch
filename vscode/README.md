# baywatch — VS Code

Thin shell over the [`baywatch`](../README.md) CLI. The extension shells out to `baywatch ... --json` for everything and dispatches actions through integrated terminals — the CLI is the source of truth.

## What's here

### Activity bar — Baywatch (rocket icon)

Two tree views:

- **Runs** — recent agent runs from `baywatch logs --json`. Auto-refreshes every 10s. Status icons (spinner / check / error) reflect the run state. Click a run to **live-tail its log** in a dedicated output channel.
    - **Right-click on a dev run**: open the agent clone in a new window, push the branch, or open a PR (delegates to `gh pr create --web`).
    - **Right-click on any run**: tail the log, open the log file directly.
- **Reviews** — markdown review files from `baywatch/reviews/`. Click to open. Most recent first.

### Status bar

Right-aligned: `$(rocket) baywatch · 2 running` (or `idle`). Hover to see the live list of in-flight runs. Click to refresh.

### Commands (palette)

| Command | What it does |
|---|---|
| `Baywatch: Run dev agent` | Pick an issue from `baywatch list issues --json`, kick off `baywatch dev --only <ref>` in a terminal |
| `Baywatch: Run review agent` | Same shape for PRs |
| `Baywatch: Edit notes for issue…` / `…for PR…` | Open a webview to edit free-form notes for a ref. Saved to `~/.baywatch/notes/<ref>.md`; the agent prompt picks them up as `{{ADDITIONAL_NOTES}}` on the next run for that ref. Cmd/Ctrl-S saves. |
| `Baywatch: Start Claude session here` | Pick a workspace folder (or browse), prompt for a session name, open a terminal running `claude --remote-control "<name>"`. Not sandboxed — uses your host's Claude Code config. Visible at claude.ai/code if your global has remote control on. |
| `Baywatch: Tail log` | Live-tail the selected run's log into the **Baywatch · Run log** output channel. Switching to a different run swaps the tail. |
| `Baywatch: Push agent branch` | `cd <agent-clone> && git push -u origin <branch>` (right-click on a dev run) |
| `Baywatch: Open PR for agent branch` | `gh pr create --head <branch> --web` (right-click on a dev run) |
| `Baywatch: Rebuild sandbox image` | Runs `baywatch image-build` in a terminal |
| `Baywatch: Clean old agent clones` | Runs `baywatch clean clones --dry-run` so you can preview before committing |
| `Baywatch: Refresh` | Force tree + status-bar refresh |

## Notes flow

For any issue/PR you want to add context to *before* an agent run:

1. **Cmd-Shift-P → `Baywatch: Edit notes for issue…`** (or PR)
2. Pick the ref from the list
3. A webview opens beside your editor — type free-form markdown
4. Cmd/Ctrl-S to save
5. On the next `baywatch dev` (or `review`) run for that ref, the agent prompt includes your notes as the `Additional notes from the maintainer` section, marked higher priority than the issue/PR body

The notes file lives at `~/.baywatch/notes/<owner>__<repo>__<num>.md`. Kept across runs until you clear it.

## Install (dev mode)

```bash
cd vscode
bun install     # or npm install
bun run build   # tsc → dist/
```

Then in VS Code: **F5** to launch the Extension Development Host with this extension loaded.

## Package + install as a real extension

```bash
bun run package   # produces baywatch-vscode-X.Y.Z.vsix
code --install-extension baywatch-vscode-*.vsix
```

For marketplace publishing, see [PUBLISHING.md](PUBLISHING.md).

## What's not here (yet)

- Inline diff viewer for a run's commits (right now `Open agent clone in new window` is the closest thing)
- Goal-vs-implementation review viewer (read the markdown directly)
- Search across past reviews / logs
- Configuration UI for `baywatch.config.ts` (edit the file directly)
- "Submit batch of pending review comments to GitHub" — currently the review markdown + the generated `submit-review.sh` is the workflow

## Why so thin

Everything goes through the CLI, so:

- The CLI keeps working headlessly (cron, CI, ssh, scripts)
- A future TUI / web UI can use the same `baywatch ... --json` contract
- The extension stays small and easy to maintain
- Anything you can do here, you can do in a terminal
