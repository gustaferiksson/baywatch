#!/usr/bin/env bun
import {
    attachSession,
    loginSession,
    removeSession,
    runSession,
    stopSession,
} from "./agents/session.ts"
import { reviewBundle } from "./agents/review-bundle.ts"
import { reviewPR } from "./agents/review-pr.ts"
import { solveIssue } from "./agents/solve-issue.ts"
import { formatSize, listCloneCandidates, parseDuration, removeClone } from "./clean.ts"
import { BAYWATCH_ROOT, loadConfig } from "./config.ts"
import { discoverIssues, discoverIssuesByRefs, discoverPRs, discoverPRsByRefs } from "./discovery.ts"
import { printDoctorReport, runDoctor } from "./doctor.ts"
import { installSpecs } from "./install-specs.ts"
import { formatAge, formatDuration, listRecentLogs } from "./logs.ts"
import { noteFilePath, readNote, writeNote } from "./notes.ts"
import { pickIssues, pickPRs } from "./picker.ts"
import { pickSession } from "./sessionPicker.ts"
import { findSession, listSessions } from "./sessionsState.ts"
import { cancelRun, getLatestReviewFor, getRun, listRuns } from "./state.ts"
import { $ } from "bun"

const HELP = `baywatch — personal agent orchestrator

USAGE
  baywatch <command> [options]

COMMANDS
  list issues [--json] [REF ...]                              Issues assigned (+ ad-hoc refs)
  list prs [--json] [REF ...]                                 PRs assigned + review-requested (+ ad-hoc refs)
  dev [--dry-run] [--only] [--auto] [--limit N] [REF ...]     Run the dev agent (no args + TTY → picker)
  review [--dry-run] [--only] [--auto] [--limit N] [--force] [REF ...]  Run the review agent (no args + TTY → picker)
  review --bundle REF [REF ...]                               Review multiple PRs together as one cross-PR review
  review --for-issue REF                                      Review every PR actively linked to this issue (Dev panel)
  session [<id|name>]                                         Pick a sandboxed Claude session (no args + TTY → picker)
  session login [--force]                                     One-time setup: log the baywatch identity into Claude
  session new <owner/repo> [--name <n>]                       Start a new sandboxed session for the repo
  session ls [--json]                                         List sandboxed sessions
  session attach <id|name>                                    Reattach a TTY to a running session's tmux/claude
  session stop <id|name>                                      Stop a session's container (keeps clone + metadata)
  session rm <id|name>                                        Stop + delete a session entirely
  logs [<id>] [--follow] [--running] [--json] [--limit N]     Recent agent run logs (id picks one; --follow tails; --json for tooling)
  image-build                                                 Rebuild the baywatch-agent podman image
  clean clones [--older-than 14d] [--dry-run]                 Remove ~/.baywatch/clones/ entries older than threshold (skips in-flight)
  notes <REF> [--print | --path | --write]                    Free-form notes injected into the agent prompt for this REF
  doctor                                                      Pre-flight: gh auth, podman machine, image, env tokens, config
  retry <id>                                                  Re-dispatch the same kind/target as run <id>
  stop [<id>]                                                 Cancel running runs (kills baywatch-agent containers; <id> marks just that run, no id marks all)
  open <id>                                                   Open the most relevant artifact for run <id> (review .md or agent clone)
  install-specs                                               Build & install Fig autocomplete spec
  -h, --help                                                  Show this help

REF
  owner/repo#123      Add this issue/PR to the run on top of auto-discovery (or use --only to skip auto)

FLAGS
  --only              Run only the explicit REFs; skip auto-discovery
  --auto              Skip the interactive picker; take first --limit from discovery
  --force             review: re-run even if already reviewed at the current head SHA
`

