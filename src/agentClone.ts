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
//
// If the agent branch has no commits beyond `origin/HEAD` (i.e. the agent
// didn't actually commit anything), skip the fetch — there's no value in
// littering the main clone with dead refs pointing at the default branch.
// Returns whether a sync actually happened so callers can log appropriately.
export async function pushBranchToMain(clone: AgentClone): Promise<{ synced: boolean }> {
    const ahead = (
        await $`git -C ${clone.path} rev-list --count origin/HEAD..${clone.branch}`.nothrow().quiet()
    ).stdout
        .toString()
        .trim()
    if (ahead === "0") return { synced: false }

    await $`git -C ${clone.mainClonePath} fetch ${clone.path} ${clone.branch}:${clone.branch}`.quiet()
    return { synced: true }
}

// Clone the repo from GitHub (so `gh` tooling has a real github.com remote to work
// with) and check out the PR's head branch via `gh pr checkout`. Uses
// `git clone --reference <main>` under the hood so we share object storage with the
// user's main clone and avoid re-downloading megabytes of history. The user's main
// clone stays untouched.
export async function createReviewClone(opts: {
    ownerRepo: string
    mainClonePath: string
    prNumber: number
}): Promise<AgentClone> {
    const { ownerRepo, mainClonePath, prNumber } = opts
    if (!existsSync(CLONES_ROOT)) mkdirSync(CLONES_ROOT, { recursive: true })

    const dirname = `review-${flat(ownerRepo)}--${prNumber}--${shortId()}`
    const clonePath = path.join(CLONES_ROOT, dirname)

    console.log(`[review-clone] gh repo clone ${ownerRepo} → ${clonePath} (reference: ${mainClonePath})`)
    const cloneProc = Bun.spawn(
        ["gh", "repo", "clone", ownerRepo, clonePath, "--", "--reference", mainClonePath, "--dissociate"],
        { env: hostGhEnv(), stdout: "inherit", stderr: "inherit" }
    )
    const cloneCode = await cloneProc.exited
    if (cloneCode !== 0) throw new Error(`gh repo clone ${ownerRepo} failed (exit ${cloneCode})`)

    console.log(`[review-clone] gh pr checkout ${ownerRepo}#${prNumber}`)
    const checkoutProc = Bun.spawn(["gh", "pr", "checkout", String(prNumber), "--repo", ownerRepo], {
        cwd: clonePath,
        env: hostGhEnv(),
        stdout: "inherit",
        stderr: "inherit",
    })
    const checkoutCode = await checkoutProc.exited
    if (checkoutCode !== 0) throw new Error(`gh pr checkout ${ownerRepo}#${prNumber} failed (exit ${checkoutCode})`)

    const branch = (await $`git -C ${clonePath} rev-parse --abbrev-ref HEAD`.text()).trim()
    return { path: clonePath, mainClonePath, branch }
}
