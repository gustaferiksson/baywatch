import * as vscode from "vscode"

import { listRuns } from "./cli.js"

let item: vscode.StatusBarItem | null = null

function ensureItem(context: vscode.ExtensionContext): vscode.StatusBarItem {
    if (!item) {
        item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
        item.command = "baywatch.refreshRuns"
        context.subscriptions.push(item)
    }
    return item
}

export async function updateStatusBar(context: vscode.ExtensionContext): Promise<void> {
    const it = ensureItem(context)
    try {
        const running = await listRuns({ running: true, limit: 20 })
        if (running.length === 0) {
            it.text = "$(rocket) baywatch · idle"
            it.tooltip = "No agents running. Click to refresh."
        } else {
            it.text = `$(rocket) baywatch · ${running.length} running`
            it.tooltip = new vscode.MarkdownString(
                [
                    `**${running.length} agent(s) running:**`,
                    ...running.map((r) => `- #${r.runId}  ${r.ownerRepo} ${r.target}`),
                ].join("\n")
            )
        }
        it.show()
    } catch {
        it.hide()
    }
}