const REF_RE = /^[^/]+\/[^#]+#\d+$/
const isRef = (s: string): boolean => REF_RE.test(s)

const printHelpAndExit = (): never => {
    process.stdout.write(HELP)
    process.exit(0)
}

type RunOpts = {
    dryRun: boolean
    limit: number
    refs: string[]
    only: boolean
    auto: boolean
    bundle: boolean
    forIssue: string | null
    force: boolean
}

const parseRunOpts = (argv: string[]): RunOpts => {
    const out: RunOpts = {
        dryRun: false,
        limit: 1,
        refs: [],
        only: false,
        auto: false,
        bundle: false,
        forIssue: null,
        force: false,
    }
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]
        if (a === "--dry-run") {
            out.dryRun = true
        } else if (a === "--only") {
            out.only = true
        } else if (a === "--auto") {
            out.auto = true
        } else if (a === "--force") {
            out.force = true
        } else if (a === "--bundle") {
            out.bundle = true
        } else if (a === "--for-issue") {
            const v = argv[i + 1]
            if (v === undefined) throw new Error("--for-issue requires an issue ref (owner/repo#num)")
            if (!isRef(v)) throw new Error(`bad issue ref for --for-issue: ${v}`)
            out.forIssue = v
            i++
        } else if (a === "--limit") {
            const v = argv[i + 1]
            if (v === undefined) throw new Error("--limit requires a value")
            const n = Number.parseInt(v, 10)
            if (Number.isNaN(n) || n < 1) throw new Error(`--limit must be a positive integer, got ${v}`)
            out.limit = n
            i++
        } else if (a === "-h" || a === "--help") {
            printHelpAndExit()
        } else if (a !== undefined && !a.startsWith("-")) {
            if (!isRef(a)) throw new Error(`bad ref: ${a} (expected owner/repo#num)`)
            out.refs.push(a)
        } else {
            throw new Error(`unknown arg: ${a}`)
        }
    }
    return out
}

type ListOpts = { refs: string[]; json: boolean }

const parseListOpts = (argv: string[]): ListOpts => {
    const out: ListOpts = { refs: [], json: false }
    for (const a of argv) {
        if (a === "-h" || a === "--help") printHelpAndExit()
        if (a === "--json") {
            out.json = true
            continue
        }
        if (a.startsWith("-")) throw new Error(`unknown arg: ${a}`)
        if (!isRef(a)) throw new Error(`bad ref: ${a} (expected owner/repo#num)`)
        out.refs.push(a)
    }
    return out
}

const deriveReviewState = (
    pr: Awaited<ReturnType<typeof discoverPRs>>[number]
): "approve" | "approve-minor" | "needs-changes" | "blocking" | "stale" | "unreviewed" => {
    if (!pr.alreadyReviewedAtThisHead) {
        return pr.lastReviewedAt !== null ? "stale" : "unreviewed"
    }
    if (pr.verdictAtCurrentHead === null) return "approve" // legacy review with no verdict — assume the maintainer trusted it
    return pr.verdictAtCurrentHead
}

const listIssues = async (refs: string[], json: boolean): Promise<void> => {
    const cfg = await loadConfig()
    const issues = await discoverIssues(cfg, refs)
    if (json) {
        const out = issues.map((i) => ({
            ref: `${i.repository.nameWithOwner}#${i.number}`,
            ownerRepo: i.repository.nameWithOwner,
            number: i.number,
            title: i.title,
            url: i.url,
            hasClone: i.repoPath !== null,
            // Full LinkedPR objects (not just numbers) so the extension can open the PR URL.
            linkedOpenPRs: i.linkedOpenPRs,
            // Kept for backwards-compat with consumers that just look at the count.
            blockedByPRs: i.linkedOpenPRs.map((pr) => pr.number),
            // green = PR exists (implemented), red = no PR yet (fresh).
            state: i.linkedOpenPRs.length > 0 ? "implemented" : "open",
        }))
        process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
        return
    }
    if (issues.length === 0) {
        console.log("No issues.")
        return
    }
    for (const i of issues) {
        const local = i.repoPath ? "✓" : "✗ no clone"
        const blocked =
            i.linkedOpenPRs.length > 0
                ? `  [blocked: ${i.linkedOpenPRs.map((pr) => `PR #${pr.number}`).join(", ")}]`
                : ""
        console.log(`${i.repository.nameWithOwner}#${i.number}  [${local}]${blocked}  ${i.title}`)
    }
}

