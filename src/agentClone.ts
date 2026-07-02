import { existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { $ } from "bun"

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
    // Where to place the clone. Defaults to the flat clones root; sessions pass
    // their per-session parent dir so N repos live under one identity mount.
    targetDir?: string
    // Continue an existing branch (already landed in the main clone) instead of
    // cutting a fresh one off origin/<default>.
    reuseBranch?: boolean
}): Promise<AgentClone> {
    const { ownerRepo, mainClonePath, branchName, defaultBranch, targetDir, reuseBranch } = opts
    const root = targetDir ?? CLONES_ROOT
    if (!existsSync(root)) mkdirSync(root, { recursive: true })

    const dirname = `${flat(ownerRepo)}--${branchName.replace(/\//g, "_")}--${shortId()}`
    const clonePath = path.join(root, dirname)

    console.log(`[clone] cloning ${mainClonePath} → ${clonePath}`)
    await $`git clone ${mainClonePath} ${clonePath}`.quiet()

    // Make sure origin/<default> in the new clone is fresh.
    await $`git -C ${clonePath} fetch origin --prune`.quiet()

    if (reuseBranch) {
        // The branch already exists in mainClonePath (landed by a prior session),
        // so the local clone carries it with its commits — just check it out.
        await $`git -C ${clonePath} checkout ${branchName}`.quiet()
    } else {
        // Cut the agent's branch from the latest origin/<default>.
        await $`git -C ${clonePath} checkout -B ${branchName} origin/${defaultBranch}`.quiet()
    }

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
    const ahead = (await $`git -C ${clone.path} rev-list --count origin/HEAD..${clone.branch}`.nothrow().quiet()).stdout
        .toString()
        .trim()
    if (ahead === "0") return { synced: false }

    await $`git -C ${clone.mainClonePath} fetch ${clone.path} ${clone.branch}:${clone.branch}`.quiet()
    return { synced: true }
}
