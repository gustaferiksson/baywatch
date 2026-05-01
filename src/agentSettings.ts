import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import path from "node:path"

import { BAYWATCH_ROOT, type BaywatchConfig } from "./config.ts"

const BAYWATCH_SETTINGS = path.join(BAYWATCH_ROOT, ".claude", "settings.json")

// Build the settings.json a spawned agent will read. Starts from baywatch's own
// .claude/settings.json (the deny list source of truth) and overlays the model +
// remoteControlAtStartup flag from the live config.
function buildSettings(config: BaywatchConfig): string {
    const base = JSON.parse(readFileSync(BAYWATCH_SETTINGS, "utf8")) as Record<string, unknown>
    const merged = {
        ...base,
        model: config.agent.model,
        remoteControlAtStartup: config.agent.remoteControl ?? true,
    }
    return `${JSON.stringify(merged, null, 2)}\n`
}

// Write a baywatch-derived settings file into a target dir.
// - asLocalOverride=false: writes <dir>/.claude/settings.json (used for fresh agent clones)
// - asLocalOverride=true:  writes <dir>/.claude/settings.local.json and refuses to overwrite
//                          if it already exists (used for the user's main clone in review runs)
export function writeAgentSettings(opts: {
    targetDir: string
    config: BaywatchConfig
    asLocalOverride: boolean
}): string {
    const claudeDir = path.join(opts.targetDir, ".claude")
    mkdirSync(claudeDir, { recursive: true })

    const filename = opts.asLocalOverride ? "settings.local.json" : "settings.json"
    const target = path.join(claudeDir, filename)

    if (opts.asLocalOverride && existsSync(target)) {
        throw new Error(
            `refusing to overwrite existing ${target} — remove it manually if you're sure baywatch can use it`
        )
    }

    writeFileSync(target, buildSettings(opts.config))

    if (opts.asLocalOverride) ensureGitExclude(opts.targetDir, ".claude/settings.local.json")

    return target
}

export function removeAgentSettings(filePath: string): void {
    if (existsSync(filePath)) unlinkSync(filePath)
}

function ensureGitExclude(repoPath: string, pattern: string): void {
    const excludePath = path.join(repoPath, ".git", "info", "exclude")
    if (!existsSync(excludePath)) return
    const current = readFileSync(excludePath, "utf8")
    if (current.split("\n").some((line) => line.trim() === pattern)) return
    appendFileSync(excludePath, current.endsWith("\n") ? `${pattern}\n` : `\n${pattern}\n`)
}
