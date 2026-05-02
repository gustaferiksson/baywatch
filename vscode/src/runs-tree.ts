import * as vscode from "vscode"

import { listRuns, statusColor, statusIcon } from "./cli.js"
import type { RunEntry } from "./types.js"

export class RunsTreeDataProvider implements vscode.TreeDataProvider<RunEntry> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<RunEntry | undefined>()
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined)
    }

    getTreeItem(run: RunEntry): vscode.TreeItem {
        const isPending = run.runId < 0
        const idLabel = isPending ? "starting…" : `#${run.runId}`
        const item = new vscode.TreeItem(`${idLabel} ${run.ownerRepo} ${run.target}`)
        const failureSuffix =
            run.status === "failed" && run.errorSummary ? `  ·  ${truncate(run.errorSummary, 40)}` : ""
        item.description = isPending ? `${run.kind}  dispatching` : `${run.kind}  ${run.status}${failureSuffix}`
        item.tooltip = new vscode.MarkdownString(
            [
                `**${run.ownerRepo} ${run.target}**`,
                `kind: \`${run.kind}\`  ·  status: \`${run.status}\``,
                run.branch ? `branch: \`${run.branch}\`` : "",
                run.errorSummary ? `error: \`${run.errorSummary}\`` : "",
                run.logPath ? `log: \`${run.logPath}\`` : "(no log file yet)",
            ]
                .filter(Boolean)
                .join("\n\n")
        )
        item.iconPath = new vscode.ThemeIcon(statusIcon(run.status), statusColor(run.status))
        item.contextValue = run.kind === "dev" ? "dev-run" : "review-run"
        if (run.logPath) {
            // Click opens the log as a regular editor tab. Use the inline tail button
            // (right-side) for live streaming into the output channel.
            item.command = {
                command: "baywatch.openLog",
                title: "Open log",
                arguments: [run],
            }
        }
        return item
    }

    private lastRuns: RunEntry[] = []
    private pending = new Map<string, RunEntry>()

    // Optimistic placeholder for a run that's been dispatched but hasn't shown up in the
    // registry yet (the agent process spawn + `startRun` insert takes a second or two).
    // Auto-clears when a real run with matching kind+ownerRepo+target appears, or after
    // a 60s timeout if dispatch failed silently.
    addPending(kind: "dev" | "review", ownerRepo: string, target: string): void {
        const key = `${kind}:${ownerRepo}:${target}`
        const entry: RunEntry = {
            runId: -Date.now(),
            kind,
            status: "running",
            target,
            ownerRepo,
            branch: null,
            startedAt: new Date().toISOString(),
            finishedAt: null,
            logPath: null,
            errorSummary: null,
        }
        this.pending.set(key, entry)
        this.refresh()
        setTimeout(() => {
            const current = this.pending.get(key)
            if (current && current.runId === entry.runId) {
                this.pending.delete(key)
                this.refresh()
            }
        }, 60_000)
    }

    async getChildren(): Promise<RunEntry[]> {
        try {
            this.lastRuns = await listRuns({ limit: 50 })
        } catch (err) {
            // Keep showing the last good state — `baywatch logs` can transiently fail
            // (e.g. SQLite contention during a write), and clearing the tree on every
            // hiccup is worse than showing slightly-stale rows.
            console.error(`[baywatch] logs failed: ${(err as Error).message}`)
        }

        // Drop any pending whose real registry entry has now appeared.
        const realKeys = new Set(this.lastRuns.map((r) => `${r.kind}:${r.ownerRepo}:${r.target}`))
        for (const k of [...this.pending.keys()]) {
            if (realKeys.has(k)) this.pending.delete(k)
        }

        // Pending entries render at the top so they're easy to spot.
        return [...this.pending.values(), ...this.lastRuns]
    }
}

function truncate(s: string, max: number): string {
    return s.length > max ? `${s.slice(0, max - 1)}…` : s
}