const listPRs = async (refs: string[], json: boolean): Promise<void> => {
    const cfg = await loadConfig()
    const prs = await discoverPRs(cfg, refs)
    if (json) {
        const out = prs.map((pr) => {
            const last = getLatestReviewFor(pr.repository.nameWithOwner, pr.number)
            return {
                ref: `${pr.repository.nameWithOwner}#${pr.number}`,
                ownerRepo: pr.repository.nameWithOwner,
                number: pr.number,
                title: pr.title,
                url: pr.url,
                hasClone: pr.repoPath !== null,
                reasonForReview: pr.reasonForReview,
                alreadyReviewedAtThisHead: pr.alreadyReviewedAtThisHead,
                headRefOid: pr.headRefOid,
                lastReviewedAt: pr.lastReviewedAt,
                lastReviewedHead: pr.lastReviewedHead,
                lastReviewPath: last?.reviewPath ?? null,
                verdictAtCurrentHead: pr.verdictAtCurrentHead,
                // Discriminator for UI rendering. Maps to the review verdict at the current head
                // when one exists, with stale/unreviewed as fallbacks. Color guidance for callers:
                //   approve / approve-minor   → green
                //   needs-changes / stale     → yellow
                //   blocking / unreviewed     → red
                reviewState: deriveReviewState(pr),
            }
        })
        process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
        return
    }
    if (prs.length === 0) {
        console.log("No PRs to review.")
        return
    }
    for (const pr of prs) {
        const local = pr.repoPath ? "✓" : "✗"
        const status = pr.alreadyReviewedAtThisHead ? "reviewed-at-head" : "needs-review"
        console.log(
            `${pr.repository.nameWithOwner}#${pr.number}  [${local}]  [${pr.reasonForReview}]  [${status}]  ${pr.title}`
        )
    }
}

const shouldUsePicker = (opts: RunOpts): boolean => {
    if (opts.refs.length > 0) return false
    if (opts.auto) return false
    return process.stdin.isTTY === true
}

// We can skip the full auto-discovery (and its many gh search + per-result enrichment
// calls) whenever the user's refs already cover what they want — either explicitly via
// --only, or implicitly because they typed enough refs to satisfy --limit. Saves API
// budget by an order of magnitude on targeted invocations.
const canSkipAutoDiscovery = (opts: RunOpts): boolean => {
    if (opts.refs.length === 0) return false
    return opts.only || opts.refs.length >= opts.limit
}

const runDev = async (opts: RunOpts): Promise<void> => {
    if (opts.only && opts.refs.length === 0) throw new Error("--only requires at least one REF")
    const cfg = await loadConfig()
    const all = canSkipAutoDiscovery(opts)
        ? await discoverIssuesByRefs(opts.refs, cfg)
        : await discoverIssues(cfg, opts.refs)

    let issues: typeof all
    if (shouldUsePicker(opts)) {
        if (all.length === 0) {
            console.log("No issues to pick.")
            return
        }
        issues = await pickIssues(all)
    } else {
        issues = selectByRefsAndLimit(all, opts, (i) => `${i.repository.nameWithOwner}#${i.number}`)
    }

    for (const issue of issues) await solveIssue({ issue, config: cfg, dryRun: opts.dryRun })
}

const runReview = async (opts: RunOpts): Promise<void> => {
    if (opts.only && opts.refs.length === 0) throw new Error("--only requires at least one REF")
    const cfg = await loadConfig()

    // Bundle mode: review multiple PRs together as one cross-PR review.
    if (opts.bundle || opts.forIssue) {
        await reviewBundle({ refs: opts.refs, forIssue: opts.forIssue, config: cfg, dryRun: opts.dryRun })
        return
    }

    const all = canSkipAutoDiscovery(opts)
        ? await discoverPRsByRefs(opts.refs, cfg)
        : await discoverPRs(cfg, opts.refs)

    let prs: typeof all
    if (shouldUsePicker(opts)) {
        if (all.length === 0) {
            console.log("No PRs to pick.")
            return
        }
        prs = await pickPRs(all)
    } else {
        prs = selectByRefsAndLimit(all, opts, (pr) => `${pr.repository.nameWithOwner}#${pr.number}`)
    }

    for (const pr of prs) await reviewPR({ pr, config: cfg, dryRun: opts.dryRun, force: opts.force })
}

// Explicit refs always run, in the order the user typed them. --limit caps the total: refs
// displace auto-discovered items. So `review #501` (default --limit 1) processes just #501,
// `review #501 --limit 3` processes #501 + 2 auto, `review --limit 3` processes 3 auto.
// --only restricts to refs and skips auto entirely. Warns when a typed ref didn't make it
// into `all` (typo, blocked, fetch failed) so the user isn't left wondering why nothing happened.
function selectByRefsAndLimit<T>(all: ReadonlyArray<T>, opts: RunOpts, refOf: (item: T) => string): T[] {
    const requested = opts.refs
    const byRef = new Map(all.map((item) => [refOf(item), item] as const))

    const explicit: T[] = []
    for (const ref of requested) {
        const item = byRef.get(ref)
        if (item) explicit.push(item)
        else console.warn(`[discovery] requested ref ${ref} not found in discovery results — skipping`)
    }

    if (opts.only) return explicit

    const explicitRefs = new Set(requested)
    const auto = all.filter((item) => !explicitRefs.has(refOf(item)))
    const remaining = Math.max(0, opts.limit - explicit.length)
    return [...explicit, ...auto.slice(0, remaining)]
}

