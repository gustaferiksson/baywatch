import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

export type RepoOverride = {
    defaultBranch?: string
    installCmd?: string
}

export type BaywatchConfig = {
    cloneRoots: string[]
    blocklist: string[]
    agent: {
        model: string
        // Enable Claude Code's remote-control mode for spawned agents so you can monitor
        // running sessions at claude.ai/code from any device. Defaults to true.
        remoteControl?: boolean
    }
    repoOverrides: Record<string, RepoOverride>
}

// Baywatch root is the directory containing this src/ folder. Resolve once at module load.
// `import.meta.url` here is `.../baywatch/src/config.ts` — go up two levels to the repo root.
export const BAYWATCH_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

// Bun auto-loads `.env` from cwd, but `baywatch` should work from anywhere — load
// baywatch's own .env explicitly. Existing process env wins (so a test/CI can override).
// Side-effect at module load: every cli/agent call funnels through this module.
loadEnvFile(path.join(BAYWATCH_ROOT, ".env"))

function loadEnvFile(filePath: string): void {
    if (!existsSync(filePath)) return
    for (const rawLine of readFileSync(filePath, "utf8").split("\n")) {
        const line = rawLine.trim()
        if (!line || line.startsWith("#")) continue
        const eq = line.indexOf("=")
        if (eq <= 0) continue
        const key = line.slice(0, eq).trim()
        if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) continue
        if (process.env[key] !== undefined) continue
        let value = line.slice(eq + 1).trim()
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1)
        }
        process.env[key] = value
    }
}

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
