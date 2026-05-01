import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

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

// Baywatch root is the directory containing this src/ folder. Resolve once at module load.
// `import.meta.url` here is `.../baywatch/src/config.ts` — go up two levels to the repo root.
export const BAYWATCH_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

export async function loadConfig(): Promise<BaywatchConfig> {
    // Look for baywatch.config.ts next to the install (so `baywatch` works from anywhere).
    // Fall back to cwd for the older ergonomics (`bun baywatch ...` from the repo dir).
    const candidates = [
        path.join(BAYWATCH_ROOT, "baywatch.config.ts"),
        path.resolve(process.cwd(), "baywatch.config.ts"),
    ]
    const cfgPath = candidates.find((p) => existsSync(p))
    if (!cfgPath) {
        throw new Error(
            `baywatch.config.ts not found in any of:\n  ${candidates.join("\n  ")}\n` +
                `Copy the template:\n  cp ${path.join(BAYWATCH_ROOT, "baywatch.config.example.ts")} ${path.join(BAYWATCH_ROOT, "baywatch.config.ts")}\n` +
                `then edit it to point at your local clone roots.`
        )
    }
    const mod = (await import(cfgPath)) as { default: BaywatchConfig }
    return mod.default
}
