import { existsSync } from "node:fs"
import path from "node:path"

export type RepoOverride = {
    defaultBranch?: string
    installCmd?: string
}

export type BaywatchConfig = {
    cloneRoots: string[]
    blocklist: string[]
    agent: { model: string }
    repoOverrides: Record<string, RepoOverride>
}

export async function loadConfig(): Promise<BaywatchConfig> {
    const cfgPath = path.resolve(process.cwd(), "baywatch.config.ts")
    if (!existsSync(cfgPath)) {
        throw new Error(
            `baywatch.config.ts not found at ${cfgPath}\n` +
                `Copy the template:\n  cp baywatch.config.example.ts baywatch.config.ts\n` +
                `then edit it to point at your local clone roots.`
        )
    }
    const mod = (await import(cfgPath)) as { default: BaywatchConfig }
    return mod.default
}
