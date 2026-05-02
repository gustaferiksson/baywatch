import * as vscode from "vscode"

import { listPrRefs } from "./cli.js"
import type { PrRef } from "./types.js"

// "Review queue" tree: every discoverable PR (assigned + review-requested) with a
// status icon based on review state.
//
//   🟢 reviewed at current head
//   🟡 reviewed at an older head (stale — PR has moved)
//   🔴 never reviewed
export class PrQueueTreeDataProvider implements vscode.TreeDataProvider<PrRef> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<PrRef | undefined>()
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event

    private last: PrRef[] = []

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined)
    }

    getTreeItem(pr: PrRef): vscode.TreeItem {
        const item = new vscode.TreeItem(`${pr.ref}  ${pr.title}`)
        item.description = describePr(pr)
        item.tooltip = new vscode.MarkdownString(
            [
                `**${pr.ref} — ${pr.title}**`,
                `reason: \`${pr.reasonForReview}\`  ·  state: \`${pr.reviewState}\``,
                pr.lastReviewedAt
                    ? `last reviewed: ${new Date(pr.lastReviewedAt).toLocaleString()}` +
                      (pr.lastReviewedHead ? `  (head \`${pr.lastReviewedHead.slice(0, 7)}\`)` : "")
                    : "never reviewed",
                `current head: \`${pr.headRefOid.slice(0, 7)}\``,
            ].join("\n\n")
        )
        item.iconPath = stateIcon(pr.reviewState)
        item.contextValue = `pr-${pr.reviewState}`
        item.command = {
            command: "baywatch.queueReviewPr",
            title: "Review this PR",
            arguments: [pr],
        }
        return item
    }

    async getChildren(): Promise<PrRef[]> {
        try {
            this.last = await listPrRefs()
        } catch (err) {
            console.error(`[baywatch] list prs failed: ${(err as Error).message}`)
        }
        // Sort: unreviewed first, then stale, then reviewed.
        const order = { unreviewed: 0, stale: 1, reviewed: 2 } as const
        return [...this.last].sort((a, b) => order[a.reviewState] - order[b.reviewState])
    }
}

function describePr(pr: PrRef): string {
    const parts: string[] = [pr.reasonForReview]
    if (pr.reviewState === "reviewed") parts.push("✓ reviewed")
    else if (pr.reviewState === "stale") parts.push("⏳ stale")
    else parts.push("● new")
    if (!pr.hasClone) parts.push("no clone")
    return parts.join("  ·  ")
}

function stateIcon(state: PrRef["reviewState"]): vscode.ThemeIcon {
    if (state === "reviewed") return new vscode.ThemeIcon("pass-filled", new vscode.ThemeColor("charts.green"))
    if (state === "stale") return new vscode.ThemeIcon("clock", new vscode.ThemeColor("charts.yellow"))
    return new vscode.ThemeIcon("circle-large-filled", new vscode.ThemeColor("charts.red"))
}
