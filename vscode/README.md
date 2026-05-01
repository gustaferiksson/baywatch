# baywatch — VS Code

Thin shell around the [`baywatch`](../README.md) CLI. The extension calls `baywatch ... --json` for everything and runs dispatch commands (`baywatch dev`, `baywatch review`) in integrated terminals — the CLI stays the source of truth.

## What's here

- **Activity bar view** — Baywatch (rocket icon)
- **Runs tree view** — recent agent runs from `baywatch logs --json`. Refreshes every 10s. Click a run to open its log file.
- **Commands**:
    - `Baywatch: Run dev agent` — quick-pick a discoverable issue (from `baywatch list issues --json`), runs `baywatch dev --only <ref>` in a terminal
    - `Baywatch: Run review agent` — same for PRs
    - `Baywatch: Refresh runs` — force a tree refresh
    - `Baywatch: Open run log` — opens the run's log file (also fires on tree-item click)
    - `Baywatch: Open agent clone in new window` — opens the agent clone path in a fresh VS Code window (right-click on a dev run)

## Install (dev mode)

```bash
cd vscode
bun install   # or npm install
bun run build # tsc → dist/
# Then in VS Code: F5 to launch the Extension Development Host.
```

To install as a real extension:

```bash
bun run package   # produces baywatch-vscode-X.Y.Z.vsix
code --install-extension baywatch-vscode-*.vsix
```

## What's not here yet

- Status bar with in-flight run count
- Output channel that tails the latest log live (rather than just opening the file)
- "Push branch & open PR" delegate to the GitHub Pull Requests extension
- Inline goal-vs-implementation review viewer
- Configuration UI for `baywatch.config.ts`

All of these can land once the prompts and skill rubrics are dialed in.

## Why so thin

If everything goes through the CLI, the extension stays cheap to maintain, the CLI stays usable headlessly (cron, CI, ssh, scripts), and other surfaces (TUI, web UI) can be added later with the same `baywatch ... --json` contract.
