import { $ } from "bun"

export async function assertWorkingTreeClean(repoPath: string): Promise<void> {
    const status = (await $`git -C ${repoPath} status --porcelain`.text()).trim()
    if (status.length > 0) {
        throw new Error(`Refusing to run: working tree at ${repoPath} is not clean.\n${status}`)
    }
}

export async function getCurrentBranch(repoPath: string): Promise<string> {
    return (await $`git -C ${repoPath} rev-parse --abbrev-ref HEAD`.text()).trim()
}
