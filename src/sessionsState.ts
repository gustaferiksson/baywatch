import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { $ } from "bun"

export const SESSIONS_ROOT = path.join(homedir(), ".baywatch", "sessions")

export type SessionState =
    | "starting"
    | "working"
    | "awaiting-input"
    | "idle"
    | "done"
    | "failed"
    | "stopped"

// One repo within a session's sandbox: an isolated clone on its own branch,
// plus the user's real checkout to fetch the branch back into on session end.
export type SessionRepo = {
    ownerRepo: string
    branch: string
    clonePath: string
    mainClonePath: string
}

export type SessionMeta = {
    id: string
    // The Task this session is a run of. Multiple sessions can share a Task
    // (same repos + branches) across days — see tasksState.ts.
    taskId: string
    name: string
    repos: SessionRepo[]
    containerName: string
    containerId: string
    startedAt: number
    rcEnvironmentUrl: string | null
    /// Path to a symlink we drop into the main clone's `~/.claude/projects/`
    /// dir pointing at this session's transcript JSONL, so `claude --resume`
    /// from the user's normal checkout lists the baywatch session. Optional —
    /// older sessions and sessions where the transcript never appeared lack it.
    resumeLinkPath?: string
}

export type SessionRow = SessionMeta & {
    state: SessionState
    lastEventAt: number
}

type HookEvent = { ts: number; event: string }

function readMeta(id: string): SessionMeta | null {
    const p = path.join(SESSIONS_ROOT, id, "meta.json")
    if (!existsSync(p)) return null
    try {
        const meta = JSON.parse(readFileSync(p, "utf8")) as SessionMeta
        // Age out pre-multi-repo sessions (singular repo/branch, no repos[])
        // instead of crashing readers that expect the array.
        if (!Array.isArray(meta.repos)) return null
        return meta
    } catch {
        return null
    }
}

function readEvents(id: string): HookEvent[] {
    const p = path.join(SESSIONS_ROOT, id, "status.jsonl")
    if (!existsSync(p)) return []
    const events: HookEvent[] = []
    for (const line of readFileSync(p, "utf8").split("\n")) {
        if (!line.trim()) continue
        try {
            events.push(JSON.parse(line) as HookEvent)
        } catch {
            // skip malformed line — hooks may race with reads
        }
    }
    return events
}

// Returns the short IDs of currently-running baywatch session containers.
async function liveContainerIds(): Promise<Set<string>> {
    const result = await $`podman ps -q --filter name=baywatch-session-`.nothrow().quiet()
    if (result.exitCode !== 0) return new Set()
    return new Set(
        result.stdout
            .toString()
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean)
    )
}

function deriveState(events: HookEvent[], containerAlive: boolean): SessionState {
    if (!containerAlive) {
        if (events.length === 0) return "stopped"
        const last = events.at(-1)
        if (last?.event === "SessionEnd") return "done"
        return "stopped"
    }
    if (events.length === 0) return "starting"
    const last = events.at(-1)
    if (last?.event === "Notification") return "awaiting-input"
    if (last?.event === "Stop") return "idle"
    return "working"
}

export async function listSessions(): Promise<SessionRow[]> {
    if (!existsSync(SESSIONS_ROOT)) return []

    const ids = readdirSync(SESSIONS_ROOT).filter((entry) => {
        try {
            return statSync(path.join(SESSIONS_ROOT, entry)).isDirectory()
        } catch {
            return false
        }
    })

    const live = await liveContainerIds()
    const rows: SessionRow[] = []
    for (const id of ids) {
        const meta = readMeta(id)
        if (!meta) continue
        const events = readEvents(id)
        // `podman ps -q` returns short ids (12 chars); meta.containerId is full.
        const alive = [...live].some((short) => meta.containerId.startsWith(short))
        rows.push({
            ...meta,
            state: deriveState(events, alive),
            lastEventAt: events.at(-1)?.ts ?? meta.startedAt,
        })
    }
    return rows
}

export async function findSession(idOrName: string): Promise<SessionRow | null> {
    const sessions = await listSessions()
    return sessions.find((s) => s.id === idOrName || s.name === idOrName) ?? null
}
