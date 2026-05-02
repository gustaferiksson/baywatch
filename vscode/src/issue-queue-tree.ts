import * as vscode from "vscode"

import { listIssueRefs } from "./cli.js"
import type { IssueRef } from "./types.js"

// "Issue queue" tree: every assigned issue with a status icon.
//   🔴 no PR yet — click runs the dev agent
//   🟢 PR exists for this issue — click opens the PR in your browser
export class IssueQueueTreeDataProvider implements vscode.TreeDataProvider<IssueRef> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<IssueRef | undefined>()
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event

    private last: IssueRef[] = []

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined)
    }

    getTreeItem(issue: IssueRef): vscode.TreeItem {
        const item = new vscode.TreeItem(`${issue.ref}  ${issue.title}`)
        item.description = describeIssue(issue)
        item.tooltip = new vscode.MarkdownString(
            [
                `**${issue.ref} — ${issue.title}**`,
                `state: \`${issue.state}\``,
                issue.linkedOpenPRs.length > 0
                    ? `linked PRs: ${issue.linkedOpenPRs.map((pr) => `[#${pr.number}](${pr.url})`).join(", ")}`
                    : "no linked PRs yet",
                issue.hasClone ? `local clone: ✓` : `local clone: ✗`,
            ].join("\n\n")
        )
        item.iconPath = stateIcon(issue.state)
        item.contextValue = `issue-${issue.state}`
        item.command = {
            command: "baywatch.queueIssueAction",
            title: "Run dev / open PR",
            arguments: [issue],
        }
        return item
    }

    async getChildren(): Promise<IssueRef[]> {
        try {
            this.last = await listIssueRefs()
        } catch (err) {
            console.error(`[baywatch] list issues failed: ${(err as Error).message}`)
        }
        // Sort: open (no PR) first so the actionable ones bubble up.
        const order = { open: 0, implemented: 1 } as const
        return [...this.last].sort((a, b) => order[a.state] - order[b.state])
    }
}

function describeIssue(issue: IssueRef): string {
    const parts: string[] = []
    if (issue.state === "implemented") {
        const first = issue.linkedOpenPRs[0]
        parts.push(first ? `✓ PR #${first.number}` : "✓ implemented")
    } else {
        parts.push("● no PR yet")
    }
    if (!issue.hasClone) parts.push("no clone")
    return parts.join("  ·  ")
}

function stateIcon(state: IssueRef["state"]): vscode.ThemeIcon {
    if (state === "implemented") return new vscode.ThemeIcon("pass-filled", new vscode.ThemeColor("charts.green"))
    return new vscode.ThemeIcon("circle-large-filled", new vscode.ThemeColor("charts.red"))
}
