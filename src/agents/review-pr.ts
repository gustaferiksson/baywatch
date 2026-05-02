import { existsSync, mkdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { claudeCode, run } from "@ai-hero/sandcastle"
import { podman } from "@ai-hero/sandcastle/sandboxes/podman"

import { loadAgentEnv } from "../agentEnv.ts"
import { BAYWATCH_ROOT, type BaywatchConfig } from "../config.ts"
import type { DiscoveredPR } from "../discovery.ts"
import { readNote } from "../notes.ts"
import { parseVerdict } from "../reviewVerdict.ts"
import { completeRun, recordReview, startRun } from "../state.ts"

const SANDBOX_IMAGE = "baywatch-agent"
const PROMPT_PATH = path.join(BAYWATCH_ROOT, "prompts", "review-pr.md")
const REVIEWS_HOST_DIR = path.join(BAYWATCH_ROOT, "reviews")
const REVIEWS_SANDBOX_DIR = "/baywatch-reviews"
const SETTINGS_HOST_PATH = path.join(BAYWATCH_ROOT, ".claude", "settings.json")
const SETTINGS_SANDBOX_PATH = "/home/agent/.claude/settings.json"

export async function reviewPR(opts: { pr: DiscoveredPR; config: BaywatchConfig; dryRun: boolean }): Promise<void> {
    const { pr, config, dryRun } = opts
    const ownerRepo = pr.repository.nameWithOwner

    if (pr.alreadyReviewedAtThisHead) {
        console.log(`[review] ${ownerRepo}#${pr.number} — already reviewed at ${pr.headRefOid.slice(0, 7)}, skipping`)
        return
    }

    if (!existsSync(REVIEWS_HOST_DIR)) mkdirSync(REVIEWS_HOST_DIR, { recursive: true })

    const flatRepo = ownerRepo.replace("/", "__")
    const reviewFilename = `${flatRepo}__${pr.number}.md`
    const submitScriptFilename = `${flatRepo}__${pr.number}__submit-review.sh`
    const reviewHostPath = path.join(REVIEWS_HOST_DIR, reviewFilename)
    const reviewSandboxPath = `${REVIEWS_SANDBOX_DIR}/${reviewFilename}`
    const submitSandboxPath = `${REVIEWS_SANDBOX_DIR}/${submitScriptFilename}`

    console.log(
        `[review] ${ownerRepo}#${pr.number} (${pr.reasonForReview}) → ${path.relative(process.cwd(), reviewHostPath)}`
    )

    if (dryRun) {
        console.log(`[review]   (dry-run) would run sandcastle review and write ${reviewHostPath}`)
        return
    }

    // Pre-fetch the diff on the host. The sandbox has no gh auth, so the agent reads it
    // from the prompt rather than calling gh inside the container. Scrub GITHUB_TOKEN
    // from the host call so we use the user's `gh auth login` (broader scope) rather
    // than the read-only PAT we ship into the agent.
    const ghEnv: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && k !== "GITHUB_TOKEN" && k !== "GH_TOKEN") ghEnv[k] = v
    }
    const ghProc = Bun.spawn(["gh", "pr", "diff", String(pr.number), "--repo", ownerRepo], {
        env: ghEnv,
        stdout: "pipe",
        stderr: "pipe",
    })
    const diff = await new Response(ghProc.stdout).text()
    if ((await ghProc.exited) !== 0) {
        throw new Error(`gh pr diff ${ownerRepo}#${pr.number} failed`)
    }

    const runId = startRun({
        kind: "review",
        ownerRepo,
        target: `pr-${pr.number}`,
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
            // Review reads the diff from the prompt — no need for the agent to be on the
            // PR's branch (or any specific branch). Use BAYWATCH_ROOT so reviews don't
            // depend on whatever the user has checked out in their main clone.
            cwd: BAYWATCH_ROOT,
            promptFile: PROMPT_PATH,
            promptArgs: {
                PR_REPO: ownerRepo,
                PR_NUMBER: String(pr.number),
                PR_TITLE: pr.title,
                PR_BODY: pr.body || "(empty)",
                PR_URL: pr.url,
                PR_HEAD_REF: pr.headRefName,
                PR_BASE_REF: pr.baseRefName,
                PR_HEAD_OID: pr.headRefOid,
                PR_DIFF: diff,
                REVIEW_OUTPUT_PATH: reviewSandboxPath,
                SUBMIT_SCRIPT_PATH: submitSandboxPath,
                ADDITIONAL_NOTES: readNote(`${ownerRepo}#${pr.number}`) ?? "(none — review from the diff alone)",
            },
            branchStrategy: { type: "head" },
            name: `review-${ownerRepo.replace("/", "-")}-${pr.number}`,
        })

        console.log(`[review]   done: ${result.iterations.length} iteration(s)`)
        if (result.logFilePath) {
            console.log(`[review]   log:   ${result.logFilePath}`)
            console.log(`[review]   tail:  tail -f ${result.logFilePath}`)
        }

        if (existsSync(reviewHostPath)) {
            const markdown = readFileSync(reviewHostPath, "utf8")
            const verdict = parseVerdict(markdown)
            recordReview({
                ownerRepo,
                prNumber: pr.number,
                headSha: pr.headRefOid,
                reviewedAt: Date.now(),
                reviewPath: reviewHostPath,
                verdict,
            })
            console.log(`[review]   recorded at head ${pr.headRefOid.slice(0, 7)}, verdict: ${verdict ?? "(unparsed)"}`)
        } else {
            console.warn(`[review]   no review markdown produced at ${reviewHostPath}`)
        }

        completeRun(runId, { status: "success", logPath: result.logFilePath ?? null })
    } catch (err) {
        completeRun(runId, { status: "failed", errorSummary: (err as Error).message })
        throw err
    }
}
