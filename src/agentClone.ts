import { existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { $ } from "bun"

import { hostGhEnv } from "./gh.ts"

const CLONES_ROOT = path.join(homedir(), ".baywatch", "clones")

export type AgentClone = {
    path: string
    mainClonePath: string
    branch: string
}

function shortId(): string {
    return Math.random().toString(36).slice(2, 8)
}

function flat(ownerRepo: string): string {
    return ownerRepo.replace("/", "--")
}

// Create a fresh clone of the user's main checkout, on a new branch cut from
// `origin/<defaultBranch>`. The clone uses git's local-clone optimization
// (hardlinked objects via `git clone <local-path>`), so it's cheap on disk.
//
// The agent operates here; the user's main clone is never touched. After the
// agent finishes, call `pushBranchToMain` to fetch the branch ref back to main.
export async function createAgentClone(opts: {
    ownerRepo: string
    mainClonePath: string
    branchName: string
    defaultBranch: string
}): Promise<AgentClone> {
    const { ownerRepo, mainClonePath, branchName, defaultBranch } = opts
    if (!existsSync(CLONES_ROOT)) mkdirSync(CLONES_ROOT, { recursive: true })

    const dirname = `${flat(ownerRepo)}--${branchName.replace(/\//g, "_")}--${shortId()}`
    const clonePath = path.join(CLONES_ROOT, dirname)

    console.log(`[clone] cloning ${mainClonePath} → ${clonePath}`)
    await $`git clone ${mainClonePath} ${clonePath}`.quiet()

    // Make sure origin/<default> in the new clone is fresh.
    await $`git -C ${clonePath} fetch origin --prune`.quiet()

    // Cut the agent's branch from the latest origin/<default>.
    await $`git -C ${clonePath} checkout -B ${branchName} origin/${defaultBranch}`.quiet()

    return { path: clonePath, mainClonePath, branch: branchName }
}

// Bring the agent's branch ref into the user's main clone after the run, so they can
// `git checkout <branch>` there with no working-tree conflict.
export async function pushBranchToMain(clone: AgentClone): Promise<void> {
    await $`git -C ${clone.mainClonePath} fetch ${clone.path} ${clone.branch}:${clone.branch}`.quiet()
}

// Clone the user's main checkout and check out the PR's head branch in the new clone
// via `gh pr checkout` (handles same-repo + fork PRs). The agent reviews the PR with
// real working files available, while the user's main clone stays untouched.
export async function createReviewClone(opts: {
    ownerRepo: string
    mainClonePath: string
    prNumber: number
}): Promise<AgentClone> {
    const { ownerRepo, mainClonePath, prNumber } = opts
    if (!existsSync(CLONES_ROOT)) mkdirSync(CLONES_ROOT, { recursive: true })

    const dirname = `review-${flat(ownerRepo)}--${prNumber}--${shortId()}`
    const clonePath = path.join(CLONES_ROOT, dirname)

    console.log(`[review-clone] cloning ${mainClonePath} → ${clonePath}`)
    await $`git clone ${mainClonePath} ${clonePath}`.quiet()

    console.log(`[review-clone] gh pr checkout ${ownerRepo}#${prNumber}`)
    const proc = Bun.spawn(["gh", "pr", "checkout", String(prNumber), "--repo", ownerRepo], {
        cwd: clonePath,
        env: hostGhEnv(),
        stdout: "inherit",
        stderr: "inherit",
    })
    const code = await proc.exited
    if (code !== 0) throw new Error(`gh pr checkout ${ownerRepo}#${prNumber} failed (exit ${code})`)

    const branch = (await $`git -C ${clonePath} rev-parse --abbrev-ref HEAD`.text()).trim()
    return { path: clonePath, mainClonePath, branch }
}