const runClean = (argv: string[]): void => {
    const sub = argv[0]
    if (sub !== "clones") {
        throw new Error(`unknown 'clean' subcommand: ${sub ?? "(missing)"} — expected 'clones'`)
    }
    let olderThan = "14d"
    let dryRun = false
    for (let i = 1; i < argv.length; i++) {
        const a = argv[i]
        if (a === "--dry-run") dryRun = true
        else if (a === "--older-than") {
            const v = argv[i + 1]
            if (v === undefined) throw new Error("--older-than requires a value (e.g. 14d, 24h, 30m)")
            olderThan = v
            i++
        } else if (a === "-h" || a === "--help") printHelpAndExit()
        else throw new Error(`unknown 'clean clones' arg: ${a}`)
    }

    const olderThanMs = parseDuration(olderThan)
    const candidates = listCloneCandidates({ olderThanMs, dryRun })
    if (candidates.length === 0) {
        console.log(`No clones older than ${olderThan} in ~/.baywatch/clones/.`)
        return
    }

    const removable = candidates.filter((c) => !c.inUse)
    const skipped = candidates.filter((c) => c.inUse)
    const totalBytes = removable.reduce((sum, c) => sum + c.sizeBytes, 0)

    console.log(`${removable.length} clone(s) older than ${olderThan} (${formatSize(totalBytes)}):`)
    for (const c of removable) {
        const age = Math.floor((Date.now() - c.mtime.getTime()) / 86_400_000)
        console.log(`  ${age.toString().padStart(3)}d  ${formatSize(c.sizeBytes).padEnd(8)}  ${c.path}`)
    }
    if (skipped.length > 0) {
        console.log(`\nSkipping ${skipped.length} clone(s) tied to in-flight runs:`)
        for (const c of skipped) console.log(`  (in-use)  ${c.path}`)
    }

    if (dryRun) {
        console.log("\n(dry-run) nothing removed.")
        return
    }
    for (const c of removable) removeClone(c)
    console.log(`\n✓ Removed ${removable.length} clone(s), reclaimed ${formatSize(totalBytes)}.`)
}

const parseRunId = (raw: string | undefined): number => {
    if (!raw) throw new Error("run id required")
    const n = Number.parseInt(raw, 10)
    if (Number.isNaN(n) || n < 1) throw new Error(`bad run id: ${raw}`)
    return n
}

const runRetry = async (argv: string[]): Promise<void> => {
    const id = parseRunId(argv[0])
    const run = getRun(id)
    if (!run) throw new Error(`no run with id ${id}`)
    const m = run.target.match(/^(issue|pr)-(\d+)$/)
    if (!m?.[1] || !m[2]) throw new Error(`run #${id} has unrecognised target ${run.target}`)
    const ref = `${run.ownerRepo}#${m[2]}`
    const cmd = run.kind === "dev" ? "dev" : "review"
    // Retry semantically means "do this again" — for review, that requires --force to bypass
    // the already-reviewed-at-this-head skip. Dev has no equivalent skip so the flag is harmless.
    const args = run.kind === "review" ? [cmd, "--only", "--force", ref] : [cmd, "--only", ref]
    console.log(`retrying #${id}: baywatch ${args.join(" ")}`)
    const proc = Bun.spawn(["baywatch", ...args], { stdout: "inherit", stderr: "inherit", stdin: "inherit" })
    const code = await proc.exited
    if (code !== 0) process.exit(code)
}

