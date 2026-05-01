import { existsSync, mkdirSync } from "node:fs"
import path from "node:path"
import { claudeCode, run } from "@ai-hero/sandcastle"
import { podman } from "@ai-hero/sandcastle/sandboxes/podman"
import { $ } from "bun"

import { loadAgentEnv } from "../agentEnv.ts"
import { BAYWATCH_ROOT, type BaywatchConfig } from "../config.ts"
import type { DiscoveredPR } from "../discovery.ts"
import { readNote } from "../notes.ts"
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
    if (!pr.repoPath) {
        console.error(`[review] no local clone for ${ownerRepo}; skipping PR #${pr.number}`)
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
    // from the prompt rather than calling gh inside the container.
    const diff = await $`gh pr diff ${pr.number} --repo ${ownerRepo}`.text()

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
            cwd: pr.repoPath,
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
            name: `review-${pr.number}`,
        })

        console.log(`[review]   done: ${result.iterations.length} iteration(s)`)
        if (result.logFilePath) {
            console.log(`[review]   log:   ${result.logFilePath}`)
            console.log(`[review]   tail:  tail -f ${result.logFilePath}`)
        }

        if (existsSync(reviewHostPath)) {
            recordReview({
                ownerRepo,
                prNumber: pr.number,
                headSha: pr.headRefOid,
                reviewedAt: Date.now(),
                reviewPath: reviewHostPath,
            })
            console.log(`[review]   recorded at head ${pr.headRefOid.slice(0, 7)}`)
        } else {
            console.warn(`[review]   no review markdown produced at ${reviewHostPath}`)
        }

        completeRun(runId, { status: "success", logPath: result.logFilePath ?? null })
    } catch (err) {
        completeRun(runId, { status: "failed", errorSummary: (err as Error).message })
        throw err
    }
}
