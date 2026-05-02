// Baywatch — VS Code extension entry point.
//
// The extension is a thin shell over the `baywatch` CLI. Anything it does, you can also do
// from a terminal — see vscode/src/cli.ts for the CLI calls and the README for the design.

import * as vscode from "vscode"

import { getRun, listIssueRefs, listPrRefs, runDoctor } from "./cli.js"
import { tailRun } from "./log-channel.js"
import { openNotesPanel } from "./notes-panel.js"
import { ReviewsTreeDataProvider } from "./reviews-tree.js"
import { RunsTreeDataProvider } from "./runs-tree.js"
import { updateStatusBar } from "./status-bar.js"
import type { RunEntry } from "./types.js"

// Bumped on every meaningful change so F5/reinstall is verifiable from the activate toast.
const VERSION_BANNER = "v0.0.2"

export function activate(context: vscode.ExtensionContext): void {
    console.log(`[baywatch] extension activate ${VERSION_BANNER}`)
    void vscode.window.showInformationMessage(`Baywatch ${VERSION_BANNER} ready`)

    const runsProvider = new RunsTreeDataProvider()
    const reviewsProvider = new ReviewsTreeDataProvider()

    context.subscriptions.push(
        vscode.window.registerTreeDataProvider("baywatch.runs", runsProvider),
        vscode.window.registerTreeDataProvider("baywatch.reviews", reviewsProvider)
    )

    // Track which runs we've already auto-surfaced as failed, so we don't keep re-popping the channel.
    const surfacedFailures = new Set<number>()

    const refreshAll = async (): Promise<void> => {
        runsProvider.refresh()
        reviewsProvider.refresh()
        await updateStatusBar(context)
        // Auto-show the log channel for runs that just flipped to failed.
        try {
            const { listRuns } = await import("./cli.js")
            const recent = await listRuns({ limit: 10 })
            for (const r of recent) {
                if (r.status === "failed" && !surfacedFailures.has(r.runId)) {
                    surfacedFailures.add(r.runId)
                    void vscode.window
                        .showErrorMessage(
                            `Baywatch run #${r.runId} failed: ${r.errorSummary ?? "(no error summary)"}`,
                            "Tail log"
                        )
                        .then((choice) => {
                            if (choice === "Tail log" && r.logPath) tailRun(r)
                        })
                }
            }
        } catch {
            // refresh shouldn't error-out the extension; the tree's own error toast handles it.
        }
    }

    // Wrap any registered handler so an unhandled rejection surfaces as an error toast
    // instead of disappearing silently into VS Code's command error sink.
    const guarded =
        <Args extends unknown[]>(label: string, fn: (...args: Args) => Promise<void> | void) =>
        async (...args: Args): Promise<void> => {
            try {
                await fn(...args)
            } catch (err) {
                console.error(`[baywatch] ${label} failed:`, err)
                void vscode.window.showErrorMessage(`Baywatch: ${label} failed — ${(err as Error).message}`)
            }
        }

    context.subscriptions.push(
        vscode.commands.registerCommand(
            "baywatch.refreshRuns",
            guarded("refresh", () => refreshAll())
        ),
        vscode.commands.registerCommand(
            "baywatch.runDev",
            guarded("run dev", () => runDevCommand(runsProvider, () => void refreshAll()))
        ),
        vscode.commands.registerCommand(
            "baywatch.runReview",
            guarded("run review", () => runReviewCommand(runsProvider, () => void refreshAll()))
        ),
        vscode.commands.registerCommand(
            "baywatch.retryRun",
            guarded("retry", (run?: RunEntry) => retryRunCommand(run, runsProvider, () => void refreshAll()))
        ),
        vscode.commands.registerCommand("baywatch.openReview", (run?: RunEntry) => openReviewCommand(run)),
        vscode.commands.registerCommand("baywatch.runDoctor", () => doctorCommand()),
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
    void refreshAll()
    const interval = setInterval(() => void refreshAll(), 10_000)
    context.subscriptions.push({ dispose: () => clearInterval(interval) })

    // First-activation doctor pass: nudges users about setup gaps without being noisy on every refresh.
    void doctorOnActivate()
}

export function deactivate(): void {}

// ---------- command bodies ----------

function runInTerminal(name: string, command: string): vscode.Terminal {
    const term = vscode.window.createTerminal({ name })
    term.show(true)
    term.sendText(command)
    return term
}

// Burst-refresh schedule used right after dispatching a run so the new registry entry
// shows up fast, instead of waiting for the next 10s tick.
function scheduleBurstRefresh(refresh: () => void): void {
    for (const delayMs of [500, 1500, 3000, 6000, 10_000]) {
        setTimeout(refresh, delayMs)
    }
}

function notifyDispatch(kind: "dev" | "review", ref: string, term: vscode.Terminal): void {
    void vscode.window
        .showInformationMessage(`Baywatch: starting ${kind} for ${ref}`, "Show terminal")
        .then((choice) => {
            if (choice === "Show terminal") term.show(true)
        })
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

async function runDevCommand(provider: RunsTreeDataProvider, refresh: () => void): Promise<void> {
    const ref = await pickIssueRef()
    if (!ref) return
    const parsed = parseRef(ref)
    if (parsed) provider.addPending("dev", parsed.ownerRepo, `issue-${parsed.number}`)
    const term = runInTerminal(`baywatch dev ${ref}`, `baywatch dev --only ${ref}`)
    notifyDispatch("dev", ref, term)
    scheduleBurstRefresh(refresh)
}

async function runReviewCommand(provider: RunsTreeDataProvider, refresh: () => void): Promise<void> {
    const ref = await pickPrRef()
    if (!ref) return
    const parsed = parseRef(ref)
    if (parsed) provider.addPending("review", parsed.ownerRepo, `pr-${parsed.number}`)
    const term = runInTerminal(`baywatch review ${ref}`, `baywatch review --only ${ref}`)
    notifyDispatch("review", ref, term)
    scheduleBurstRefresh(refresh)
}

function parseRef(ref: string): { ownerRepo: string; number: number } | null {
    const m = ref.match(/^([^/]+\/[^#]+)#(\d+)$/)
    if (!m?.[1] || !m[2]) return null
    return { ownerRepo: m[1], number: Number.parseInt(m[2], 10) }
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

async function retryRunCommand(
    run: RunEntry | undefined,
    provider: RunsTreeDataProvider,
    refresh: () => void
): Promise<void> {
    if (!run) {
        void vscode.window.showInformationMessage("Right-click a run to retry it.")
        return
    }
    const confirm = await vscode.window.showInformationMessage(
        `Retry run #${run.runId} (${run.kind} ${run.ownerRepo} ${run.target})?`,
        { modal: false },
        "Retry"
    )
    if (confirm !== "Retry") return
    provider.addPending(run.kind, run.ownerRepo, run.target)
    const term = runInTerminal(`baywatch retry #${run.runId}`, `baywatch retry ${run.runId}`)
    notifyDispatch(run.kind, `#${run.runId}`, term)
    scheduleBurstRefresh(refresh)
}

async function openReviewCommand(run?: RunEntry): Promise<void> {
    if (!run || run.kind !== "review") {
        void vscode.window.showInformationMessage("Right-click a review run to open its markdown.")
        return
    }
    const detail = await getRun(run.runId)
    if (!detail?.reviewPath) {
        void vscode.window.showInformationMessage("This review run has no markdown recorded.")
        return
    }
    const doc = await vscode.workspace.openTextDocument(detail.reviewPath)
    await vscode.window.showTextDocument(doc)
}

async function doctorCommand(): Promise<void> {
    const result = await runDoctor()
    const lines = result.checks.map((c) => {
        const icon = c.status === "ok" ? "✓" : c.status === "warn" ? "!" : "✗"
        return `${icon} ${c.name} — ${c.detail}${c.hint ? `\n  → ${c.hint}` : ""}`
    })
    const summary = result.ok ? "All checks passed." : "Some checks failed — see hints below."
    const channel = vscode.window.createOutputChannel("Baywatch · doctor")
    channel.clear()
    channel.appendLine(summary)
    channel.appendLine("")
    channel.appendLine(lines.join("\n"))
    channel.show(true)
}

async function doctorOnActivate(): Promise<void> {
    try {
        const result = await runDoctor()
        if (result.ok) return
        const failed = result.checks.filter((c) => c.status === "fail")
        const choice = await vscode.window.showWarningMessage(
            `Baywatch setup: ${failed.length} check(s) failing — ${failed.map((c) => c.name).join(", ")}`,
            "Show details"
        )
        if (choice === "Show details") await doctorCommand()
    } catch {
        // baywatch CLI not installed — silent. The user has to install it for the extension to be useful anyway.
    }
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