// Kills every container spawned from the baywatch-agent image. We don't track container IDs
// per-run yet, so stopping any run kills all in-flight ones. Returns the number killed.
async function killAgentContainers(): Promise<number> {
    const psResult = await $`podman ps -q --filter ancestor=baywatch-agent`.nothrow().quiet()
    if (psResult.exitCode !== 0) {
        console.warn(`[stop] podman ps failed: ${psResult.stderr.toString().trim() || "(no stderr)"}`)
        return 0
    }
    const ids = psResult.stdout.toString().trim().split("\n").filter(Boolean)
    if (ids.length === 0) return 0
    const killResult = await $`podman kill ${ids}`.nothrow().quiet()
    if (killResult.exitCode !== 0) {
        console.warn(`[stop] podman kill failed: ${killResult.stderr.toString().trim() || "(no stderr)"}`)
    }
    return ids.length
}

const runStop = async (argv: string[]): Promise<void> => {
    const first = argv[0]
    if (first === "-h" || first === "--help") {
        printHelpAndExit()
        return
    }

    const running = listRuns({ status: "running" })
    if (running.length === 0) {
        console.log("No running runs.")
        return
    }

    const targets = first !== undefined ? running.filter((r) => r.id === parseRunId(first)) : running
    if (first !== undefined && targets.length === 0) {
        const id = parseRunId(first)
        const r = getRun(id)
        if (!r) throw new Error(`no run with id ${id}`)
        console.log(`run #${id} is not running (status: ${r.status})`)
        return
    }

    if (first !== undefined && running.length > targets.length) {
        console.log(
            `note: stopping #${parseRunId(first)} kills all ${running.length} baywatch-agent container(s) (per-run isolation isn't tracked yet)`
        )
    }

    const killed = await killAgentContainers()
    console.log(`killed ${killed} container(s)`)
    for (const r of targets) {
        const ok = cancelRun(r.id)
        console.log(ok ? `✓ #${r.id} cancelled` : `  #${r.id} already terminated`)
    }
}

const runOpen = async (argv: string[]): Promise<void> => {
    const id = parseRunId(argv[0])
    const run = getRun(id)
    if (!run) throw new Error(`no run with id ${id}`)
    const target = run.kind === "review" ? run.reviewPath : run.agentClonePath
    if (!target) {
        console.log(`run #${id} has no ${run.kind === "review" ? "review markdown" : "agent clone"} recorded.`)
        if (run.logPath) console.log(`(log file: ${run.logPath})`)
        return
    }
    // `code` opens files or folders depending on the path type
    const proc = Bun.spawn(["code", target], { stdout: "inherit", stderr: "inherit" })
    const code = await proc.exited
    if (code !== 0) {
        // Fallback to `open` (macOS) so users without `code` on PATH still get something.
        Bun.spawn(["open", target], { stdout: "inherit", stderr: "inherit" })
    }
}

const runNotes = async (argv: string[]): Promise<void> => {
    const first = argv[0]
    if (first === undefined || first === "-h" || first === "--help") {
        printHelpAndExit()
        return
    }
    const ref = first
    if (!isRef(ref)) throw new Error(`bad ref: ${ref} (expected owner/repo#num)`)

    const flag = argv[1] ?? "--path"

    if (flag === "--path") {
        process.stdout.write(`${noteFilePath(ref)}\n`)
        return
    }

    if (flag === "--print") {
        const note = readNote(ref)
        if (note === null) {
            console.log(`(no notes for ${ref})`)
            return
        }
        process.stdout.write(`${note}\n`)
        return
    }

    if (flag === "--write") {
        // Read from stdin so callers can pipe content in: `cat note.md | baywatch notes <ref> --write`
        const content = await Bun.stdin.text()
        const p = writeNote(ref, content)
        console.log(`✓ wrote ${p}`)
        return
    }

    throw new Error(`unknown 'notes' flag: ${flag} — expected --path, --print, or --write`)
}

const runImageBuild = async (): Promise<void> => {
    const containerfile = `${BAYWATCH_ROOT}/Containerfile`
    console.log(`Building baywatch-agent from ${containerfile}`)
    const proc = Bun.spawn(["podman", "build", "-t", "baywatch-agent", "-f", "Containerfile", "."], {
        cwd: BAYWATCH_ROOT,
        stdout: "inherit",
        stderr: "inherit",
    })
    const code = await proc.exited
    if (code !== 0) throw new Error(`podman build failed (exit ${code})`)
    console.log("✓ baywatch-agent rebuilt")
}

