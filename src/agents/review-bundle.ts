import { existsSync, mkdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { claudeCode, run } from "@ai-hero/sandcastle"
import { podman } from "@ai-hero/sandcastle/sandboxes/podman"

import { loadAgentEnv } from "../agentEnv.ts"
import { BAYWATCH_ROOT, type BaywatchConfig } from "../config.ts"
import { findActivelyLinkedOpenPRs, getPR, type PR } from "../gh.ts"
import { parseVerdict } from "../reviewVerdict.ts"
import { completeRun, recordReview, startRun } from "../state.ts"

const SANDBOX_IMAGE = "baywatch-agent"
const PROMPT_PATH = path.join(BAYWATCH_ROOT, "prompts", "review-bundle.md")
const REVIEWS_HOST_DIR = path.join(BAYWATCH_ROOT, "reviews")
const REVIEWS_SANDBOX_DIR = "/baywatch-reviews"
const SETTINGS_HOST_PATH = path.join(BAYWATCH_ROOT, ".claude", "settings.json")
const SETTINGS_SANDBOX_PATH = "/home/agent/.claude/settings.json"

// Pre-fetch a PR's diff on the host so we can inline it into the bundle prompt without
// the sandbox needing gh credentials. Same pattern as the single-PR review flow.
async function fetchDiff(ownerRepo: string, prNumber: number): Promise<string> {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && k !== "GITHUB_TOKEN" && k !== "GH_TOKEN") env[k] = v
    }
    const proc = Bun.spawn(["gh", "pr", "diff", String(prNumber), "--repo", ownerRepo], {
        env,
        stdout: "pipe",
        stderr: "pipe",
    })
    const diff = await new Response(proc.stdout).text()
    if ((await proc.exited) !== 0) throw new Error(`gh pr diff ${ownerRepo}#${prNumber} failed`)
    return diff
}

function renderBundleBody(prsWithDiffs: ReadonlyArray<{ pr: PR; diff: string }>): string {
    return prsWithDiffs
        .map(({ pr, diff }, i) => {
            const ref = `${pr.repository.nameWithOwner}#${pr.number}`
            return [
                `### PR ${i + 1} of ${prsWithDiffs.length}: ${ref} — ${pr.title}`,
                ``,
                `**URL:** ${pr.url}`,
                `**Branch:** \`${pr.headRefName}\` → \`${pr.baseRefName}\`  ·  **Head SHA:** \`${pr.headRefOid}\``,
                ``,
                `#### Body`,
                ``,
                pr.body || "(empty)",
                ``,
                `#### Diff`,
                ``,
                "```diff",
                diff,
                "```",
            ].join("\n")
        })
        .join("\n\n---\n\n")
}

