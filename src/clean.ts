import { existsSync, readdirSync, rmSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

const CLONES_ROOT = path.join(homedir(), ".baywatch", "clones")

export type CloneCandidate = {
    path: string
    name: string
    mtime: Date
    sizeBytes: number
    inUse: boolean
}

export type CleanOptions = {
    olderThanMs: number
    dryRun: boolean
}

// Parse e.g. "14d", "24h", "30m" → ms. Throws on invalid input.
export function parseDuration(input: string): number {
    const m = input.match(/^(\d+)\s*(s|m|h|d)$/)
    if (!m?.[1] || !m[2]) throw new Error(`bad duration "${input}" (expected e.g. 14d, 24h, 30m, 60s)`)
    const value = Number.parseInt(m[1], 10)
    const unit = m[2]
    const multiplier = unit === "s" ? 1_000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000
    return value * multiplier
}

function dirSize(dir: string): number {
    let total = 0
    let stack: string[] = [dir]
    while (stack.length > 0) {
        const next = stack.pop()
        if (!next) break
        const entries = readdirSync(next, { withFileTypes: true })
        const subdirs: string[] = []
        for (const entry of entries) {
            const full = path.join(next, entry.name)
            if (entry.isDirectory()) subdirs.push(full)
            else if (entry.isFile()) {
                try {
                    total += statSync(full).size
                } catch {
                    // skip files that disappeared mid-walk
                }
            }
        }
        stack = stack.concat(subdirs)
    }
    return total
}

// Filesystem-only scan of ~/.baywatch/clones/. Callers pass the set of clone
// paths currently in use (live sessions) so this stays a single-domain function
// — it never reaches into session state itself. A candidate is in-use if any
// live clone path equals it or lives inside it (nested per-session layout).
export function listCloneCandidates(opts: CleanOptions, inUsePaths: ReadonlySet<string>): CloneCandidate[] {
    if (!existsSync(CLONES_ROOT)) return []

    const cutoff = Date.now() - opts.olderThanMs
    const dirs = readdirSync(CLONES_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory())

    const out: CloneCandidate[] = []
    for (const d of dirs) {
        const full = path.join(CLONES_ROOT, d.name)
        const mtime = statSync(full).mtime
        if (mtime.getTime() > cutoff) continue
        const inUse = [...inUsePaths].some((p) => p === full || p.startsWith(`${full}${path.sep}`))
        out.push({
            path: full,
            name: d.name,
            mtime,
            sizeBytes: dirSize(full),
            inUse,
        })
    }
    return out.sort((a, b) => a.mtime.getTime() - b.mtime.getTime())
}

export function removeClone(c: CloneCandidate): void {
    rmSync(c.path, { recursive: true, force: true })
}

export function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`
}
