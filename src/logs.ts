import { listRuns, type RunRecord } from "./state.ts"

export type LogEntry = {
    runId: number
    kind: RunRecord["kind"]
    status: RunRecord["status"]
    target: string
    ownerRepo: string
    branch: string | null
    startedAt: Date
    finishedAt: Date | null
    logPath: string | null
    errorSummary: string | null
}

export function listRecentLogs(opts: { limit?: number; status?: RunRecord["status"] } = {}): LogEntry[] {
    return listRuns(opts).map((r) => ({
        runId: r.id,
        kind: r.kind,
        status: r.status,
        target: r.target,
        ownerRepo: r.ownerRepo,
        branch: r.branch,
        startedAt: new Date(r.startedAt),
        finishedAt: r.finishedAt ? new Date(r.finishedAt) : null,
        logPath: r.logPath,
        errorSummary: r.errorSummary,
    }))
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

export function formatDuration(start: Date, end: Date | null): string {
    const ms = (end ?? new Date()).getTime() - start.getTime()
    const sec = Math.floor(ms / 1000)
    if (sec < 60) return `${sec}s`
    const min = Math.floor(sec / 60)
    const remSec = sec % 60
    if (min < 60) return `${min}m${remSec.toString().padStart(2, "0")}s`
    const hr = Math.floor(min / 60)
    const remMin = min % 60
    return `${hr}h${remMin.toString().padStart(2, "0")}m`
}
