import * as vscode from "vscode"

import { listPrRefs } from "./cli.js"
import type { PrRef } from "./types.js"

// "Review queue" tree: every discoverable PR (assigned + review-requested) with a
// status icon based on the most recent review's verdict at the current head.
//
//   🟢 approve / approve with minor suggestions (verdict at current head)
//   🟡 needs-changes verdict, OR review is stale (PR moved since last review)
//   🔴 blocking verdict, OR never reviewed
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
                "_(click → open PR on GitHub  ·  use the action button to run review)_",
            ].join("\n\n")
        )
        item.iconPath = stateIcon(pr.reviewState)
        item.contextValue = `pr-${pr.reviewState}`
        // Click opens the review markdown if one exists for this PR — that's where the
        // outcome lives. If there's no review yet, fall back to the PR view.
        if (pr.lastReviewPath) {
            item.command = {
                command: "vscode.open",
                title: "Open review outcome",
                arguments: [vscode.Uri.file(pr.lastReviewPath)],
            }
        } else {
            item.command = {
                command: "baywatch.openPrOnGithub",
                title: "Open PR",
                arguments: [pr],
            }
        }
        return item
    }

    async getChildren(): Promise<PrRef[]> {
        try {
            this.last = await listPrRefs()
        } catch (err) {
            console.error(`[baywatch] list prs failed: ${(err as Error).message}`)
        }
        // Sort by severity: blocking + unreviewed first (red), then yellow, then green.
        return [...this.last].sort((a, b) => stateSortKey(a.reviewState) - stateSortKey(b.reviewState))
    }
}

function stateSortKey(state: PrRef["reviewState"]): number {
    if (state === "blocking" || state === "unreviewed") return 0
    if (state === "needs-changes" || state === "stale") return 1
    return 2 // approve, approve-minor
}

const STATE_LABELS: Record<PrRef["reviewState"], string> = {
    approve: "✓ approved",
    "approve-minor": "✓ approve w/ suggestions",
    "needs-changes": "✎ needs changes",
    blocking: "✗ blocking",
    stale: "⏳ stale",
    unreviewed: "● new",
}

function describePr(pr: PrRef): string {
    const parts: string[] = [pr.reasonForReview, STATE_LABELS[pr.reviewState]]
    if (!pr.hasClone) parts.push("no clone")
    return parts.join("  ·  ")
}

function stateIcon(state: PrRef["reviewState"]): vscode.ThemeIcon {
    // Green: approved (any flavour). Yellow: needs-changes or stale. Red: blocking or unreviewed.
    if (state === "approve" || state === "approve-minor") {
        return new vscode.ThemeIcon("pass-filled", new vscode.ThemeColor("charts.green"))
    }
    if (state === "needs-changes" || state === "stale") {
        const icon = state === "needs-changes" ? "edit" : "clock"
        return new vscode.ThemeIcon(icon, new vscode.ThemeColor("charts.yellow"))
    }
    // blocking, unreviewed
    const icon = state === "blocking" ? "error" : "circle-large-filled"
    return new vscode.ThemeIcon(icon, new vscode.ThemeColor("charts.red"))
}
