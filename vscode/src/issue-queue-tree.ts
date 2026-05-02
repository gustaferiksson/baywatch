import * as vscode from "vscode"

import { listIssueRefs, listRuns } from "./cli.js"
import type { IssueRef, RunEntry } from "./types.js"

// Tree row state combines (a) whether a PR exists for the issue with (b) the most
// recent dev-agent run from the registry. Run history takes precedence over
// "no-PR-yet" because the user wants to know if an attempt has already been made.
type DerivedState = "running" | "failed" | "implemented" | "open"

type DecoratedIssue = IssueRef & { derivedState: DerivedState; latestRun: RunEntry | null }

// "Issue queue" tree: every assigned issue, coloured by combined PR + run state.
//   🟢 PR exists for this issue (click → open PR view)
//   🟡 dev agent currently running, OR last run failed
//   🔴 no PR, no run — fresh (click action → run dev)
export class IssueQueueTreeDataProvider implements vscode.TreeDataProvider<DecoratedIssue> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<DecoratedIssue | undefined>()
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event

    private last: DecoratedIssue[] = []

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined)
    }

    getTreeItem(issue: DecoratedIssue): vscode.TreeItem {
        const item = new vscode.TreeItem(`${issue.ref}  ${issue.title}`)
        item.description = describeIssue(issue)
        item.tooltip = new vscode.MarkdownString(
            [
                `**${issue.ref} — ${issue.title}**`,
                `state: \`${issue.derivedState}\``,
                issue.linkedOpenPRs.length > 0
                    ? `linked PRs: ${issue.linkedOpenPRs.map((pr) => `[#${pr.number}](${pr.url})`).join(", ")}`
                    : "no linked PRs yet",
                issue.latestRun
                    ? `latest run: #${issue.latestRun.runId} \`${issue.latestRun.status}\` (${formatAge(issue.latestRun.startedAt)})` +
                      (issue.latestRun.errorSummary ? `\n\nerror: \`${issue.latestRun.errorSummary}\`` : "")
                    : "no agent runs yet",
                issue.hasClone ? `local clone: ✓` : `local clone: ✗`,
                "_(click → open issue inside VS Code  ·  use the action button to run)_",
            ].join("\n\n")
        )
        item.iconPath = stateIcon(issue.derivedState)
        // Keep the contextValue compatible with existing menu rules: "issue-open" for
        // anything actionable (red/yellow), "issue-implemented" for green.
        item.contextValue = issue.derivedState === "implemented" ? "issue-implemented" : "issue-open"
        item.command = {
            command: "baywatch.openIssueOnGithub",
            title: "Open issue on GitHub",
            arguments: [issue],
        }
        return item
    }

    async getChildren(): Promise<DecoratedIssue[]> {
        try {
            const [issues, runs] = await Promise.all([listIssueRefs(), listRuns({ limit: 200 })])
            this.last = issues.map((i) => decorate(i, runs))
        } catch (err) {
            console.error(`[baywatch] issue queue refresh failed: ${(err as Error).message}`)
        }
        const order: Record<DerivedState, number> = { failed: 0, running: 1, open: 2, implemented: 3 }
        return [...this.last].sort((a, b) => order[a.derivedState] - order[b.derivedState])
    }
}

function decorate(issue: IssueRef, runs: RunEntry[]): DecoratedIssue {
    const target = `issue-${issue.number}`
    const latestRun =
        runs
            .filter((r) => r.kind === "dev" && r.ownerRepo === issue.ownerRepo && r.target === target)
            .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0] ?? null

    let derivedState: DerivedState
    if (issue.state === "implemented") derivedState = "implemented"
    else if (latestRun?.status === "running") derivedState = "running"
    else if (latestRun?.status === "failed") derivedState = "failed"
    else derivedState = "open"

    return { ...issue, derivedState, latestRun }
}

function describeIssue(issue: DecoratedIssue): string {
    const parts: string[] = []
    if (issue.derivedState === "implemented") {
        const first = issue.linkedOpenPRs[0]
        parts.push(first ? `✓ PR #${first.number}` : "✓ implemented")
    } else if (issue.derivedState === "running") {
        parts.push(`⟳ dev running (#${issue.latestRun?.runId})`)
    } else if (issue.derivedState === "failed") {
        parts.push(`✗ last run failed (#${issue.latestRun?.runId})`)
    } else {
        parts.push("● no PR yet")
    }
    if (!issue.hasClone) parts.push("no clone")
    return parts.join("  ·  ")
}

function stateIcon(state: DerivedState): vscode.ThemeIcon {
    if (state === "implemented") return new vscode.ThemeIcon("pass-filled", new vscode.ThemeColor("charts.green"))
    if (state === "running") return new vscode.ThemeIcon("loading~spin", new vscode.ThemeColor("charts.yellow"))
    if (state === "failed") return new vscode.ThemeIcon("error", new vscode.ThemeColor("charts.yellow"))
    // "new" / awaiting action: neutral gray rather than red — red was reading as urgent/error.
    return new vscode.ThemeIcon("circle-large-outline", new vscode.ThemeColor("descriptionForeground"))
}

function formatAge(iso: string): string {
    const sec = Math.floor((Date.now() - Date.parse(iso)) / 1000)
    if (sec < 60) return `${sec}s ago`
    const min = Math.floor(sec / 60)
    if (min < 60) return `${min}m ago`
    const hr = Math.floor(min / 60)
    if (hr < 24) return `${hr}h ago`
    return `${Math.floor(hr / 24)}d ago`
}