const runLogs = (argv: string[]): Promise<void> => {
    let follow = false
    let limit = 10
    let onlyRunning = false
    let json = false
    let runId: number | null = null
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]
        if (a === "-f" || a === "--follow") follow = true
        else if (a === "--running") onlyRunning = true
        else if (a === "--json") json = true
        else if (a === "--limit") {
            const v = argv[i + 1]
            if (v === undefined) throw new Error("--limit requires a value")
            const n = Number.parseInt(v, 10)
            if (Number.isNaN(n) || n < 1) throw new Error(`--limit must be a positive integer, got ${v}`)
            limit = n
            i++
        } else if (a === "-h" || a === "--help") printHelpAndExit()
        else if (a !== undefined && !a.startsWith("-")) {
            const n = Number.parseInt(a, 10)
            if (Number.isNaN(n)) throw new Error(`expected a numeric run id, got ${a}`)
            runId = n
        } else throw new Error(`unknown 'logs' arg: ${a}`)
    }

    const logs = listRecentLogs({ limit, ...(onlyRunning ? { status: "running" as const } : {}) })

    if (runId !== null) {
        const target = logs.find((l) => l.runId === runId)
        if (!target) throw new Error(`no run with id ${runId} (try \`baywatch logs --limit 50\`)`)
        if (json) {
            process.stdout.write(`${JSON.stringify(target, null, 2)}\n`)
            return Promise.resolve()
        }
        if (follow) {
            if (!target.logPath) {
                console.log(`Run #${runId} has no log file yet.`)
                return Promise.resolve()
            }
            console.log(`Tailing ${target.logPath}\n`)
            const proc = Bun.spawn(["tail", "-f", target.logPath], { stdout: "inherit", stderr: "inherit" })
            return proc.exited.then(() => undefined)
        }
        printRun(target)
        return Promise.resolve()
    }

    if (json) {
        process.stdout.write(`${JSON.stringify(logs, null, 2)}\n`)
        return Promise.resolve()
    }

    if (logs.length === 0) {
        console.log("No runs found.")
        return Promise.resolve()
    }

    if (follow) {
        const latest = logs.find((l) => l.logPath)
        if (!latest?.logPath) {
            console.log("No log file available yet for the most recent run.")
            return Promise.resolve()
        }
        console.log(`Tailing ${latest.logPath}\n`)
        const proc = Bun.spawn(["tail", "-f", latest.logPath], { stdout: "inherit", stderr: "inherit" })
        return proc.exited.then(() => undefined)
    }

    for (const log of logs) printRun(log)
    return Promise.resolve()
}

const printRun = (log: ReturnType<typeof listRecentLogs>[number]): void => {
    const age = formatAge(log.startedAt).padEnd(9)
    const dur = formatDuration(log.startedAt, log.finishedAt).padEnd(7)
    const kind = log.kind.padEnd(6)
    const status = log.status.padEnd(7)
    console.log(`#${String(log.runId).padEnd(4)} ${age} ${dur} [${kind}] [${status}] ${log.ownerRepo} ${log.target}`)
    if (log.logPath) console.log(`              ${log.logPath}`)
    if (log.status === "failed" && log.errorSummary) console.log(`              error: ${log.errorSummary}`)
}

// ----- session subcommands -----

const REPO_RE = /^[^/]+\/[^/]+$/

const runSessionCmd = async (argv: string[]): Promise<void> => {
    const sub = argv[0]
    if (sub === "-h" || sub === "--help") {
        printHelpAndExit()
        return
    }
    switch (sub) {
        case "new":
            await runSessionNew(argv.slice(1))
            return
        case "login": {
            const force = argv.slice(1).includes("--force")
            await loginSession({ force })
            return
        }
        case "ls":
            await runSessionLs(argv.slice(1))
            return
        case "attach": {
            const target = argv[1]
            if (!target) throw new Error("session attach requires <id|name>")
            await attachSession(target)
            return
        }
        case "stop": {
            const target = argv[1]
            if (!target) throw new Error("session stop requires <id|name>")
            const s = await stopSession(target)
            console.log(`✓ ${s.id} stopped`)
            return
        }
        case "rm": {
            const target = argv[1]
            if (!target) throw new Error("session rm requires <id|name>")
            const s = await removeSession(target)
            console.log(`✓ ${s.id} removed`)
            return
        }
        case undefined:
            await runSessionPick(null)
            return
        default:
            // Treat bare arg as id/name: `baywatch session ab12cd`
            await runSessionPick(sub)
    }
}

