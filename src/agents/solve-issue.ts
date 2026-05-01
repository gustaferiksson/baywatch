import path from "node:path"
import { claudeCode, run } from "@ai-hero/sandcastle"
import { podman } from "@ai-hero/sandcastle/sandboxes/podman"

import { loadAgentEnv } from "../agentEnv.ts"
import { BAYWATCH_ROOT, type BaywatchConfig } from "../config.ts"
import type { DiscoveredIssue } from "../discovery.ts"
import { prepRepo } from "../prep.ts"

const SANDBOX_IMAGE = "baywatch-agent"
const PROMPT_PATH = path.join(BAYWATCH_ROOT, "prompts", "solve-issue.md")

function slugify(s: string): string {
    return s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 40)
}

export async function solveIssue(opts: {
    issue: DiscoveredIssue
    config: BaywatchConfig
    dryRun: boolean
}): Promise<void> {
    const { issue, config, dryRun } = opts
    const ownerRepo = issue.repository.nameWithOwner

    if (issue.linkedOpenPRs.length > 0) {
        const list = issue.linkedOpenPRs.map((pr) => `#${pr.number}`).join(", ")
        console.log(`[dev] ${ownerRepo}#${issue.number} — open linked PRs (${list}); skipping`)
        return
    }

    if (!issue.repoPath) {
        console.error(`[dev] no local clone for ${ownerRepo}; skipping issue #${issue.number}`)
        return
    }

    const branchName = `agent/issue-${issue.number}-${slugify(issue.title)}`
    console.log(`[dev] ${ownerRepo}#${issue.number} → branch ${branchName}`)

    if (dryRun) {
        console.log("[dev]   (dry-run) would prep repo and hand off to sandcastle")
        return
    }

    const prep = await prepRepo({ ownerRepo, branchName, config })
    console.log(`[dev]   prepped: ${prep.repoPath} on ${prep.branch} @ ${prep.baseSha.slice(0, 7)}`)

    const result = await run({
        agent: claudeCode(config.agent.model),
        sandbox: podman({ imageName: SANDBOX_IMAGE, selinuxLabel: false, env: loadAgentEnv() }),
        cwd: prep.repoPath,
        promptFile: PROMPT_PATH,
        promptArgs: {
            ISSUE_REPO: ownerRepo,
            ISSUE_NUMBER: String(issue.number),
            ISSUE_TITLE: issue.title,
            ISSUE_BODY: issue.body || "(empty)",
            ISSUE_URL: issue.url,
            BRANCH_NAME: prep.branch,
            DEFAULT_BRANCH: prep.defaultBranch,
        },
        branchStrategy: { type: "head" },
        name: `issue-${issue.number}`,
    })

    console.log(`[dev]   done: ${result.commits.length} commit(s) on ${result.branch}`)
    if (result.completionSignal) console.log(`[dev]   signal: ${result.completionSignal}`)
    if (result.logFilePath) console.log(`[dev]   log: ${result.logFilePath}`)
}
