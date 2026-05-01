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
        item.description = `${run.kind}  ${run.status}`
        item.tooltip = new vscode.MarkdownString(
            [
                `**${run.ownerRepo} ${run.target}**`,
                `kind: \`${run.kind}\`  ·  status: \`${run.status}\``,
                run.branch ? `branch: \`${run.branch}\`` : "",
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

    async getChildren(): Promise<RunEntry[]> {
        try {
            return await listRuns({ limit: 50 })
        } catch (err) {
            void vscode.window.showErrorMessage(`baywatch logs failed: ${(err as Error).message}`)
            return []
        }
    }
}
