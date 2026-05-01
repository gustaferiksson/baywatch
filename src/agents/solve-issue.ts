import type { BaywatchConfig } from "../config.ts"
import type { DiscoveredIssue } from "../discovery.ts"
import { prepRepo } from "../prep.ts"

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

    // TODO(iter-2): wire @ai-hero/sandcastle:
    //   await sandcastle.run({
    //     agent: claudeCode(config.agent.model),
    //     sandbox: podman(),
    //     branchStrategy: "head",
    //     workdir: prep.repoPath,
    //     promptFile: "prompts/solve-issue.md",
    //     env: { ISSUE_NUMBER: String(issue.number), ISSUE_TITLE: issue.title, ISSUE_BODY: issue.body, ISSUE_URL: issue.url },
    //   })
    console.log("[dev]   (stub) sandcastle wiring not yet implemented — branch is prepped and waiting")
}
