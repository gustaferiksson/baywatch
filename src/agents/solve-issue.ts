import { promises as fs } from "node:fs"
import path from "node:path"
import { claudeCode, hostSessionStore, run, transferSession } from "@ai-hero/sandcastle"
import { podman } from "@ai-hero/sandcastle/sandboxes/podman"

import { createAgentClone, pushBranchToMain } from "../agentClone.ts"
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
        console.log("[dev]   (dry-run) would prep + clone + hand off to sandcastle")
        return
    }

    const prep = await prepRepo({ ownerRepo, config })
    console.log(`[dev]   default branch: ${prep.defaultBranch}`)

    const clone = await createAgentClone({
        ownerRepo,
        mainClonePath: prep.repoPath,
        branchName,
        defaultBranch: prep.defaultBranch,
    })
    console.log(`[dev]   agent clone ready at ${clone.path}`)

    const hooks = prep.installCmd ? { sandbox: { onSandboxReady: [{ command: prep.installCmd }] } } : undefined

    const result = await run({
        agent: claudeCode(config.agent.model),
        sandbox: podman({ imageName: SANDBOX_IMAGE, selinuxLabel: false, env: loadAgentEnv() }),
        cwd: clone.path,
        promptFile: PROMPT_PATH,
        promptArgs: {
            ISSUE_REPO: ownerRepo,
            ISSUE_NUMBER: String(issue.number),
            ISSUE_TITLE: issue.title,
            ISSUE_BODY: issue.body || "(empty)",
            ISSUE_URL: issue.url,
            BRANCH_NAME: branchName,
            DEFAULT_BRANCH: prep.defaultBranch,
        },
        branchStrategy: { type: "head" },
        ...(hooks ? { hooks } : {}),
        name: `issue-${issue.number}`,
    })

    console.log(`[dev]   done: ${result.commits.length} commit(s) on ${result.branch}`)
    if (result.completionSignal) console.log(`[dev]   signal: ${result.completionSignal}`)
    if (result.logFilePath) {
        console.log(`[dev]   log:   ${result.logFilePath}`)
        console.log(`[dev]   tail:  tail -f ${result.logFilePath}`)
    }

    await migrateSessionToMainClone({ result, clone })

    if (result.commits.length > 0) {
        await pushBranchToMain(clone)
        console.log(`[dev]   branch ${clone.branch} fetched into ${clone.mainClonePath}`)
        console.log(
            `[dev]   inspect:  cd ${clone.path}   (or)   git -C ${clone.mainClonePath} checkout ${clone.branch}`
        )
    } else {
        console.log(`[dev]   no commits — agent clone left at ${clone.path} for inspection`)
    }
}

// Move the claude-code session JSONL from `~/.claude/projects/<encoded(agent-clone)>/`
// to `~/.claude/projects/<encoded(main-clone)>/` and rewrite `cwd` fields, so the
// session shows up under the main project (e.g. tokens) in claude-code's history
// and in tooling that indexes by project path.
async function migrateSessionToMainClone(opts: {
    result: { iterations: { sessionId?: string }[] }
    clone: { path: string; mainClonePath: string }
}): Promise<void> {
    const { result, clone } = opts
    const sessionId = result.iterations[0]?.sessionId
    if (!sessionId) {
        console.warn("[dev]   no sessionId returned — skipping session migration")
        return
    }
    const source = hostSessionStore(clone.path)
    const target = hostSessionStore(clone.mainClonePath)
    await transferSession(source, target, sessionId)
    console.log(`[dev]   session migrated → ${target.sessionFilePath(sessionId)}`)

    // Remove the source JSONL (and its now-empty project dir) so ~/.claude/projects/
    // doesn't accumulate entries for short-lived agent clones.
    const sourcePath = source.sessionFilePath(sessionId)
    await fs.unlink(sourcePath)
    const sourceDir = path.dirname(sourcePath)
    const remaining = await fs.readdir(sourceDir)
    if (remaining.length === 0) await fs.rmdir(sourceDir)
}
