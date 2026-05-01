import { existsSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

import { loadConfig } from "./config.ts"

export type LogEntry = {
    path: string
    name: string
    mtime: Date
    kind: "dev" | "review"
}

function readDirOrEmpty(dir: string): string[] {
    if (!existsSync(dir)) return []
    return readdirSync(dir)
}

function listLogsAt(logsDir: string, kind: LogEntry["kind"]): LogEntry[] {
    return readDirOrEmpty(logsDir)
        .filter((f) => f.endsWith(".log"))
        .map((f) => {
            const p = path.join(logsDir, f)
            return { path: p, name: f.replace(/\.log$/, ""), mtime: statSync(p).mtime, kind }
        })
}

// Find every sandcastle log file across the locations baywatch writes to:
// - dev runs:    ~/.baywatch/clones/*/.sandcastle/logs/*.log
// - review runs: <cloneRoot>/<repo>/.sandcastle/logs/*.log  (cwd is the main clone)
// Sorted newest first.
export async function listRecentLogs(): Promise<LogEntry[]> {
    const cfg = await loadConfig()
    const out: LogEntry[] = []

    const clonesRoot = path.join(homedir(), ".baywatch", "clones")
    for (const cloneDir of readDirOrEmpty(clonesRoot)) {
        out.push(...listLogsAt(path.join(clonesRoot, cloneDir, ".sandcastle", "logs"), "dev"))
    }

    for (const root of cfg.cloneRoots) {
        for (const repoDir of readDirOrEmpty(root)) {
            out.push(...listLogsAt(path.join(root, repoDir, ".sandcastle", "logs"), "review"))
        }
    }

    return out.sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
}

export function formatAge(d: Date): string {
    const sec = Math.floor((Date.now() - d.getTime()) / 1000)
    if (sec < 60) return `${sec}s ago`
    const min = Math.floor(sec / 60)
    if (min < 60) return `${min}m ago`
    const hr = Math.floor(min / 60)
    if (hr < 24) return `${hr}h ago`
    return `${Math.floor(hr / 24)}d ago`
}
