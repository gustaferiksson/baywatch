// Baywatch — VS Code extension entry point.
//
// The extension is a thin shell over the `baywatch` CLI. Anything it does, you can also do
// from a terminal — see vscode/src/cli.ts for the CLI calls and the README for the design.

import * as vscode from "vscode"

import { getRun, listIssueRefs, listPrRefs } from "./cli.js"
import { tailRun } from "./log-channel.js"
import { openNotesPanel } from "./notes-panel.js"
import { ReviewsTreeDataProvider } from "./reviews-tree.js"
import { RunsTreeDataProvider } from "./runs-tree.js"
import { updateStatusBar } from "./status-bar.js"
import type { RunEntry } from "./types.js"

export function activate(context: vscode.ExtensionContext): void {
    const runsProvider = new RunsTreeDataProvider()
    const reviewsProvider = new ReviewsTreeDataProvider()

    context.subscriptions.push(
        vscode.window.registerTreeDataProvider("baywatch.runs", runsProvider),
        vscode.window.registerTreeDataProvider("baywatch.reviews", reviewsProvider)
    )

    const refreshAll = (): void => {
        runsProvider.refresh()
        reviewsProvider.refresh()
        void updateStatusBar(context)
    }

    context.subscriptions.push(
        vscode.commands.registerCommand("baywatch.refreshRuns", refreshAll),
        vscode.commands.registerCommand("baywatch.runDev", () => runDevCommand(refreshAll)),
        vscode.commands.registerCommand("baywatch.runReview", () => runReviewCommand(refreshAll)),
        vscode.commands.registerCommand("baywatch.tailLog", (run?: RunEntry) => {
            if (run) tailRun(run)
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
            const detail = await getRun(run.runId)
            if (!detail?.agentClonePath) {
                void vscode.window.showInformationMessage("This run has no agent clone path.")
                return
            }
            await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(detail.agentClonePath), {
                forceNewWindow: true,
            })
        }),
        vscode.commands.registerCommand("baywatch.editNotesForIssue", () => editNotesCommand("issues", context)),
        vscode.commands.registerCommand("baywatch.editNotesForPR", () => editNotesCommand("prs", context)),
        vscode.commands.registerCommand("baywatch.startClaudeSession", () => startClaudeSessionCommand()),
        vscode.commands.registerCommand("baywatch.pushBranch", (run?: RunEntry) => pushBranchCommand(run)),
        vscode.commands.registerCommand("baywatch.openPR", (run?: RunEntry) => openPRCommand(run)),
        vscode.commands.registerCommand("baywatch.imageBuild", () => {
            const term = vscode.window.createTerminal({ name: "baywatch image-build" })
            term.show(true)
            term.sendText("baywatch image-build")
        }),
        vscode.commands.registerCommand("baywatch.cleanClones", () => {
            const term = vscode.window.createTerminal({ name: "baywatch clean clones" })
            term.show(true)
            term.sendText("baywatch clean clones --dry-run")
        })
    )

    // Initial draw + auto-refresh every 10s.
    refreshAll()
    const interval = setInterval(refreshAll, 10_000)
    context.subscriptions.push({ dispose: () => clearInterval(interval) })
}

export function deactivate(): void {}

// ---------- command bodies ----------

function runInTerminal(name: string, command: string): void {
    const term = vscode.window.createTerminal({ name })
    term.show(true)
    term.sendText(command)
}

async function pickIssueRef(): Promise<string | undefined> {
    const items = await listIssueRefs()
    if (items.length === 0) {
        void vscode.window.showInformationMessage("No issues discovered.")
        return undefined
    }
    const picks: vscode.QuickPickItem[] = items.map((i) => ({
        label: i.ref,
        description: i.title,
        detail: refDetail({
            hasClone: i.hasClone,
            blockedByPRs: i.blockedByPRs,
        }),
    }))
    const chosen = await vscode.window.showQuickPick(picks, { placeHolder: "Pick an issue" })
    return chosen?.label
}

