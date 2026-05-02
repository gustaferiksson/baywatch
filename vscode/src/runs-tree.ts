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
        const item = new vscode.TreeItem(`#${run.runId} ${run.ownerRepo} ${run.target}`)
        const failureSuffix =
            run.status === "failed" && run.errorSummary ? `  ·  ${truncate(run.errorSummary, 40)}` : ""
        item.description = `${run.kind}  ${run.status}${failureSuffix}`
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
            item.command = {
                command: "baywatch.tailLog",
                title: "Tail log",
                arguments: [run],
            }
        }
        return item
    }

    private lastRuns: RunEntry[] = []

    async getChildren(): Promise<RunEntry[]> {
        try {
            this.lastRuns = await listRuns({ limit: 50 })
            return this.lastRuns
        } catch (err) {
            // Keep showing the last good state — `baywatch logs` can transiently fail
            // (e.g. SQLite contention during a write), and clearing the tree on every
            // hiccup is worse than showing slightly-stale rows.
            console.error(`[baywatch] logs failed: ${(err as Error).message}`)
            return this.lastRuns
        }
    }
}

function truncate(s: string, max: number): string {
    return s.length > max ? `${s.slice(0, max - 1)}…` : s
}