function bundleSlug(prs: ReadonlyArray<PR>, forIssue: string | null): string {
    if (forIssue) return forIssue.replace(/[/#]/g, "_")
    const refs = prs.map((p) => `${p.repository.nameWithOwner.replace("/", "_")}-${p.number}`)
    return refs.length <= 3 ? refs.join("__") : `${refs.length}prs__${Date.now()}`
}

// Resolve PRs from either explicit refs or an active-linked-issue lookup.
async function resolveBundlePRs(opts: { refs: string[]; forIssue: string | null }): Promise<PR[]> {
    if (opts.forIssue) {
        const m = opts.forIssue.match(/^([^/]+\/[^#]+)#(\d+)$/)
        if (!m?.[1] || !m[2]) throw new Error(`bad --for-issue ref: ${opts.forIssue} (expected owner/repo#num)`)
        const ownerRepo = m[1]
        const num = Number.parseInt(m[2], 10)
        const linked = await findActivelyLinkedOpenPRs(ownerRepo, num)
        if (linked.length === 0) {
            throw new Error(
                `${opts.forIssue} has no actively-linked open PRs (link them via the issue's Development panel on GitHub)`
            )
        }
        return linked
    }
    if (opts.refs.length === 0) throw new Error("--bundle requires at least one PR ref or use --for-issue")
    const fetched = await Promise.all(
        opts.refs.map(async (ref) => {
            const m = ref.match(/^([^/]+\/[^#]+)#(\d+)$/)
            if (!m?.[1] || !m[2]) throw new Error(`bad PR ref: ${ref} (expected owner/repo#num)`)
            return getPR(m[1], Number.parseInt(m[2], 10))
        })
    )
    return fetched
}

export async function reviewBundle(opts: {
    refs: string[]
    forIssue: string | null
    config: BaywatchConfig
    dryRun: boolean
}): Promise<void> {
    const { config, dryRun } = opts

    const prs = await resolveBundlePRs(opts)
    console.log(`[review-bundle] ${prs.length} PR(s):`)
    for (const pr of prs) console.log(`  - ${pr.repository.nameWithOwner}#${pr.number}  ${pr.title}`)

    if (dryRun) {
        console.log("[review-bundle] (dry-run) would fetch diffs and run sandcastle")
        return
    }

    if (!existsSync(REVIEWS_HOST_DIR)) mkdirSync(REVIEWS_HOST_DIR, { recursive: true })
    const slug = bundleSlug(prs, opts.forIssue)
    const reviewFilename = `bundle__${slug}.md`
    const submitFilename = `bundle__${slug}__submit-review.sh`
    const reviewHostPath = path.join(REVIEWS_HOST_DIR, reviewFilename)
    const reviewSandboxPath = `${REVIEWS_SANDBOX_DIR}/${reviewFilename}`
    const submitSandboxPath = `${REVIEWS_SANDBOX_DIR}/${submitFilename}`

    console.log("[review-bundle] fetching diffs on host…")
    const prsWithDiffs = await Promise.all(
        prs.map(async (pr) => ({ pr, diff: await fetchDiff(pr.repository.nameWithOwner, pr.number) }))
    )

    const cwdRepo = prs[0]?.repository.nameWithOwner ?? ""
    const issueContext = opts.forIssue
        ? `**Anchored on issue:** ${opts.forIssue} — these PRs are actively linked to it via the GitHub Development panel.\n`
        : "_No anchor issue — bundle assembled from explicit refs._\n"

    const target = opts.forIssue
        ? `bundle-${opts.forIssue.replace(/[/]/g, "_")}`
        : `bundle-${prs.length}prs-${Date.now()}`
    const runId = startRun({
        kind: "review",
        ownerRepo: cwdRepo,
        target,
        reviewPath: reviewHostPath,
    })

    try {
        const result = await run({
            agent: claudeCode(config.agent.model),
            sandbox: podman({
                imageName: SANDBOX_IMAGE,
                selinuxLabel: false,
                env: loadAgentEnv(),
                mounts: [
                    { hostPath: REVIEWS_HOST_DIR, sandboxPath: REVIEWS_SANDBOX_DIR },
                    { hostPath: SETTINGS_HOST_PATH, sandboxPath: SETTINGS_SANDBOX_PATH, readonly: true },
                ],
            }),
            // We don't checkout any PR's branch — the agent works from the inlined diffs in the prompt.
            // Use the first PR's repo as cwd just so sandcastle has a valid git workspace to point at.
            cwd: BAYWATCH_ROOT,
            promptFile: PROMPT_PATH,
            promptArgs: {
                PR_COUNT: String(prs.length),
                ISSUE_CONTEXT: issueContext,
                BUNDLE_BODY: renderBundleBody(prsWithDiffs),
                REVIEW_OUTPUT_PATH: reviewSandboxPath,
                SUBMIT_SCRIPT_PATH: submitSandboxPath,
            },
            branchStrategy: { type: "head" },
            name: `bundle-${slug}`,
        })

        console.log(`[review-bundle]   done: ${result.iterations.length} iteration(s)`)
        if (result.logFilePath) {
            console.log(`[review-bundle]   log:   ${result.logFilePath}`)
            console.log(`[review-bundle]   tail:  tail -f ${result.logFilePath}`)
        }

        if (existsSync(reviewHostPath)) {
            const markdown = readFileSync(reviewHostPath, "utf8")
            const verdict = parseVerdict(markdown)
            // Record one row per PR so the review queue shows the bundle outcome on each.
            for (const pr of prs) {
                recordReview({
                    ownerRepo: pr.repository.nameWithOwner,
                    prNumber: pr.number,
                    headSha: pr.headRefOid,
                    reviewedAt: Date.now(),
                    reviewPath: reviewHostPath,
                    verdict,
                })
            }
            console.log(
                `[review-bundle]   recorded ${prs.length} review(s); bundle verdict: ${verdict ?? "(unparsed)"}`
            )
        } else {
            console.warn(`[review-bundle]   no review markdown produced at ${reviewHostPath}`)
        }

        completeRun(runId, { status: "success", logPath: result.logFilePath ?? null })
    } catch (err) {
        completeRun(runId, { status: "failed", errorSummary: (err as Error).message })
        throw err
    }
}
