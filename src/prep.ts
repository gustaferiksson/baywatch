import { existsSync } from "node:fs"
import path from "node:path"
import { $ } from "bun"

import type { BaywatchConfig } from "./config.ts"
import { assertWorkingTreeClean } from "./safety.ts"

export type PrepResult = {
    repoPath: string
    branch: string
    baseSha: string
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
    for (const root of cloneRoots) {
        const p = path.join(root, repoName)
        if (existsSync(path.join(p, ".git"))) return p
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

export async function prepRepo(opts: {
    ownerRepo: string
    branchName: string
    config: BaywatchConfig
}): Promise<PrepResult> {
    const { ownerRepo, branchName, config } = opts
    const repoPath = findRepoPath(ownerRepo, config.cloneRoots)
    if (!repoPath) {
        throw new Error(`No local clone found for ${ownerRepo} in any of: ${config.cloneRoots.join(", ")}`)
    }

    await assertWorkingTreeClean(repoPath)

    await $`git -C ${repoPath} fetch origin --prune`.quiet()

    const override = config.repoOverrides[ownerRepo]
    const defaultBranch = override?.defaultBranch ?? (await getOriginDefaultBranch(repoPath))

    await $`git -C ${repoPath} checkout -B ${branchName} origin/${defaultBranch}`.quiet()
    const baseSha = (await $`git -C ${repoPath} rev-parse HEAD`.text()).trim()

    const installCmd = override?.installCmd ?? detectInstallCmd(repoPath)
    if (installCmd) {
        console.log(`[prep] running install: ${installCmd}  (in ${repoPath})`)
        const proc = Bun.spawn(["sh", "-c", installCmd], {
            cwd: repoPath,
            stdout: "inherit",
            stderr: "inherit",
        })
        const code = await proc.exited
        if (code !== 0) throw new Error(`install failed (exit ${code}): ${installCmd}`)
    }

    return { repoPath, branch: branchName, baseSha }
}
