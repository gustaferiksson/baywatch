// Baywatch — VS Code extension entry point.
//
// The extension is a thin shell over the `baywatch` CLI. Anything it does, you can also do
// from a terminal — see vscode/src/cli.ts for the CLI calls and the README for the design.

import * as vscode from "vscode"

import { getRun, listIssueRefs, listPrRefs, runDoctor } from "./cli.js"
import { IssueQueueTreeDataProvider } from "./issue-queue-tree.js"
import { tailRun } from "./log-channel.js"
import { openNotesPanel } from "./notes-panel.js"
import { PrQueueTreeDataProvider } from "./pr-queue-tree.js"
import { ReviewsTreeDataProvider } from "./reviews-tree.js"
import { RunsTreeDataProvider } from "./runs-tree.js"
import { updateStatusBar } from "./status-bar.js"
import type { IssueRef, PrRef, RunEntry } from "./types.js"

// Bumped on every meaningful change so F5/reinstall is verifiable from the activate toast.
const VERSION_BANNER = "v0.0.14"

export function activate(context: vscode.ExtensionContext): void {
    console.log(`[baywatch] extension activate ${VERSION_BANNER}`)
    void vscode.window.showInformationMessage(`Baywatch ${VERSION_BANNER} ready`)

    const runsProvider = new RunsTreeDataProvider()
    const issueQueueProvider = new IssueQueueTreeDataProvider()
    const prQueueProvider = new PrQueueTreeDataProvider()
    const reviewsProvider = new ReviewsTreeDataProvider()

    context.subscriptions.push(
        vscode.window.registerTreeDataProvider("baywatch.runs", runsProvider),
        vscode.window.registerTreeDataProvider("baywatch.issueQueue", issueQueueProvider),
        vscode.window.registerTreeDataProvider("baywatch.prQueue", prQueueProvider),
        vscode.window.registerTreeDataProvider("baywatch.reviews", reviewsProvider)
    )

    // Track which runs we've already auto-surfaced as failed, so we don't keep re-popping the channel.
    const surfacedFailures = new Set<number>()

    // Cheap refresh — runs (local SQLite) + reviews (local filesystem) + status bar.
    // Hits no gh API; safe to poll at high frequency.
    const refreshLocalOnly = async (): Promise<void> => {
        runsProvider.refresh()
        reviewsProvider.refresh()
        await updateStatusBar(context)
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

    // Full refresh — also hits issue/PR queues which run `baywatch list issues|prs --json`,
    // which in turn hit gh's API (assigned issues, review-requested PRs, GraphQL linked-PR
    // lookups per issue). Reserved for explicit user action and post-dispatch burst — never
    // on the auto-poll timer, since rate limits add up fast.
    const refreshAll = async (): Promise<void> => {
        issueQueueProvider.refresh()
        prQueueProvider.refresh()
        await refreshLocalOnly()
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
        vscode.commands.registerCommand(
            "baywatch.queueReviewPr",
            guarded("review queued PR", (pr?: PrRef) => queueReviewPrCommand(pr, runsProvider, () => void refreshAll()))
        ),
        vscode.commands.registerCommand(
            "baywatch.queueIssueAction",
            guarded("issue action", (issue?: IssueRef) =>
                queueIssueActionCommand(issue, runsProvider, () => void refreshAll())
            )
        ),
        vscode.commands.registerCommand(
            "baywatch.reviewLinkedBundle",
            guarded("review linked bundle", (issue?: IssueRef) =>
                reviewLinkedBundleCommand(issue, runsProvider, () => void refreshAll())
            )
        ),
        vscode.commands.registerCommand("baywatch.openIssueOnGithub", async (issue?: IssueRef) => {
            if (issue?.url) await openOnGithub(issue.url, "issue")
        }),
        vscode.commands.registerCommand("baywatch.openPrOnGithub", async (pr?: PrRef) => {
            if (pr?.url) await openOnGithub(pr.url, "pr")
        }),
        vscode.commands.registerCommand("baywatch.openInExternalBrowser", async (item?: { url?: string }) => {
            if (item?.url) await vscode.env.openExternal(vscode.Uri.parse(item.url))
        }),
        vscode.commands.registerCommand("baywatch.followLive", async () => {
            // claude.ai/code lists every active remote-controlled session — including the
            // ones our sandbox spawns since they boot with remoteControlAtStartup: true.
            // Find the one named `issue-<n>` / `review-<n>` (or whatever the run.name is).
            await vscode.env.openExternal(vscode.Uri.parse("https://claude.ai/code"))
        }),
        vscode.commands.registerCommand("baywatch.tailLog", (run?: RunEntry) => {
            if (run) tailRun(run)
        }),
        vscode.commands.registerCommand(
            "baywatch.openLog",
            guarded("open log", async (run?: RunEntry) => {
                console.log(`[baywatch] openLog #${run?.runId} logPath=${run?.logPath ?? "(none)"}`)
                if (!run?.logPath) {
                    void vscode.window.showInformationMessage("No log file recorded for this run yet.")
                    return
                }
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(run.logPath))
                await vscode.window.showTextDocument(doc, { preview: false })
            })
        ),
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

    // Initial draw: full refresh once on activate. After that, the auto-poll only refreshes
    // local trees (runs, reviews) — issue + PR queues are gh-API-backed and getting refreshed
    // on every tick maxed out the rate limit. Queues now refresh on user action only:
    //   - clicking the status bar / running `Baywatch: Refresh`
    //   - dispatching a run (burst refresh)
    //   - re-activating the extension
    void refreshAll()
    let pollTimer: ReturnType<typeof setTimeout> | null = null
    const scheduleNextPoll = async (): Promise<void> => {
        let nextMs = 30_000
        try {
            const { listRuns } = await import("./cli.js")
            const running = await listRuns({ running: true, limit: 5 })
            if (running.length > 0) nextMs = 10_000
        } catch {
            // CLI failure shouldn't break the polling loop — fall back to slow interval.
        }
        pollTimer = setTimeout(async () => {
            await refreshLocalOnly()
            void scheduleNextPoll()
        }, nextMs)
    }
    void scheduleNextPoll()
    context.subscriptions.push({
        dispose: () => {
            if (pollTimer) clearTimeout(pollTimer)
        },
    })

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

// Open a GitHub URL using the official GitHub Pull Requests extension's internal
// view (`pr.openDescription` / `issue.openIssue`) when possible. Falls back to the OS
// browser if the extension isn't installed or rejects the call.
async function openOnGithub(url: string, kind: "pr" | "issue"): Promise<void> {
    const cmd = kind === "pr" ? "pr.openDescription" : "issue.openIssue"
    const ext = vscode.extensions.getExtension("GitHub.vscode-pull-request-github")
    if (ext) {
        if (!ext.isActive) {
            try {
                await ext.activate()
            } catch (err) {
                console.warn(`[baywatch] activating GitHub PR extension failed: ${(err as Error).message}`)
            }
        }
        const uri = vscode.Uri.parse(url)
        // Try with a parsed URI first, then with the raw URL string — the extension's
        // command signatures aren't part of its public API so we attempt the most
        // common shapes before giving up.
        for (const arg of [uri, url] as const) {
            try {
                await vscode.commands.executeCommand(cmd, arg)
                return
            } catch (err) {
                console.log(
                    `[baywatch] ${cmd} with ${typeof arg === "string" ? "string" : "Uri"} failed: ${(err as Error).message}`
                )
            }
        }
    }
    console.log(`[baywatch] falling back to OS browser for ${url}`)
    await vscode.env.openExternal(vscode.Uri.parse(url))
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
    console.log("[baywatch] pickIssueRef: listIssueRefs")
    const items = await listIssueRefs()
    console.log(`[baywatch] pickIssueRef: got ${items.length} item(s)`)
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
    console.log("[baywatch] pickPrRef: listPrRefs")
    const items = await listPrRefs()
    console.log(`[baywatch] pickPrRef: got ${items.length} item(s)`)
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
    console.log("[baywatch] runDev: open picker")
    const ref = await pickIssueRef()
    console.log(`[baywatch] runDev: picker → ${ref ?? "(cancelled)"}`)
    if (!ref) return
    const parsed = parseRef(ref)
    if (parsed) provider.addPending("dev", parsed.ownerRepo, `issue-${parsed.number}`)
    const term = runInTerminal(`baywatch dev ${ref}`, `baywatch dev --only ${ref}`)
    notifyDispatch("dev", ref, term)
    scheduleBurstRefresh(refresh)
    console.log("[baywatch] runDev: done")
}

async function runReviewCommand(provider: RunsTreeDataProvider, refresh: () => void): Promise<void> {
    console.log("[baywatch] runReview: open picker")
    const ref = await pickPrRef()
    console.log(`[baywatch] runReview: picker → ${ref ?? "(cancelled)"}`)
    if (!ref) return
    const parsed = parseRef(ref)
    if (parsed) provider.addPending("review", parsed.ownerRepo, `pr-${parsed.number}`)
    const term = runInTerminal(`baywatch review ${ref}`, `baywatch review --only ${ref}`)
    notifyDispatch("review", ref, term)
    scheduleBurstRefresh(refresh)
    console.log("[baywatch] runReview: done")
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

async function queueIssueActionCommand(
    issue: IssueRef | undefined,
    provider: RunsTreeDataProvider,
    refresh: () => void
): Promise<void> {
    if (!issue) return
    // If a PR already exists for this issue, default to opening it — that's what the
    // user is implicitly checking when they click a green issue.
    if (issue.state === "implemented") {
        const first = issue.linkedOpenPRs[0]
        if (first) {
            await vscode.env.openExternal(vscode.Uri.parse(first.url))
            return
        }
    }
    // Otherwise: red issue → run the dev agent on it.
    const parsed = parseRef(issue.ref)
    if (parsed) provider.addPending("dev", parsed.ownerRepo, `issue-${parsed.number}`)
    const term = runInTerminal(`baywatch dev ${issue.ref}`, `baywatch dev --only ${issue.ref}`)
    notifyDispatch("dev", issue.ref, term)
    scheduleBurstRefresh(refresh)
}

async function reviewLinkedBundleCommand(
    issue: IssueRef | undefined,
    provider: RunsTreeDataProvider,
    refresh: () => void
): Promise<void> {
    if (!issue) {
        void vscode.window.showInformationMessage("Right-click an issue to review its linked PRs as a bundle.")
        return
    }
    if (issue.linkedOpenPRs.length === 0) {
        void vscode.window.showInformationMessage(
            `${issue.ref} has no linked PRs in the Development panel — link them on GitHub first.`
        )
        return
    }
    // Add a pending entry for each linked PR so the user sees the runs tree pop with rows.
    for (const linked of issue.linkedOpenPRs) {
        const m = linked.url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/)
        if (m?.[1] && m[2]) provider.addPending("review", m[1], `pr-${m[2]}`)
    }
    const term = runInTerminal(`baywatch review --for-issue ${issue.ref}`, `baywatch review --for-issue ${issue.ref}`)
    notifyDispatch("review", `bundle for ${issue.ref}`, term)
    scheduleBurstRefresh(refresh)
}

async function queueReviewPrCommand(
    pr: PrRef | undefined,
    provider: RunsTreeDataProvider,
    refresh: () => void
): Promise<void> {
    if (!pr) return
    const parsed = parseRef(pr.ref)
    if (parsed) provider.addPending("review", parsed.ownerRepo, `pr-${parsed.number}`)
    const term = runInTerminal(`baywatch review ${pr.ref}`, `baywatch review --only ${pr.ref}`)
    notifyDispatch("review", pr.ref, term)
    scheduleBurstRefresh(refresh)
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