async function pickPrRef(): Promise<string | undefined> {
    const items = await listPrRefs()
    if (items.length === 0) {
        void vscode.window.showInformationMessage("No PRs discovered.")
        return undefined
    }
    const picks: vscode.QuickPickItem[] = items.map((p) => ({
        label: p.ref,
        description: p.title,
        detail: refDetail({
            hasClone: p.hasClone,
            reasonForReview: p.reasonForReview,
            alreadyReviewedAtThisHead: p.alreadyReviewedAtThisHead,
        }),
    }))
    const chosen = await vscode.window.showQuickPick(picks, { placeHolder: "Pick a PR" })
    return chosen?.label
}

function refDetail(i: {
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

async function runDevCommand(refresh: () => void): Promise<void> {
    const ref = await pickIssueRef()
    if (!ref) return
    runInTerminal(`baywatch dev ${ref}`, `baywatch dev --only ${ref}`)
    setTimeout(refresh, 750)
}

async function runReviewCommand(refresh: () => void): Promise<void> {
    const ref = await pickPrRef()
    if (!ref) return
    runInTerminal(`baywatch review ${ref}`, `baywatch review --only ${ref}`)
    setTimeout(refresh, 750)
}

async function editNotesCommand(kind: "issues" | "prs", context: vscode.ExtensionContext): Promise<void> {
    const ref = kind === "issues" ? await pickIssueRef() : await pickPrRef()
    if (!ref) return
    await openNotesPanel(ref, context)
}

async function startClaudeSessionCommand(): Promise<void> {
    // Default to the active workspace folder; let the maintainer browse if they want elsewhere.
    const folders = vscode.workspace.workspaceFolders ?? []
    const picks: Array<vscode.QuickPickItem & { fsPath?: string }> = folders.map((f) => ({
        label: `$(folder) ${f.name}`,
        description: f.uri.fsPath,
        fsPath: f.uri.fsPath,
    }))
    picks.push({ label: "$(folder-opened) Browse…", description: "Pick a directory" })

    const chosen = await vscode.window.showQuickPick(picks, { placeHolder: "Start a Claude Code session in…" })
    if (!chosen) return

    let target: string
    if (chosen.fsPath) {
        target = chosen.fsPath
    } else {
        const browsed = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: "Start session here",
        })
        if (!browsed || browsed.length === 0) return
        target = browsed[0]?.fsPath ?? ""
        if (!target) return
    }

    const sessionName = await vscode.window.showInputBox({
        prompt: "Session name (shows up at claude.ai/code)",
        value: `baywatch-${new Date().toISOString().slice(0, 10)}`,
    })
    if (!sessionName) return

    const term = vscode.window.createTerminal({ name: `claude · ${sessionName}`, cwd: target })
    term.show(true)
    term.sendText(`claude --remote-control "${sessionName.replace(/"/g, '\\"')}"`)
}

async function pushBranchCommand(run?: RunEntry): Promise<void> {
    if (!run || run.kind !== "dev") {
        void vscode.window.showInformationMessage("Right-click a dev run to push its branch.")
        return
    }
    const detail = await getRun(run.runId)
    if (!detail?.agentClonePath || !detail.branch) {
        void vscode.window.showInformationMessage("This run has no agent clone or branch recorded.")
        return
    }
    runInTerminal(
        `baywatch push #${run.runId}`,
        `cd "${detail.agentClonePath}" && git push -u origin "${detail.branch}"`
    )
}

async function openPRCommand(run?: RunEntry): Promise<void> {
    if (!run || run.kind !== "dev") {
        void vscode.window.showInformationMessage("Right-click a dev run to open a PR for its branch.")
        return
    }
    const detail = await getRun(run.runId)
    if (!detail?.agentClonePath || !detail.branch) {
        void vscode.window.showInformationMessage("This run has no agent clone or branch recorded.")
        return
    }
    runInTerminal(
        `baywatch gh pr create #${run.runId}`,
        `cd "${detail.agentClonePath}" && gh pr create --repo ${run.ownerRepo} --head ${detail.branch} --fill --web`
    )
}