const runSessionNew = async (argv: string[]): Promise<void> => {
    let repo: string | null = null
    let name: string | null = null
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]
        if (a === "--name") {
            const v = argv[i + 1]
            if (v === undefined) throw new Error("--name requires a value")
            name = v
            i++
        } else if (a === "-h" || a === "--help") {
            printHelpAndExit()
        } else if (a !== undefined && !a.startsWith("-")) {
            if (repo !== null) throw new Error(`unexpected positional: ${a}`)
            repo = a
        } else {
            throw new Error(`unknown arg: ${a}`)
        }
    }
    if (!repo) throw new Error("session new requires an owner/repo argument")
    if (!REPO_RE.test(repo)) throw new Error(`bad repo (expected owner/name): ${repo}`)
    const config = await loadConfig()
    const sessionName = name ?? `${repo.split("/")[1]}-${Date.now().toString(36).slice(-4)}`
    const meta = await runSession({ repo, name: sessionName, config })
    console.log(`✓ session ${meta.id} started`)
    console.log(`  name:      ${meta.name}`)
    console.log(`  repo:      ${meta.repo}`)
    console.log(`  branch:    ${meta.branch}`)
    console.log(`  clone:     ${meta.clonePath}`)
    console.log(`  container: ${meta.containerName}`)
    if (meta.rcEnvironmentUrl) console.log(`  url:       ${meta.rcEnvironmentUrl}`)
}

const runSessionLs = async (argv: string[]): Promise<void> => {
    const json = argv.includes("--json")
    const sessions = await listSessions()
    if (json) {
        process.stdout.write(`${JSON.stringify(sessions, null, 2)}\n`)
        return
    }
    if (sessions.length === 0) {
        console.log("No sessions.")
        return
    }
    for (const s of sessions) {
        console.log(`${s.id}  [${s.state.padEnd(14)}]  ${s.name.padEnd(30)}  ${s.repo}`)
        if (s.rcEnvironmentUrl) console.log(`        ${s.rcEnvironmentUrl}`)
    }
}

const runSessionPick = async (idOrName: string | null): Promise<void> => {
    if (idOrName) {
        const s = await findSession(idOrName)
        if (!s) throw new Error(`No session matching '${idOrName}'`)
        await attachSession(s.id)
        return
    }

    if (process.stdin.isTTY !== true) {
        // Not a TTY — fall back to ls so scripts don't hang on the picker.
        await runSessionLs([])
        return
    }

    const config = await loadConfig()
    const result = await pickSession(config)
    if (result === null) return
    if (result.kind === "new") {
        const meta = await runSession({ repo: result.repo, name: result.name, config })
        console.log(`✓ session ${meta.id} started — attaching…`)
        if (meta.rcEnvironmentUrl) console.log(`  ${meta.rcEnvironmentUrl}`)
        await attachSession(meta.id)
        return
    }
    await attachSession(result.row.id)
}

const argv = process.argv.slice(2)
const cmd = argv[0]

if (!cmd || cmd === "-h" || cmd === "--help") printHelpAndExit()

try {
    switch (cmd) {
        case "list": {
            const sub = argv[1]
            if (sub === "issues") {
                const opts = parseListOpts(argv.slice(2))
                await listIssues(opts.refs, opts.json)
            } else if (sub === "prs") {
                const opts = parseListOpts(argv.slice(2))
                await listPRs(opts.refs, opts.json)
            } else throw new Error(`unknown 'list' subcommand: ${sub ?? "(missing)"}`)
            break
        }
        case "dev":
            await runDev(parseRunOpts(argv.slice(1)))
            break
        case "review":
            await runReview(parseRunOpts(argv.slice(1)))
            break
        case "session":
            await runSessionCmd(argv.slice(1))
            break
        case "logs":
            await runLogs(argv.slice(1))
            break
        case "image-build":
            await runImageBuild()
            break
        case "clean":
            runClean(argv.slice(1))
            break
        case "notes":
            await runNotes(argv.slice(1))
            break
        case "doctor": {
            const result = await runDoctor()
            printDoctorReport(result)
            if (!result.ok) process.exit(1)
            break
        }
        case "retry":
            await runRetry(argv.slice(1))
            break
        case "stop":
            await runStop(argv.slice(1))
            break
        case "open":
            await runOpen(argv.slice(1))
            break
        case "install-specs":
            await installSpecs()
            break
        default:
            throw new Error(`unknown command: ${cmd}`)
    }
} catch (err) {
    process.stderr.write(`baywatch: ${(err as Error).message}\n`)
    process.exit(1)
}
