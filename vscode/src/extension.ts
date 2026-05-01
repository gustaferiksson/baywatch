// VS Code surface for baywatch.
//
// The extension is intentionally a thin shell around the `baywatch` CLI:
// it shells out for data (via `baywatch logs --json`, `baywatch list ... --json`)
// and dispatches actions (via `baywatch dev --only`, `baywatch review --only`).
// This keeps the CLI the single source of truth — anything the extension can
// do, you can also do from a terminal.

import { execFile } from "node:child_process"
import { promisify } from "node:util"
import * as vscode from "vscode"

const execFileAsync = promisify(execFile)

type RunEntry = {
    runId: number
    kind: "dev" | "review"
    status: "running" | "success" | "failed" | "cancelled"
    target: string
    ownerRepo: string
    branch: string | null
    startedAt: string
    finishedAt: string | null
    logPath: string | null
}

class RunsTreeDataProvider implements vscode.TreeDataProvider<RunEntry> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<RunEntry | undefined>()
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined)
    }

    getTreeItem(run: RunEntry): vscode.TreeItem {
        const item = new vscode.TreeItem(`#${run.runId} ${run.ownerRepo} ${run.target}`)
        item.description = `${run.kind}  ${run.status}`
        item.tooltip = run.logPath
            ? new vscode.MarkdownString(
                  `**${run.ownerRepo} ${run.target}**\n\nbranch: \`${run.branch ?? "(none)"}\`\n\nlog: \`${run.logPath}\``
              )
            : undefined
        item.iconPath = iconForRun(run)
        item.contextValue = run.kind === "dev" ? "dev-run" : "review-run"
        if (run.logPath) {
            item.command = {
                command: "baywatch.openLog",
                title: "Open log",
                arguments: [run],
            }
        }
        return item
    }

    async getChildren(): Promise<RunEntry[]> {
        try {
            const { stdout } = await execFileAsync("baywatch", ["logs", "--json", "--limit", "50"], {
                maxBuffer: 4 * 1024 * 1024,
            })
            return JSON.parse(stdout) as RunEntry[]
        } catch (err) {
            void vscode.window.showErrorMessage(`baywatch logs failed: ${(err as Error).message}`)
            return []
        }
    }
}

function iconForRun(run: RunEntry): vscode.ThemeIcon {
    if (run.status === "running") return new vscode.ThemeIcon("loading~spin", new vscode.ThemeColor("charts.blue"))
    if (run.status === "success") return new vscode.ThemeIcon("check", new vscode.ThemeColor("charts.green"))
    if (run.status === "failed") return new vscode.ThemeIcon("error", new vscode.ThemeColor("charts.red"))
    return new vscode.ThemeIcon("circle-slash")
}

async function pickRefViaList(kind: "issues" | "prs"): Promise<string | undefined> {
    let stdout: string
    try {
        const r = await execFileAsync("baywatch", ["list", kind, "--json"], { maxBuffer: 4 * 1024 * 1024 })
        stdout = r.stdout
    } catch (err) {
        void vscode.window.showErrorMessage(`baywatch list ${kind} failed: ${(err as Error).message}`)
        return undefined
    }
    const items = JSON.parse(stdout) as Array<{
        ref: string
        title: string
        hasClone: boolean
        blockedByPRs?: number[]
        reasonForReview?: string
        alreadyReviewedAtThisHead?: boolean
    }>
    if (items.length === 0) {
        void vscode.window.showInformationMessage(`No ${kind} discovered.`)
        return undefined
    }
    const picks: vscode.QuickPickItem[] = items.map((i) => ({
        label: i.ref,
        description: i.title,
        detail: detailFor(i),
    }))
    const chosen = await vscode.window.showQuickPick(picks, {
        placeHolder: `Select a ${kind === "issues" ? "issue" : "PR"} ref`,
    })
    return chosen?.label
}

function detailFor(i: {
    hasClone: boolean
    blockedByPRs?: number[]
    reasonForReview?: string
    alreadyReviewedAtThisHead?: boolean
}): string {
    const parts: string[] = []
    if (i.reasonForReview) parts.push(i.reasonForReview)
    if (!i.hasClone) parts.push("no clone")
    if ((i.blockedByPRs?.length ?? 0) > 0) parts.push(`blocked by PR #${i.blockedByPRs?.[0]}`)
    if (i.alreadyReviewedAtThisHead) parts.push("reviewed-at-head")
    return parts.join("  ·  ")
}

function runInTerminal(name: string, command: string): void {
    const term = vscode.window.createTerminal({ name })
    term.show(true)
    term.sendText(command)
}

export function activate(context: vscode.ExtensionContext): void {
    const provider = new RunsTreeDataProvider()
    context.subscriptions.push(vscode.window.registerTreeDataProvider("baywatch.runs", provider))

    context.subscriptions.push(
        vscode.commands.registerCommand("baywatch.refreshRuns", () => provider.refresh()),

        vscode.commands.registerCommand("baywatch.runDev", async () => {
            const ref = await pickRefViaList("issues")
            if (!ref) return
            runInTerminal(`baywatch dev ${ref}`, `baywatch dev --only ${ref}`)
            setTimeout(() => provider.refresh(), 500)
        }),

        vscode.commands.registerCommand("baywatch.runReview", async () => {
            const ref = await pickRefViaList("prs")
            if (!ref) return
            runInTerminal(`baywatch review ${ref}`, `baywatch review --only ${ref}`)
            setTimeout(() => provider.refresh(), 500)
        }),

        vscode.commands.registerCommand("baywatch.openLog", async (run?: RunEntry) => {
            if (!run?.logPath) {
                void vscode.window.showInformationMessage("No log file recorded for this run yet.")
                return
            }
            const doc = await vscode.workspace.openTextDocument(run.logPath)
            await vscode.window.showTextDocument(doc)
        }),

        vscode.commands.registerCommand("baywatch.openClone", async (run?: RunEntry) => {
            if (!run) return
            try {
                const { stdout } = await execFileAsync("baywatch", ["logs", String(run.runId), "--json"])
                const detail = JSON.parse(stdout) as { agentClonePath?: string }
                if (!detail.agentClonePath) {
                    void vscode.window.showInformationMessage("This run has no agent clone path.")
                    return
                }
                await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(detail.agentClonePath), {
                    forceNewWindow: true,
                })
            } catch (err) {
                void vscode.window.showErrorMessage(`baywatch logs ${run.runId} failed: ${(err as Error).message}`)
            }
        })
    )

    // Refresh every 10s so the tree shows in-flight runs flipping to success/failed without manual refresh.
    const interval = setInterval(() => provider.refresh(), 10_000)
    context.subscriptions.push({ dispose: () => clearInterval(interval) })
}

export function deactivate(): void {}
