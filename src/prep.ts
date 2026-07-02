import { appendFileSync, type Dirent, existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { $ } from "bun"

import type { BaywatchConfig } from "./config.ts"

export type PrepResult = {
    repoPath: string
    defaultBranch: string
    installCmd: string | null
}

function detectInstallCmd(repoPath: string): string | null {
    if (existsSync(path.join(repoPath, "bun.lock")) || existsSync(path.join(repoPath, "bun.lockb"))) {
        return "bun install --frozen-lockfile"
    }
    if (existsSync(path.join(repoPath, "pnpm-lock.yaml"))) return "pnpm install --frozen-lockfile"
    if (existsSync(path.join(repoPath, "yarn.lock"))) return "yarn install --frozen-lockfile"
    if (existsSync(path.join(repoPath, "package-lock.json"))) return "npm ci"
    return null
}

export function findRepoPath(ownerRepo: string, cloneRoots: string[]): string | null {
    const repoName = ownerRepo.split("/")[1]
    if (!repoName) return null
    // Fast path: a repo directly under a clone root.
    for (const root of cloneRoots) {
        const p = path.join(root, repoName)
        if (existsSync(path.join(p, ".git"))) return p
    }
    // Fallback: repos grouped in a subfolder (e.g. <root>/vscode-extensions/<repo>).
    // Search a few levels down, skipping dotdirs / node_modules and not descending
    // into git repos themselves.
    for (const root of cloneRoots) {
        const found = searchForRepo(root, repoName, 3)
        if (found) return found
    }
    return null
}

function searchForRepo(dir: string, repoName: string, depth: number): string | null {
    if (depth < 0 || !existsSync(dir)) return null
    let entries: Dirent[]
    try {
        entries = readdirSync(dir, { withFileTypes: true })
    } catch {
        return null
    }
    const subdirs: string[] = []
    for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue
        const full = path.join(dir, entry.name)
        const isRepo = existsSync(path.join(full, ".git"))
        if (entry.name === repoName && isRepo) return full
        if (!isRepo) subdirs.push(full)
    }
    for (const sub of subdirs) {
        const found = searchForRepo(sub, repoName, depth - 1)
        if (found) return found
    }
    return null
}

async function getOriginDefaultBranch(repoPath: string): Promise<string> {
    try {
        const out = await $`git -C ${repoPath} symbolic-ref refs/remotes/origin/HEAD`.text()
        return out.trim().replace(/^refs\/remotes\/origin\//, "")
    } catch {
        const out = await $`git -C ${repoPath} remote show origin`.text()
        const m = out.match(/HEAD branch:\s*(\S+)/)
        if (!m?.[1]) throw new Error(`Could not determine default branch for ${repoPath}`)
        return m[1]
    }
}

// Gather everything the agent run needs to know about a target repo. Does NOT
// touch the user's main checkout — no branch creation, no install on host.
// Sandcastle's worktree + onSandboxReady install hook handles all of that.
export async function prepRepo(opts: { ownerRepo: string; config: BaywatchConfig }): Promise<PrepResult> {
    const { ownerRepo, config } = opts
    const repoPath = findRepoPath(ownerRepo, config.cloneRoots)
    if (!repoPath) {
        throw new Error(`No local clone found for ${ownerRepo} in any of: ${config.cloneRoots.join(", ")}`)
    }

    // Refresh origin so the worktree's baseBranch (origin/<default>) is current.
    await $`git -C ${repoPath} fetch origin --prune`.quiet()

    const override = config.repoOverrides[ownerRepo]
    const defaultBranch = override?.defaultBranch ?? (await getOriginDefaultBranch(repoPath))
    const installCmd = override?.installCmd ?? detectInstallCmd(repoPath)

    excludeSandcastleLocally(repoPath)

    return { repoPath, defaultBranch, installCmd }
}

// Add `.sandcastle/` to the repo's local-only ignore (`.git/info/exclude`) so
// sandcastle's worktrees + logs don't appear as untracked changes. Per-clone,
// never committed.
function excludeSandcastleLocally(repoPath: string): void {
    const excludePath = path.join(repoPath, ".git", "info", "exclude")
    if (!existsSync(excludePath)) return
    const current = readFileSync(excludePath, "utf8")
    if (current.split("\n").some((line) => line.trim() === ".sandcastle/")) return
    appendFileSync(excludePath, current.endsWith("\n") ? ".sandcastle/\n" : "\n.sandcastle/\n")
}
