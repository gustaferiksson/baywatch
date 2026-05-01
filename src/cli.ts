#!/usr/bin/env bun
import { reviewPR } from "./agents/review-pr.ts"
import { solveIssue } from "./agents/solve-issue.ts"
import { BAYWATCH_ROOT, loadConfig } from "./config.ts"
import { discoverIssues, discoverPRs } from "./discovery.ts"
import { installSpecs } from "./install-specs.ts"
import { formatAge, formatDuration, listRecentLogs } from "./logs.ts"
import { pickIssues, pickPRs } from "./picker.ts"

const HELP = `baywatch — personal agent orchestrator

USAGE
  baywatch <command> [options]

COMMANDS
  list issues [--json] [REF ...]                              Issues assigned (+ ad-hoc refs)
  list prs [--json] [REF ...]                                 PRs assigned + review-requested (+ ad-hoc refs)
  dev [--dry-run] [--only] [--auto] [--limit N] [REF ...]     Run the dev agent (no args + TTY → picker)
  review [--dry-run] [--only] [--auto] [--limit N] [REF ...]  Run the review agent (no args + TTY → picker)
  logs [<id>] [--follow] [--running] [--json] [--limit N]     Recent agent run logs (id picks one; --follow tails; --json for tooling)
  image-build                                                 Rebuild the baywatch-agent podman image
  install-specs                                               Build & install Fig autocomplete spec
  -h, --help                                                  Show this help

REF
  owner/repo#123      Add this issue/PR to the run on top of auto-discovery (or use --only to skip auto)

FLAGS
  --only              Run only the explicit REFs; skip auto-discovery
  --auto              Skip the interactive picker; take first --limit from discovery
`

const REF_RE = /^[^/]+\/[^#]+#\d+$/
const isRef = (s: string): boolean => REF_RE.test(s)

const printHelpAndExit = (): never => {
    process.stdout.write(HELP)
    process.exit(0)
}

type RunOpts = { dryRun: boolean; limit: number; refs: string[]; only: boolean; auto: boolean }

const parseRunOpts = (argv: string[]): RunOpts => {
    const out: RunOpts = { dryRun: false, limit: 1, refs: [], only: false, auto: false }
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]
        if (a === "--dry-run") {
            out.dryRun = true
        } else if (a === "--only") {
            out.only = true
        } else if (a === "--auto") {
            out.auto = true
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
            blockedByPRs: i.linkedOpenPRs.map((pr) => pr.number),
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
        const out = prs.map((pr) => ({
            ref: `${pr.repository.nameWithOwner}#${pr.number}`,
            ownerRepo: pr.repository.nameWithOwner,
            number: pr.number,
            title: pr.title,
            url: pr.url,
            hasClone: pr.repoPath !== null,
            reasonForReview: pr.reasonForReview,
            alreadyReviewedAtThisHead: pr.alreadyReviewedAtThisHead,
            headRefOid: pr.headRefOid,
        }))
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

const runDev = async (opts: RunOpts): Promise<void> => {
    if (opts.only && opts.refs.length === 0) throw new Error("--only requires at least one REF")
    const cfg = await loadConfig()
    const all = await discoverIssues(cfg, opts.refs)

    let issues: typeof all
    if (shouldUsePicker(opts)) {
        if (all.length === 0) {
            console.log("No issues to pick.")
            return
        }
        issues = await pickIssues(all)
    } else {
        const filtered = opts.only
            ? all.filter((i) => opts.refs.includes(`${i.repository.nameWithOwner}#${i.number}`))
            : all
        issues = filtered.slice(0, opts.limit)
    }

    for (const issue of issues) await solveIssue({ issue, config: cfg, dryRun: opts.dryRun })
}

const runReview = async (opts: RunOpts): Promise<void> => {
    if (opts.only && opts.refs.length === 0) throw new Error("--only requires at least one REF")
    const cfg = await loadConfig()
    const all = await discoverPRs(cfg, opts.refs)

    let prs: typeof all
    if (shouldUsePicker(opts)) {
        if (all.length === 0) {
            console.log("No PRs to pick.")
            return
        }
        prs = await pickPRs(all)
    } else {
        const filtered = opts.only
            ? all.filter((pr) => opts.refs.includes(`${pr.repository.nameWithOwner}#${pr.number}`))
            : all
        prs = filtered.slice(0, opts.limit)
    }

    for (const pr of prs) await reviewPR({ pr, config: cfg, dryRun: opts.dryRun })
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
        case "logs":
            await runLogs(argv.slice(1))
            break
        case "image-build":
            await runImageBuild()
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
