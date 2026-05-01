#!/usr/bin/env bun
import { reviewPR } from "./agents/review-pr.ts"
import { solveIssue } from "./agents/solve-issue.ts"
import { loadConfig } from "./config.ts"
import { discoverIssues, discoverPRs } from "./discovery.ts"
import { installSpecs } from "./install-specs.ts"

const HELP = `baywatch — personal agent orchestrator

USAGE
  baywatch <command> [options]

COMMANDS
  list issues [REF ...]                             Issues assigned (+ ad-hoc refs)
  list prs [REF ...]                                PRs assigned + review-requested (+ ad-hoc refs)
  dev [--dry-run] [--limit N] [REF ...]             Run the dev agent (+ ad-hoc issue refs) (stub)
  review [--dry-run] [--limit N] [REF ...]          Run the review agent (+ ad-hoc PR refs) (stub)
  install-specs                                     Build & install Fig autocomplete spec
  -h, --help                                        Show this help

REF
  owner/repo#123      Add this issue/PR to the run on top of auto-discovery
`

const REF_RE = /^[^/]+\/[^#]+#\d+$/
const isRef = (s: string): boolean => REF_RE.test(s)

const printHelpAndExit = (): never => {
    process.stdout.write(HELP)
    process.exit(0)
}

type RunOpts = { dryRun: boolean; limit: number; refs: string[] }

const parseRunOpts = (argv: string[]): RunOpts => {
    const out: RunOpts = { dryRun: false, limit: 1, refs: [] }
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]
        if (a === "--dry-run") {
            out.dryRun = true
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

const parseRefArgs = (argv: string[]): string[] => {
    const out: string[] = []
    for (const a of argv) {
        if (a === "-h" || a === "--help") printHelpAndExit()
        if (a.startsWith("-")) throw new Error(`unknown arg: ${a}`)
        if (!isRef(a)) throw new Error(`bad ref: ${a} (expected owner/repo#num)`)
        out.push(a)
    }
    return out
}

const listIssues = async (refs: string[]): Promise<void> => {
    const cfg = await loadConfig()
    const issues = await discoverIssues(cfg, refs)
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

const listPRs = async (refs: string[]): Promise<void> => {
    const cfg = await loadConfig()
    const prs = await discoverPRs(cfg, refs)
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

const runDev = async (opts: RunOpts): Promise<void> => {
    const cfg = await loadConfig()
    const issues = (await discoverIssues(cfg, opts.refs)).slice(0, opts.limit)
    for (const issue of issues) await solveIssue({ issue, config: cfg, dryRun: opts.dryRun })
}

const runReview = async (opts: RunOpts): Promise<void> => {
    const cfg = await loadConfig()
    const prs = (await discoverPRs(cfg, opts.refs)).slice(0, opts.limit)
    for (const pr of prs) await reviewPR({ pr, config: cfg, dryRun: opts.dryRun })
}

const argv = process.argv.slice(2)
const cmd = argv[0]

if (!cmd || cmd === "-h" || cmd === "--help") printHelpAndExit()

try {
    switch (cmd) {
        case "list": {
            const sub = argv[1]
            if (sub === "issues") await listIssues(parseRefArgs(argv.slice(2)))
            else if (sub === "prs") await listPRs(parseRefArgs(argv.slice(2)))
            else throw new Error(`unknown 'list' subcommand: ${sub ?? "(missing)"}`)
            break
        }
        case "dev":
            await runDev(parseRunOpts(argv.slice(1)))
            break
        case "review":
            await runReview(parseRunOpts(argv.slice(1)))
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
